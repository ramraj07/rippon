import UIKit
import Combine
import SwiftTerm

/// One key on the bar above the keyboard.
struct BarKey: Codable, Hashable, Identifiable {
    enum Kind: String, Codable, CaseIterable {
        case tmux, esc, ctrl, tab, shiftTab, up, down, left, right
        case pageUp, pageDown, home, end, enter, tilde, pipe, slash, dash, hideKeyboard, snippet
    }

    var id = UUID()
    var kind: Kind
    /// For a snippet: what the key is called and what it types.
    var label = ""
    var text = ""
    var thenReturn = false

    init(_ kind: Kind) { self.kind = kind }
    init(snippet label: String, text: String, thenReturn: Bool) {
        kind = .snippet
        self.label = label
        self.text = text
        self.thenReturn = thenReturn
    }

    var title: String {
        switch kind {
        case .tmux: "tmux"
        case .esc: "esc"
        case .ctrl: "ctrl"
        case .tab: "tab"
        case .shiftTab: "⇧tab"
        case .up: "↑"
        case .down: "↓"
        case .left: "←"
        case .right: "→"
        case .pageUp: "PgUp"
        case .pageDown: "PgDn"
        case .home: "Home"
        case .end: "End"
        case .enter: "⏎"
        case .tilde: "~"
        case .pipe: "|"
        case .slash: "/"
        case .dash: "-"
        case .hideKeyboard: "⌨︎↓"
        case .snippet: label.isEmpty ? text : label
        }
    }

    /// What the settings list calls it.
    var name: String {
        switch kind {
        case .tmux: "tmux menu"
        case .shiftTab: "shift-tab"
        case .up: "Up arrow"
        case .down: "Down arrow"
        case .left: "Left arrow"
        case .right: "Right arrow"
        case .enter: "Return"
        case .hideKeyboard: "Hide keyboard"
        case .snippet: "“\(title)” types \(text)\(thenReturn ? " ⏎" : "")"
        default: title
        }
    }

    var repeats: Bool { [.up, .down, .left, .right].contains(kind) }

    /// The bytes it sends, or nil for keys that do something else.
    func bytes(applicationCursor app: Bool) -> String? {
        let csi = "\u{1b}["
        switch kind {
        case .esc: return "\u{1b}"
        case .tab: return "\t"
        case .shiftTab: return csi + "Z"
        case .up: return app ? "\u{1b}OA" : csi + "A"
        case .down: return app ? "\u{1b}OB" : csi + "B"
        case .right: return app ? "\u{1b}OC" : csi + "C"
        case .left: return app ? "\u{1b}OD" : csi + "D"
        case .pageUp: return csi + "5~"
        case .pageDown: return csi + "6~"
        case .home: return csi + "H"
        case .end: return csi + "F"
        case .enter: return "\r"
        case .tilde: return "~"
        case .pipe: return "|"
        case .slash: return "/"
        case .dash: return "-"
        case .snippet: return text + (thenReturn ? "\r" : "")
        case .tmux, .ctrl, .hideKeyboard: return nil
        }
    }
}

/// The keys on the bar, in order, kept on this iPhone.
@MainActor
final class KeyBarStore: ObservableObject {
    static let shared = KeyBarStore()
    private static let storageKey = "keyBar"

    static let defaults: [BarKey] = [
        BarKey(.tmux), BarKey(.esc), BarKey(.ctrl), BarKey(.tab), BarKey(.shiftTab),
        BarKey(.up), BarKey(.down), BarKey(.left), BarKey(.right), BarKey(.enter), BarKey(.hideKeyboard),
    ]

    @Published var keys: [BarKey] {
        didSet {
            if let data = try? JSONEncoder().encode(keys) { UserDefaults.standard.set(data, forKey: Self.storageKey) }
        }
    }

    private init() {
        if let data = UserDefaults.standard.data(forKey: Self.storageKey),
           let saved = try? JSONDecoder().decode([BarKey].self, from: data) {
            keys = saved
        } else {
            keys = Self.defaults
        }
    }

    func reset() { keys = Self.defaults }
}

