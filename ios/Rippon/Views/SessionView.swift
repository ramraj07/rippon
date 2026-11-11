import SwiftUI
import SwiftTerm

/// One session, full screen. The desktop splits terminal and browser side by
/// side; an iPhone has room for one at a time, so they swap.
struct SessionView: View {
    let name: String
    @EnvironmentObject var workspace: Workspace
    @State private var pane: Pane = .terminal

    enum Pane: String, CaseIterable { case terminal = "Terminal", browser = "Browser" }

    var body: some View {
        let terminal = workspace.terminal(for: name)
        let browser = workspace.browser(for: name)
        ZStack {
            TerminalPane(controller: terminal)
                .opacity(pane == .terminal ? 1 : 0)
                .allowsHitTesting(pane == .terminal)
            if pane == .browser {
                BrowserPane(controller: browser, session: name)
                    .onAppear { browser.loadIfNeeded() }
            }
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker("Pane", selection: $pane) {
                    ForEach(Pane.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .frame(width: 200)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Text(name)
                    Button { workspace.reattach(name) } label: { Label("Reattach", systemImage: "arrow.triangle.2.circlepath") }
                        .keyboardShortcut("r", modifiers: [.command, .shift])
                    Menu {
                        Button("Larger") { workspace.setFontSize(min(32, workspace.hosts.fontSize + 1)) }
                        Button("Smaller") { workspace.setFontSize(max(8, workspace.hosts.fontSize - 1)) }
                        Button("Default") { workspace.setFontSize(12) }
                    } label: { Label("Text size (\(Int(workspace.hosts.fontSize)))", systemImage: "textformat.size") }
                    Button { terminal.detach() } label: { Label("Detach from tmux", systemImage: "eject") }
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { workspace.show(name) }
        .onDisappear { workspace.leave(name) }
        .onChange(of: workspace.showBrowserFor) { _, target in
            if target == name {
                pane = .browser
                workspace.showBrowserFor = nil
            }
        }
    }
}

struct TerminalPane: View {
    @ObservedObject var controller: TerminalController
    @EnvironmentObject var workspace: Workspace

    var body: some View {
        ZStack(alignment: .top) {
            TerminalHost(view: controller.view)
                .background(Color(red: 0.06, green: 0.07, blue: 0.10))
            switch controller.state {
            case .attaching:
                status { ProgressView().tint(.white); Text("Attaching…") }
            case .detached:
                status {
                    Text("Detached")
                    Button("Reattach") { workspace.reattach(controller.session) }.buttonStyle(.borderedProminent)
                }
            case .ended(let why):
                status {
                    Text(why).lineLimit(3)
                    Button("Reattach") { workspace.reattach(controller.session) }.buttonStyle(.borderedProminent)
                }
            case .attached:
                EmptyView()
            }
        }
    }

    private func status<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        HStack(spacing: 10) { content() }
            .font(.footnote)
            .foregroundStyle(.white)
            .padding(.horizontal, 14).padding(.vertical, 8)
            .background(.black.opacity(0.75), in: Capsule())
            .padding(.top, 8)
    }
}

/// Hosts the controller's long-lived SwiftTerm view. The view is not recreated
/// when SwiftUI rebuilds, so the screen survives switching panes.
struct TerminalHost: UIViewRepresentable {
    let view: TerminalView

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = .clear
        attach(view, to: container)
        DispatchQueue.main.async { _ = view.becomeFirstResponder() }
        return container
    }

    func updateUIView(_ container: UIView, context: Context) {
        if view.superview !== container { attach(view, to: container) }
    }

    private func attach(_ view: TerminalView, to container: UIView) {
        view.removeFromSuperview()
        view.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            view.topAnchor.constraint(equalTo: container.topAnchor),
            view.bottomAnchor.constraint(equalTo: container.bottomAnchor)
        ])
    }
}
