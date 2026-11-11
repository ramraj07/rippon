import SwiftUI

/// The session list: a live mirror of `tmux list-sessions` on the host — the
/// phone's version of the desktop tab strip.
struct SessionListView: View {
    @EnvironmentObject var workspace: Workspace
    @State private var creating = false
    @State private var renaming: String?
    @State private var killing: String?
    @State private var sheet: Sheet?

    enum Sheet: String, Identifiable {
        case files, activity, settings
        var id: String { rawValue }
    }

    var body: some View {
        List {
            if let down = workspace.linkDown {
                Label(down, systemImage: "wifi.exclamationmark")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
            if workspace.visibleSessions.isEmpty {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("No tmux sessions on \(workspace.host?.label ?? "the host")").font(.headline)
                        Text("Tap + to start one. tmux sessions an agent starts on the box show up here within seconds.")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 6)
                }
            } else {
                Section {
                    ForEach(workspace.visibleSessions) { s in
                        NavigationLink(value: s.name) {
                            SessionRow(session: s, preview: workspace.showPreviews ? workspace.previews[s.name] ?? "" : nil)
                        }
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) { killing = s.name } label: { Label("Kill", systemImage: "xmark.octagon") }
                                if workspace.profile?.canHide == true {
                                    Button { workspace.setHidden(s.name, true) } label: { Label("Hide", systemImage: "eye.slash") }
                                        .tint(.gray)
                                }
                            }
                            .contextMenu {
                                Button { renaming = s.name } label: { Label("Rename", systemImage: "pencil") }
                                if workspace.profile?.canHide == true {
                                    Button { workspace.setHidden(s.name, true) } label: { Label("Hide (keeps running)", systemImage: "eye.slash") }
                                }
                                Button(role: .destructive) { killing = s.name } label: { Label("Kill tmux session", systemImage: "xmark.octagon") }
                            }
                    }
                } footer: {
                    Text("Swipe to hide a tmux session (it keeps running) or kill it.")
                }
            }
            if !workspace.hiddenSessions.isEmpty {
                Section("Hidden — still running") {
                    ForEach(workspace.hiddenSessions) { s in
                        HStack {
                            Text(s.name).foregroundStyle(.secondary)
                            Spacer()
                            Button("Show") { workspace.setHidden(s.name, false) }.buttonStyle(.borderless)
                        }
                    }
                }
            }
        }
        .refreshable { await workspace.refresh() }
        .navigationTitle("tmux sessions")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: String.self) { name in
            SessionView(name: name)
        }
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                ProfileMenu()
                Button { creating = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("New tmux session")
                    .keyboardShortcut("t", modifiers: .command)
                Menu {
                    Button { workspace.showPreviews.toggle() } label: {
                        Label(workspace.showPreviews ? "Hide previews" : "Show previews",
                              systemImage: workspace.showPreviews ? "rectangle.slash" : "rectangle.inset.filled")
                    }
                    Button { sheet = .files } label: { Label("Browse files", systemImage: "folder") }
                    if let on = workspace.mouseMode {
                        Button { Task { await workspace.toggleMouseMode() } } label: {
                            Label(on ? "Turn tmux mouse off" : "Turn tmux mouse on", systemImage: "cursorarrow.click")
                        }
                    }
                    if !(workspace.host?.tunnels.isEmpty ?? true) {
                        Button { Task { await workspace.startForwards() } } label: {
                            Label(forwardLabel, systemImage: "arrow.left.arrow.right")
                        }
                    }
                    Button { sheet = .activity } label: { Label("SSH activity", systemImage: "list.bullet.rectangle") }
                    Button { Task { await workspace.refresh() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    Divider()
                    Button { sheet = .settings } label: { Label("Settings", systemImage: "gearshape") }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
        .sheet(item: $sheet) { s in
            NavigationStack {
                switch s {
                case .files: FileBrowserView()
                case .activity: ActivityLogView()
                case .settings: SettingsView()
                }
            }
        }
        .sheet(isPresented: $creating) {
            NameSheet(title: "New tmux session", prompt: "Session name", initial: "", action: "Create") { name in
                if await workspace.createSession(name) { workspace.navPath.append(name) }
            }
        }
        .sheet(item: Binding(get: { renaming.map(Ident.init) }, set: { renaming = $0?.id })) { item in
            NameSheet(title: "Rename tmux session", prompt: "New name", initial: item.id, action: "Rename") { name in
                await workspace.renameSession(item.id, to: name)
            }
        }
        .confirmationDialog("Kill tmux session “\(killing ?? "")”?", isPresented: Binding(
            get: { killing != nil }, set: { if !$0 { killing = nil } }), titleVisibility: .visible
        ) {
            Button("Kill tmux session", role: .destructive) {
                if let k = killing { Task { await workspace.killSession(k) } }
            }
            if workspace.profile?.canHide == true {
                Button("Hide it instead") { if let k = killing { workspace.setHidden(k, true) } }
            }
        } message: {
            Text("tmux kill-session ends it and everything running in it. Hiding keeps it running.")
        }
    }

    private var forwardLabel: String {
        let f = workspace.forwards
        if !f.errors.isEmpty { return "Port forwards: \(f.errors.count) failed — restart" }
        return f.running.isEmpty ? "Start port forwards" : "Port forwards: \(f.running.count) up — restart"
    }
}

struct Ident: Identifiable { let id: String }

struct SessionRow: View {
    let session: SessionInfo
    /// The session's screen as text; nil when previews are off.
    var preview: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if let preview { ScreenPreview(text: preview) }
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Image(systemName: "terminal")
                .foregroundStyle(session.attached ? Color.green : Color.secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.name).font(.body.monospaced())
                HStack(spacing: 6) {
                    Text(session.created, style: .relative) + Text(" old")
                    Text("·")
                    Text("\(session.windows) window\(session.windows == 1 ? "" : "s")")
                    if session.attached { Text("· attached") }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

/// A session's screen in a very small font: the bottom of it, where the
/// prompt and the latest output are, cut off on the right like a thumbnail.
struct ScreenPreview: View {
    let text: String
    static let lines = 14
    static let size: CGFloat = 5.5

    var body: some View {
        let tail = text.split(separator: "\n", omittingEmptySubsequences: false).suffix(Self.lines).joined(separator: "\n")
        let height = Self.size * 1.25 * CGFloat(Self.lines)
        // The text sits in an overlay so its natural width (a wide pane can be
        // 200+ columns) never sizes the row: the box takes the row's width and
        // the rest is cut off on the right, unwrapped.
        Color.clear
            .frame(maxWidth: .infinity, minHeight: height, maxHeight: height)
            .overlay(alignment: .bottomLeading) {
                Text(tail.isEmpty ? " " : tail)
                    .font(.system(size: Self.size, design: .monospaced))
                    .foregroundStyle(Color(white: 0.85))
                    .lineLimit(Self.lines)
                    .fixedSize()
            }
            .clipped()
            .padding(6)
            .background(Color(red: 0.06, green: 0.07, blue: 0.10), in: RoundedRectangle(cornerRadius: 6))
            .accessibilityHidden(true)
    }
}

/// A name prompt for sessions and profiles, validated to the tmux-safe subset.
struct NameSheet: View {
    let title: String
    let prompt: String
    let initial: String
    let action: String
    let submit: (String) async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var busy = false
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                TextField(prompt, text: $name)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.body.monospaced())
                    .focused($focused)
                    .onSubmit(go)
                if let e = Names.error(name), !name.isEmpty {
                    Text(e).font(.footnote).foregroundStyle(.red)
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(action, action: go).disabled(Names.error(name) != nil || busy)
                }
            }
            .onAppear { name = initial; focused = true }
        }
        .presentationDetents([.medium])
    }

    private func go() {
        guard Names.error(name) == nil, !busy else { return }
        busy = true
        Task {
            await submit(name)
            dismiss()
        }
    }
}
