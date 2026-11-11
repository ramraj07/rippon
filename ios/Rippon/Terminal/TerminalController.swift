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
        outgoing?.yield(.bytes(Array(text.utf8)))
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
        MainActor.assumeIsolated { self.outgoing?.yield(.bytes(bytes)) }
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
