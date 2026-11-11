import Foundation
import SwiftUI
import UIKit

/// Everything about the host being driven: the connection and its retries, the
/// profile, the session list, and the terminal and browser for each session.
///
/// It follows the desktop's rule that the presentation belongs to the host:
/// until the profile has actually been read there is no workspace — only a
/// connect screen — so a layout the app made up can never be saved over the
/// real one.
@MainActor
final class Workspace: ObservableObject {
    enum Phase: Equatable {
        case noHost
        /// Trying to reach the host. `retryAt` is when the next attempt runs.
        case connecting(attempt: Int, lastError: String?, retryAt: Date?)
        case ready
    }

    @Published private(set) var phase: Phase = .noHost
    @Published private(set) var host: HostEntry?
    @Published private(set) var profileName = "default"
    @Published private(set) var profile: Profile?
    @Published private(set) var profiles: [String] = []
    @Published private(set) var sessions: [SessionInfo] = []
    @Published private(set) var mouseMode: Bool?
    /// Each session's screen as text, while previews are on.
    @Published private(set) var previews: [String: String] = [:]
    @Published var showPreviews = UserDefaults.standard.bool(forKey: "showPreviews") {
        didSet {
            UserDefaults.standard.set(showPreviews, forKey: "showPreviews")
            if showPreviews { Task { await refreshPreviews() } } else { previews = [:] }
        }
    }
    @Published private(set) var forwards = PortForwarder.Status()
    /// Set while connected and the link drops; the workspace stays on screen.
    @Published private(set) var linkDown: String?
    @Published var banner: String?
    /// The open session, if any — the navigation stack's path.
    @Published var navPath: [String] = []

    let hosts: HostStore
    private(set) var connection: SSHConnection?
    private var connectTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private var saveChain: Task<Void, Never>?
    private let forwarder = PortForwarder()
    private var terminals: [String: TerminalController] = [:]
    private var browsers: [String: BrowserController] = [:]
    private var attempt = 0

    init(hosts: HostStore) {
        self.hosts = hosts
    }

    // MARK: Connecting

    /// Point the workspace at the store's active host, dropping whatever was up.
    func start() {
        teardown()
        guard let h = hosts.activeHost, h.isConfigured else {
            host = hosts.activeHost
            phase = .noHost
            return
        }
        host = h
        profileName = h.activeProfile
        profile = nil
        attempt = 0
        connectLoop()
    }

    func switchHost(_ id: String) {
        guard id != host?.id else { return }
        hosts.activeHostID = id
        start()
    }

    /// Jump the retry queue — the Retry button, the app returning to the foreground.
    func retryNow() {
        guard host != nil else { start(); return }
        if case .connecting = phase { connectLoop() } else if connection == nil || linkDown != nil { reconnect() }
    }

    private func teardown() {
        connectTask?.cancel(); connectTask = nil
        pollTask?.cancel(); pollTask = nil
        terminals.values.forEach { $0.detach() }
        terminals = [:]
        browsers = [:]
        navPath = []
        sessions = []
        mouseMode = nil
        linkDown = nil
        let f = forwarder
        Task { await f.stop() }
        forwards = .init()
        connection?.close()
        connection = nil
    }

