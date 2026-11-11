import SwiftUI

struct RootView: View {
    @EnvironmentObject var workspace: Workspace
    @EnvironmentObject var hosts: HostStore

    var body: some View {
        NavigationStack(path: $workspace.navPath) {
            Group {
                switch workspace.phase {
                case .noHost:
                    WelcomeView()
                case .connecting(let attempt, let error, let retryAt):
                    ConnectingView(attempt: attempt, error: error, retryAt: retryAt)
                case .ready:
                    SessionListView()
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { HostMenu() }
            }
        }
        .alert("Something went wrong", isPresented: Binding(
            get: { workspace.banner != nil },
            set: { if !$0 { workspace.banner = nil } })
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(workspace.banner ?? "")
        }
    }
}

/// The host switcher, top left — the desktop's title-bar host chip.
struct HostMenu: View {
    @EnvironmentObject var workspace: Workspace
    @EnvironmentObject var hosts: HostStore
    @State private var managing = false

    var body: some View {
        Menu {
            ForEach(hosts.hosts) { h in
                Button {
                    workspace.switchHost(h.id)
                } label: {
                    if h.id == workspace.host?.id { Label(h.label, systemImage: "checkmark") } else { Text(h.label) }
                }
            }
            Divider()
            Button { managing = true } label: { Label("Manage hosts…", systemImage: "gearshape") }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "server.rack")
                Text(workspace.host?.label ?? "No host").lineLimit(1)
                Image(systemName: "chevron.down").font(.caption2)
            }
            .font(.subheadline.weight(.semibold))
        }
        .sheet(isPresented: $managing) {
            NavigationStack { HostsView() }
        }
    }
}

struct WelcomeView: View {
    @State private var adding = false

    var body: some View {
        ContentUnavailableView {
            Label("Add a host", systemImage: "server.rack")
        } description: {
            Text("Rippon drives the tmux sessions on a machine you reach over SSH. Each session is a terminal, with a browser beside it for the PRs its agent opens.")
        } actions: {
            Button("Add host") { adding = true }.buttonStyle(.borderedProminent)
        }
        .sheet(isPresented: $adding) {
            NavigationStack { HostEditorView(host: HostEntry(), isNew: true) }
        }
    }
}

/// Shown until the profile has been read from the host — there is no workspace
/// before then, so nothing that edits one is reachable.
struct ConnectingView: View {
    @EnvironmentObject var workspace: Workspace
    let attempt: Int
    let error: String?
    let retryAt: Date?

    var body: some View {
        VStack(spacing: 16) {
            if retryAt == nil {
                ProgressView()
                Text("Connecting to \(workspace.host?.destination ?? "host")…").font(.headline)
            } else {
                Image(systemName: "bolt.horizontal.circle").font(.system(size: 44)).foregroundStyle(.secondary)
                Text("Can't reach \(workspace.host?.label ?? "the host")").font(.headline)
            }
            if let retryAt {
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    let s = max(0, Int(retryAt.timeIntervalSince(ctx.date).rounded(.up)))
                    Text("Attempt \(attempt) failed. Retrying in \(s)s.").font(.subheadline).foregroundStyle(.secondary)
                }
            }
            if let error {
                ScrollView {
                    Text(error).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 200)
                .padding(10)
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
            }
            Button("Retry now") { workspace.retryNow() }.buttonStyle(.bordered)
        }
        .padding(24)
        .navigationTitle("")
    }
}
