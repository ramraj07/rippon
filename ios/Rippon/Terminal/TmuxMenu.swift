import UIKit

/// The tmux key's menu: windows, panes, copy mode and detach, without the
/// prefix key. Each item runs the tmux command over the connection, aimed at
/// this session, so it works whatever the prefix is set to.
@MainActor
enum TmuxMenu {
    static func make(for controller: TerminalController?) -> UIMenu {
        weak var c = controller
        func run(_ command: String) -> UIActionHandler { { _ in c?.tmux(command) } }
        func item(_ title: String, _ image: String, _ command: String) -> UIAction {
            UIAction(title: title, image: UIImage(systemName: image), handler: run(command))
        }

        let windows = UIMenu(title: "Windows", options: .displayInline, children: [
            item("New window", "plus.rectangle", "new-window -t {s}: -c '#{pane_current_path}'"),
            item("Next window", "arrow.right.square", "next-window -t {s}"),
            item("Previous window", "arrow.left.square", "previous-window -t {s}"),
            UIMenu(title: "Go to window", image: UIImage(systemName: "list.bullet.rectangle"), children: [
                UIDeferredMenuElement.uncached { done in
                    Task { @MainActor in done(await windowList(c)) }
                },
            ]),
            UIAction(title: "Rename window…", image: UIImage(systemName: "pencil")) { _ in renameWindow(c) },
        ])
        let panes = UIMenu(title: "Panes", options: .displayInline, children: [
            item("Split side by side", "rectangle.split.2x1", "split-window -h -t {s}: -c '#{pane_current_path}'"),
            item("Split stacked", "rectangle.split.1x2", "split-window -v -t {s}: -c '#{pane_current_path}'"),
            item("Next pane", "arrow.triangle.swap", "select-pane -t {s}:.+"),
            item("Zoom pane on/off", "arrow.up.left.and.arrow.down.right", "resize-pane -Z -t {s}:"),
        ])
        let more = UIMenu(title: "", options: .displayInline, children: [
            item("Copy mode (scroll, search)", "text.viewfinder", "copy-mode -t {s}:"),
            UIAction(title: "Detach", image: UIImage(systemName: "eject")) { _ in c?.detach() },
            UIMenu(title: "Close…", image: UIImage(systemName: "xmark.square"), children: [
                UIAction(title: "Close pane", attributes: .destructive) { _ in
                    confirm(c, "Close the current pane?", "Whatever runs in it ends.", "kill-pane -t {s}:")
                },
                UIAction(title: "Close window", attributes: .destructive) { _ in
                    confirm(c, "Close the current window?", "Every pane in it ends.", "kill-window -t {s}:")
                },
            ]),
        ])
        return UIMenu(title: "tmux", children: [windows, panes, more])
    }

    private static func windowList(_ c: TerminalController?) async -> [UIMenuElement] {
        guard let c, let out = await c.tmuxOutput("list-windows -t {s} -F '#{window_index}\t#{window_name}\t#{window_active}'") else {
            return [UIAction(title: "Couldn't list windows", attributes: .disabled) { _ in }]
        }
        let rows = out.split(separator: "\n").map { $0.split(separator: "\t", omittingEmptySubsequences: false).map(String.init) }
        let items: [UIMenuElement] = rows.compactMap { p in
            guard p.count >= 3, let index = Int(p[0]) else { return nil }
            return UIAction(title: "\(index): \(p[1])", state: p[2] == "1" ? .on : .off) { [weak c] _ in
                c?.tmux("select-window -t {s}:\(index)")
            }
        }
        return items.isEmpty ? [UIAction(title: "No windows", attributes: .disabled) { _ in }] : items
    }

    private static func renameWindow(_ c: TerminalController?) {
        guard let c, let top = presenter(for: c) else { return }
        let alert = UIAlertController(title: "Rename window", message: nil, preferredStyle: .alert)
        alert.addTextField { f in
            f.autocapitalizationType = .none
            f.autocorrectionType = .no
            f.clearButtonMode = .whileEditing
        }
        Task { @MainActor in
            if let name = await c.tmuxOutput("display-message -p -t {s}: '#{window_name}'") {
                alert.textFields?.first?.text = name.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Rename", style: .default) { [weak c] _ in
            let name = alert.textFields?.first?.text?.trimmingCharacters(in: .whitespaces) ?? ""
            guard !name.isEmpty else { return }
            c?.tmux("rename-window -t {s}: -- \(shellQuote(name))")
        })
        top.present(alert, animated: true)
    }

    private static func confirm(_ c: TerminalController?, _ title: String, _ message: String, _ command: String) {
        guard let c, let top = presenter(for: c) else { return }
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Close", style: .destructive) { [weak c] _ in c?.tmux(command) })
        top.present(alert, animated: true)
    }

    private static func presenter(for c: TerminalController) -> UIViewController? {
        var top = c.view.window?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }

    static func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