/// The bar above the keyboard: the keys from `KeyBarStore`, scrolling sideways
/// when they don't fit.
@MainActor
final class KeyBar: UIInputView {
    private weak var controller: TerminalController?
    private let scroll = UIScrollView()
    private let stack = UIStackView()
    private var ctrlButtons: [UIButton] = []
    private var watch: AnyCancellable?
    private var repeatTimer: Timer?

    init(controller: TerminalController) {
        self.controller = controller
        super.init(frame: CGRect(x: 0, y: 0, width: 390, height: 44), inputViewStyle: .keyboard)
        allowsSelfSizing = true
        autoresizingMask = .flexibleWidth
        scroll.showsHorizontalScrollIndicator = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        stack.axis = .horizontal
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scroll)
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 44),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 6),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -6),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 5),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -5),
            stack.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor, constant: -10),
        ])
        watch = KeyBarStore.shared.$keys.receive(on: DispatchQueue.main).sink { [weak self] keys in
            MainActor.assumeIsolated { self?.build(keys) }
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func build(_ keys: [BarKey]) {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        ctrlButtons = []
        for key in keys { stack.addArrangedSubview(button(for: key)) }
        refresh()
    }

    private func button(for key: BarKey) -> UIButton {
        var config = UIButton.Configuration.filled()
        config.title = key.title
        config.baseBackgroundColor = key.kind == .tmux ? .systemGreen.withAlphaComponent(0.35) : .secondarySystemFill
        config.baseForegroundColor = .label
        config.cornerStyle = .medium
        config.contentInsets = NSDirectionalEdgeInsets(top: 4, leading: 10, bottom: 4, trailing: 10)
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { a in
            var a = a
            a.font = UIFont.monospacedSystemFont(ofSize: 15, weight: .medium)
            return a
        }
        let b = UIButton(configuration: config)
        b.widthAnchor.constraint(greaterThanOrEqualToConstant: 38).isActive = true

        switch key.kind {
        case .tmux:
            b.menu = TmuxMenu.make(for: controller)
            b.showsMenuAsPrimaryAction = true
        case .ctrl:
            ctrlButtons.append(b)
            b.addAction(UIAction { [weak self] _ in
                guard let view = self?.controller?.view else { return }
                view.controlModifier.toggle()
                self?.refresh()
            }, for: .touchUpInside)
        case .hideKeyboard:
            b.addAction(UIAction { [weak self] _ in _ = self?.controller?.view.resignFirstResponder() }, for: .touchUpInside)
        default:
            if key.repeats {
                b.addAction(UIAction { [weak self] _ in self?.press(key, repeating: true) }, for: .touchDown)
                for e: UIControl.Event in [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit] {
                    b.addAction(UIAction { [weak self] _ in self?.stopRepeat() }, for: e)
                }
            } else {
                b.addAction(UIAction { [weak self] _ in self?.press(key, repeating: false) }, for: .touchUpInside)
            }
        }
        return b
    }

    private func press(_ key: BarKey, repeating: Bool) {
        guard let c = controller else { return }
        UIDevice.current.playInputClick()
        let send = { [weak c] in
            guard let c, let s = key.bytes(applicationCursor: c.view.getTerminal().applicationCursor) else { return }
            c.send(s)
        }
        send()
        guard repeating else { return }
        stopRepeat()
        repeatTimer = Timer.scheduledTimer(withTimeInterval: 0.45, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.repeatTimer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { _ in
                    MainActor.assumeIsolated { send() }
                }
            }
        }
    }

    private func stopRepeat() {
        repeatTimer?.invalidate()
        repeatTimer = nil
    }

    /// Lights ctrl while it is armed for the next key.
    func refresh() {
        let on = controller?.view.controlModifier ?? false
        for b in ctrlButtons {
            b.configuration?.baseBackgroundColor = on ? .systemBlue : .secondarySystemFill
            b.configuration?.baseForegroundColor = on ? .white : .label
        }
    }
}

extension KeyBar: UIInputViewAudioFeedback {
    var enableInputClicksWhenVisible: Bool { true }
}
