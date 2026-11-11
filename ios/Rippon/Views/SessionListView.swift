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
                        Text("No sessions on \(workspace.host?.label ?? "the host")").font(.headline)
                        Text("Tap + to start one. Sessions an agent starts on the box show up here within seconds.")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 6)
                }
            } else {
                Section {
                    ForEach(workspace.visibleSessions) { s in
                        NavigationLink(value: s.name) { SessionRow(session: s) }
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
                                Button(role: .destructive) { killing = s.name } label: { Label("Kill session", systemImage: "xmark.octagon") }
                            }
                    }
                } footer: {
                    Text("Swipe to hide a session (it keeps running) or kill it.")
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
        .navigationTitle("Sessions")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: String.self) { name in
            SessionView(name: name)
        }
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                ProfileMenu()
                Button { creating = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("New session")
                    .keyboardShortcut("t", modifiers: .command)
                Menu {
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
            NameSheet(title: "New session", prompt: "Session name", initial: "", action: "Create") { name in
                if await workspace.createSession(name) { workspace.navPath.append(name) }
            }
        }
        .sheet(item: Binding(get: { renaming.map(Ident.init) }, set: { renaming = $0?.id })) { item in
            NameSheet(title: "Rename session", prompt: "New name", initial: item.id, action: "Rename") { name in
                await workspace.renameSession(item.id, to: name)
            }
        }
        .confirmationDialog("Kill session “\(killing ?? "")”?", isPresented: Binding(
            get: { killing != nil }, set: { if !$0 { killing = nil } }), titleVisibility: .visible
        ) {
            Button("Kill session", role: .destructive) {
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

    var body: some View {
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