    /// Retries 1s, 2s, 4s … capped at 30s, one attempt at a time, as the desktop does.
    private func connectLoop() {
        connectTask?.cancel()
        guard let h = host else { return }
        connectTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                self.attempt += 1
                let last: String? = { if case .connecting(_, let e, _) = self.phase { return e }; return nil }()
                self.phase = .connecting(attempt: self.attempt, lastError: last, retryAt: nil)
                do {
                    let c = try await SSHConnection.open(h)
                    if Task.isCancelled { c.close(); return }
                    try await self.adopt(c)
                    return
                } catch {
                    if Task.isCancelled { return }
                    let delay = min(30, pow(2, Double(self.attempt - 1)))
                    self.phase = .connecting(attempt: self.attempt, lastError: describe(error), retryAt: Date().addingTimeInterval(delay))
                    try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                }
            }
        }
    }

    /// A fresh connection is up: load the profile, then everything else.
    private func adopt(_ c: SSHConnection) async throws {
        let loaded: Profile
        do {
            if let p = try await ProfileStore.read(c, name: profileName) {
                loaded = p
            } else {
                // First run on this host: seed the profile, refusing to clobber
                // one that appeared in the meantime.
                loaded = Profile.fresh()
                try? await ProfileStore.write(c, name: profileName, profile: loaded, createOnly: true)
            }
        } catch {
            c.close()
            throw error
        }
        connection = c
        profile = loaded
        attempt = 0
        linkDown = nil
        phase = .ready
        c.onDisconnect { [weak self] in
            Task { @MainActor in self?.lostConnection(c) }
        }
        profiles = (try? await ProfileStore.list(c)) ?? [profileName]
        await refresh()
        startPolling()
        await startForwards()
        // Whatever was on screen before the drop gets its channel back.
        for t in terminals.values where t.wantsAttach { t.reattach(over: c) }
    }

    private func lostConnection(_ c: SSHConnection) {
        guard connection === c else { return }
        ActivityLog.shared.add("ssh", .warn, "connection to \(c.host.destination) dropped")
        connection = nil
        linkDown = "Connection lost — reconnecting…"
        reconnect()
    }

    /// Bring a dropped connection back without losing the workspace on screen.
    private func reconnect() {
        guard let h = host else { return }
        connectTask?.cancel()
        connectTask = Task { [weak self] in
            var tries = 0
            while !Task.isCancelled {
                guard let self else { return }
                tries += 1
                do {
                    let c = try await SSHConnection.open(h)
                    if Task.isCancelled { c.close(); return }
                    self.connection?.close()
                    self.connection = c
                    self.linkDown = nil
                    c.onDisconnect { [weak self] in Task { @MainActor in self?.lostConnection(c) } }
                    await self.refresh()
                    await self.startForwards()
                    for t in self.terminals.values where t.wantsAttach { t.reattach(over: c) }
                    return
                } catch {
                    let delay = min(30, pow(2, Double(tries - 1)))
                    self.linkDown = "Can't reach \(h.label): \(describe(error))"
                    try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                }
            }
        }
    }

    /// iOS freezes a backgrounded app, and a connection can come back from that
    /// looking alive but carrying nothing. On return, ask it to do real work; if
    /// it cannot within a few seconds, replace it.
    func becameActive() {
        guard host != nil else { return }
        switch phase {
        case .noHost: return
        case .connecting: connectLoop()
        case .ready:
            guard let c = connection, linkDown == nil else { reconnect(); return }
            Task {
                do {
                    let r = try await c.exec("true", timeout: 4)
                    if r.exitCode != 0 { throw RemoteError(label: "probe", message: r.stderr) }
                    await refresh()
                    // Listening sockets do not reliably survive a suspension.
                    if !(host?.tunnels.isEmpty ?? true) { await startForwards() }
                    for t in terminals.values where t.wantsAttach && t.state != .attached { t.reattach(over: c) }
                } catch {
                    ActivityLog.shared.add("ssh", .warn, "connection did not answer after resuming — reconnecting", detail: describe(error))
                    connection = nil
                    c.close()
                    linkDown = "Reconnecting…"
                    reconnect()
                }
            }
        }
    }

    // MARK: Sessions

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                guard let self, !Task.isCancelled else { return }
                if UIApplication.shared.applicationState == .active { await self.refresh() }
            }
        }
    }

    /// `tmux list-sessions` — the session list mirrors it.
    func refresh() async {
        guard let c = connection else { return }
        do {
            sessions = try await Tmux.list(c)
            mouseMode = try? await Tmux.mouseMode(c)
        } catch {
            banner = "Could not list sessions: \(describe(error))"
        }
        await refreshPreviews()
    }

    /// Only while previews are on and the session list is what's on screen.
    private func refreshPreviews() async {
        guard showPreviews, navPath.isEmpty, let c = connection else { return }
        if let p = try? await Tmux.previews(c, names: visibleSessions.map(\.name)) { previews = p }
    }

    var visibleSessions: [SessionInfo] {
        let hidden = Set(profile?.hidden ?? [])
        return sessions.filter { !hidden.contains($0.name) }
    }

    var hiddenSessions: [SessionInfo] {
        let hidden = Set(profile?.hidden ?? [])
        return sessions.filter { hidden.contains($0.name) }
    }

    func createSession(_ name: String) async -> Bool {
        guard let c = connection, let h = host else { return false }
        do {
            try await Tmux.create(c, name: name, command: h.newSessionCommand)
            edit { p in
                p.ensureSession(name)
                p.setHidden(name, false)
            }
            await refresh()
            return true
        } catch {
            banner = "Could not create session “\(name)”: \(describe(error))"
            return false
        }
    }

    func killSession(_ name: String) async {
        guard let c = connection else { return }
        terminals.removeValue(forKey: name)?.detach()
        browsers.removeValue(forKey: name)
        do {
            try await Tmux.kill(c, name: name)
            edit { $0.forgetSession(name) }
        } catch {
            banner = "Could not kill session “\(name)”: \(describe(error))"
        }
        await refresh()
    }

    func renameSession(_ from: String, to: String) async {
        guard from != to, let c = connection else { return }
        do {
            try await Tmux.rename(c, from: from, to: to)
            terminals.removeValue(forKey: from)?.detach()
            if let b = browsers.removeValue(forKey: from) { browsers[to] = b }
            edit { $0.renameSession(from: from, to: to) }
        } catch {
            banner = "Could not rename “\(from)” to “\(to)”: \(describe(error))"
        }
        await refresh()
    }

    func setHidden(_ name: String, _ hidden: Bool) {
        if hidden { terminals[name]?.detach() }
        edit { $0.setHidden(name, hidden) }
    }

    func toggleMouseMode() async {
        guard let c = connection, let on = mouseMode else { return }
        do {
            try await Tmux.setMouseMode(c, on: !on)
            mouseMode = !on
        } catch {
            banner = "Could not change mouse mode: \(describe(error))"
        }
    }

    // MARK: Panes

    func terminal(for session: String) -> TerminalController {
        if let t = terminals[session] { return t }
        let t = TerminalController(session: session, fontSize: hosts.fontSize)
        t.onOpenLink = { [weak self] url in self?.openLink(url, in: session) }
        terminals[session] = t
        return t
    }

    func browser(for session: String) -> BrowserController {
        if let b = browsers[session] { return b }
        let b = BrowserController(initialURL: profile?.url(for: session) ?? Profile.defaultURL)
        b.onNavigate = { [weak self] url in
            guard let self, self.profile?.url(for: session) != url else { return }
            self.edit { $0.setURL(url, for: session) }
        }
        browsers[session] = b
        return b
    }

    /// A link tapped in a terminal opens in that session's browser.
    @Published var showBrowserFor: String?

    private func openLink(_ url: URL, in session: String) {
        browser(for: session).navigate(url.absoluteString)
        showBrowserFor = session
    }

    func show(_ session: String) {
        guard let c = connection else { return }
        let t = terminal(for: session)
        t.wantsAttach = true
        t.attach(over: c)
        if profile?.hidden.contains(session) == false { edit { $0.setActiveSession(session) } }
    }

    func leave(_ session: String) {
        guard let t = terminals[session] else { return }
        t.wantsAttach = false
        t.detach()
    }

    func reattach(_ session: String) {
        guard let c = connection else { return }
        terminal(for: session).reattach(over: c)
    }

    func setFontSize(_ size: Double) {
        hosts.fontSize = size
        terminals.values.forEach { $0.setFontSize(CGFloat(size)) }
    }

    // MARK: Forwards

    func startForwards() async {
        guard let c = connection, let h = host else { return }
        if h.tunnels.isEmpty { await forwarder.stop(); forwards = .init(); return }
        forwards = await forwarder.start(h.tunnels, over: c)
    }

    /// The host's settings changed under us (edited in Settings).
    func hostEdited(_ h: HostEntry) {
        guard h.id == host?.id else { return }
        let reconnectNeeded = h.hostname != host?.hostname || h.port != host?.port || h.user != host?.user
            || h.auth != host?.auth || h.keyID != host?.keyID
        if reconnectNeeded { start(); return }
        host = h
        Task { await startForwards() }
    }

    // MARK: Profile

    /// Apply an edit locally at once, then write it to the host.
    ///
    /// The desktop may be editing the same file, so each write re-reads the
    /// profile first and applies only this edit on top — the phone never writes
    /// back a stale copy of what the desktop changed. Writes run one at a time.
    func edit(_ patch: @escaping (inout Profile) -> Void) {
        guard var p = profile else { return }
        patch(&p)
        profile = p
        let name = profileName
        let previous = saveChain
        saveChain = Task { [weak self] in
            await previous?.value
            guard let self, let c = self.connection, self.profileName == name else { return }
            do {
                var fresh = try await ProfileStore.read(c, name: name) ?? p
                patch(&fresh)
                try await ProfileStore.write(c, name: name, profile: fresh)
                if self.profileName == name { self.profile = fresh }
            } catch {
                self.banner = "Could not save the profile: \(describe(error))"
            }
        }
    }

    func switchProfile(_ name: String) async {
        guard name != profileName, let c = connection, let h = host else { return }
        do {
            let p = try await ProfileStore.read(c, name: name) ?? Profile.fresh()
            profileName = name
            profile = p
            hosts.setActiveProfile(name, for: h.id)
            host = hosts.hosts.first { $0.id == h.id }
            browsers = [:]
        } catch {
            banner = "Could not load profile “\(name)”: \(describe(error))"
        }
    }

    func createProfile(_ name: String) async {
        guard let c = connection else { return }
        do {
            try await ProfileStore.write(c, name: name, profile: .fresh(), createOnly: true)
            profiles = (try? await ProfileStore.list(c)) ?? profiles
            await switchProfile(name)
        } catch {
            banner = "Could not create profile “\(name)”: \(describe(error))"
        }
    }

    func renameProfile(_ from: String, to: String) async {
        guard let c = connection, let h = host else { return }
        do {
            await saveChain?.value
            try await ProfileStore.rename(c, from: from, to: to)
            profiles = (try? await ProfileStore.list(c)) ?? profiles
            if profileName == from {
                profileName = to
                hosts.setActiveProfile(to, for: h.id)
            }
        } catch {
            banner = "Could not rename profile: \(describe(error))"
        }
    }

    func deleteProfile(_ name: String) async {
        guard let c = connection, name != profileName else { return }
        do {
            try await ProfileStore.delete(c, name: name)
            profiles = (try? await ProfileStore.list(c)) ?? profiles
        } catch {
            banner = "Could not delete profile: \(describe(error))"
        }
    }
}
