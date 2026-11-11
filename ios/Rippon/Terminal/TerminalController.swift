import UIKit
import SwiftTerm
import Citadel
import NIOCore
import NIOSSH

/// One tmux session on screen: a SwiftTerm view and the PTY channel feeding it.
///
/// The view outlives the channel. Leaving a session detaches it (freeing its
/// channel — sshd allows ten per connection by default), and coming back
/// reattaches; tmux redraws the screen, so nothing is lost but local scrollback.
@MainActor
final class TerminalController: NSObject, ObservableObject {
    enum State: Equatable { case detached, attaching, attached, ended(String) }

    let session: String
    let view: TerminalView
    @Published private(set) var state: State = .detached

    /// Whether the session is on screen and should hold a channel. Survives
    /// drops, so a reconnect knows which panes to bring back.
    var wantsAttach = false

    /// Tapped links go here instead of Safari.
    var onOpenLink: ((URL) -> Void)?

    private var task: Task<Void, Never>?
    /// Bumped on every attach, so a channel that ends late cannot clobber the
    /// state of the one that replaced it.
    private var generation = 0
    private var outgoing: AsyncStream<Outgoing>.Continuation?

    /// The connection the PTY rides, for the tmux commands scrolling sends.
    private weak var connection: SSHConnection?
    private var scroller: TerminalScroller?
    /// Set after scrolling up, since tmux is then likely in copy mode; the next
    /// keystroke takes it out first, so typing always lands in the program.
    private var mayBeInCopyMode = false
    /// Keystrokes typed while that copy-mode cancel is in flight.
    private var heldKeys: [UInt8]?
    private var pendingScroll = 0
    private var scrollInFlight = false
    private var wheelResidual = 0
    /// True while wheel events are being written, which are not typing.
    private var sendingWheel = false

    private enum Outgoing {
        case bytes([UInt8])
        case resize(cols: Int, rows: Int)
    }

    init(session: String, fontSize: CGFloat) {
        self.session = session
        view = TerminalView(frame: CGRect(x: 0, y: 0, width: 390, height: 600))
        super.init()
        view.terminalDelegate = self
        setFontSize(fontSize)
        view.nativeBackgroundColor = UIColor(red: 0.06, green: 0.07, blue: 0.10, alpha: 1)
        view.nativeForegroundColor = UIColor(white: 0.92, alpha: 1)
        scroller = TerminalScroller(view: view) { [weak self] lines, point in
            self?.scroll(lines: lines, at: point)
        }
        let bar = KeyBar(controller: self)
        keyBar = bar
        view.inputAccessoryView = bar
    }

    private weak var keyBar: KeyBar?

    /// Run a tmux command against this session; `{s}` stands for its exact
    /// target. Fire and forget: tmux redraws the pane itself.
    func tmux(_ command: String) {
        Task { _ = await tmuxOutput(command) }
    }

    /// The same, returning what it printed, or nil if it failed.
    func tmuxOutput(_ command: String) async -> String? {
        guard let c = connection else { return nil }
        let line = "tmux " + command.replacingOccurrences(of: "{s}", with: "=\(session)")
        // `run` logs failures to SSH activity.
        return try? await c.run(line, source: "tmux", label: String(command.prefix(40)))
    }

    func setFontSize(_ size: CGFloat) {
        view.font = UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
    }

    func attach(over connection: SSHConnection) {
        guard task == nil else { return }
        state = .attaching
        generation += 1
        let mine = generation
        let term = view.getTerminal()
        let request = SSHChannelRequestEvent.PseudoTerminalRequest(
            wantReply: true,
            term: "xterm-256color",
            terminalCharacterWidth: max(term.cols, 20),
            terminalRowHeight: max(term.rows, 5),
            terminalPixelWidth: 0,
            terminalPixelHeight: 0,
            terminalModes: SSHTerminalModes([:]))
        let (stream, continuation) = AsyncStream<Outgoing>.makeStream()
        outgoing = continuation
        continuation.yield(.bytes(Array(Tmux.attachLine(session).utf8)))
        let client = connection.client
        let name = session
        self.connection = connection
        mayBeInCopyMode = false
        heldKeys = nil

        task = Task { [weak self] in
            var reason = "detached"
            do {
                try await client.withPTY(request) { inbound, outbound in
                    await MainActor.run { self?.state = .attached }
                    // Keystrokes go out strictly in order, through one writer.
                    let writer = Task {
                        for await item in stream {
                            switch item {
                            case .bytes(let b): try? await outbound.write(ByteBuffer(bytes: b))
                            case .resize(let c, let r):
                                try? await outbound.changeSize(cols: c, rows: r, pixelWidth: 0, pixelHeight: 0)
                            }
                        }
                    }
                    defer { writer.cancel() }
                    for try await chunk in inbound {
                        let bytes: [UInt8]
                        switch chunk {
                        case .stdout(let b), .stderr(let b): bytes = Array(b.readableBytesView)
                        }
                        await MainActor.run { self?.view.feed(byteArray: bytes[...]) }
                    }
                }
            } catch is CancellationError {
                reason = "detached"
            } catch {
                reason = describe(error)
                ActivityLog.log("pane", .warn, "\(name) ended", detail: reason)
            }
            await MainActor.run {
                guard let self, self.generation == mine else { return }
                self.task = nil
                self.outgoing?.finish()
                self.outgoing = nil
                if reason == "detached" {
                    self.state = .detached
                } else {
                    self.state = .ended(reason)
                    self.view.feed(text: "\r\n\u{1b}[2m[rippon] \(reason)\u{1b}[0m\r\n")
                }
            }
        }
    }

    func detach() {
        generation += 1
        task?.cancel()
        task = nil
        outgoing?.finish()
        outgoing = nil
        state = .detached
    }

    func reattach(over connection: SSHConnection) {
        detach()
        attach(over: connection)
    }

    /// Send raw input, as if typed — used by the key bar's extra keys.
    func send(_ text: String) {
        type(Array(text.utf8))
    }

    /// Everything the user types goes through here.
    fileprivate func type(_ bytes: [UInt8]) {
        if sendingWheel {
            outgoing?.yield(.bytes(bytes))
            return
        }
        scroller?.stopMomentum()
        scroller?.clearSelection()
        defer { keyBar?.refresh() }
        if heldKeys != nil {
            heldKeys! += bytes
            return
        }
        guard mayBeInCopyMode, let c = connection else {
            outgoing?.yield(.bytes(bytes))
            return
        }
        // Leave copy mode before the keys arrive, or tmux would take them as
        // copy-mode commands. "Not in a mode" is fine: then there was nothing to leave.
        mayBeInCopyMode = false
        heldKeys = bytes
        let name = session
        Task { [weak self] in
            _ = try? await c.exec("tmux send-keys -t \(name) -X cancel", timeout: 3)
            guard let self else { return }
            let keys = self.heldKeys ?? []
            self.heldKeys = nil
            self.outgoing?.yield(.bytes(keys))
        }
    }

    /// Scroll by `lines` (positive is back into history).
    ///
    /// When tmux's mouse mode is on — or the program in the pane asked for the
    /// mouse — the terminal is reporting mouse events, so this sends real wheel
    /// events and tmux or the program scrolls as it would for a trackpad. When it
    /// is off, there is nothing on the PTY that scrolls, so the same tmux commands
    /// a wheel would trigger are run over the connection instead.
    func scroll(lines: Int, at point: CGPoint) {
        guard lines != 0, state == .attached else { return }
        if lines > 0 { mayBeInCopyMode = true }
        let term = view.getTerminal()
        if term.mouseMode != .off {
            // tmux moves 5 lines per wheel notch; 3 rows of finger per notch
            // keeps the content roughly under the finger without being sluggish.
            wheelResidual += lines
            let notches = wheelResidual / 3
            guard notches != 0 else { return }
            wheelResidual -= notches * 3
            let cellW = view.bounds.width / CGFloat(max(1, term.cols))
            let cellH = view.bounds.height / CGFloat(max(1, term.rows))
            let col = min(max(0, Int(point.x / cellW)), term.cols - 1)
            let row = min(max(0, Int((point.y - view.contentOffset.y) / cellH)), term.rows - 1)
            let flags = term.encodeButton(button: notches > 0 ? 4 : 5, release: false, shift: false, meta: false, control: false)
            sendingWheel = true
            for _ in 0..<min(abs(notches), 20) { term.sendEvent(buttonFlags: flags, x: col, y: row) }
            sendingWheel = false
        } else {
            pendingScroll += lines
            flushScroll()
        }
    }

    /// One tmux call at a time; whatever accumulates meanwhile goes in the next.
    private func flushScroll() {
        guard !scrollInFlight, pendingScroll != 0, let c = connection else { return }
        let n = pendingScroll
        pendingScroll = 0
        scrollInFlight = true
        let s = session
        // `copy-mode -e` leaves copy mode again on reaching the bottom.
        let command = n > 0
            ? "tmux copy-mode -e -t \(s) \\; send-keys -t \(s) -X -N \(n) scroll-up"
            : "tmux send-keys -t \(s) -X -N \(-n) scroll-down"
        Task { [weak self] in
            _ = try? await c.exec(command, timeout: 5)
            guard let self else { return }
            self.scrollInFlight = false
            self.flushScroll()
        }
    }
}

extension TerminalController: TerminalViewDelegate {
    nonisolated func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        MainActor.assumeIsolated { self.outgoing?.yield(.resize(cols: newCols, rows: newRows)) }
    }

    nonisolated func setTerminalTitle(source: TerminalView, title: String) {}

    nonisolated func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

    nonisolated func send(source: TerminalView, data: ArraySlice<UInt8>) {
        // SwiftTerm calls this on the main thread; yielding synchronously keeps
        // keystrokes in the order they were typed.
        let bytes = Array(data)
        MainActor.assumeIsolated { self.type(bytes) }
    }

    nonisolated func scrolled(source: TerminalView, position: Double) {}

    nonisolated func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        guard let url = URL(string: link), let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme) else { return }
        Task { @MainActor in self.onOpenLink?(url) }
    }

    nonisolated func bell(source: TerminalView) {}

    /// OSC 52 — tmux sends its selection here when `set-clipboard` is on.
    nonisolated func clipboardCopy(source: TerminalView, content: Data) {
        guard let text = String(data: content, encoding: .utf8) else { return }
        Task { @MainActor in UIPasteboard.general.string = text }
    }

    nonisolated func clipboardRead(source: TerminalView) -> Data? { nil }

    nonisolated func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}

    nonisolated func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}
