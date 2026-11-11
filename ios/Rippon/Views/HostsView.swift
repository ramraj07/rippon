import SwiftUI

struct HostsView: View {
    @EnvironmentObject var hosts: HostStore
    @EnvironmentObject var workspace: Workspace
    @Environment(\.dismiss) private var dismiss
    @State private var adding = false

    var body: some View {
        List {
            ForEach(hosts.hosts) { h in
                NavigationLink {
                    HostEditorView(host: h, isNew: false)
                } label: {
                    VStack(alignment: .leading) {
                        HStack {
                            Text(h.label).font(.headline)
                            if h.id == workspace.host?.id { Image(systemName: "checkmark.circle.fill").foregroundStyle(.green) }
                        }
                        Text(h.destination).font(.caption.monospaced()).foregroundStyle(.secondary)
                    }
                }
            }
            .onDelete { idx in
                let ids = idx.map { hosts.hosts[$0].id }
                let wasActive = ids.contains(workspace.host?.id ?? "")
                ids.forEach(hosts.remove)
                if wasActive { workspace.start() }
            }
            Section {
                NavigationLink { KeysView() } label: { Label("SSH keys", systemImage: "key") }
            }
        }
        .navigationTitle("Hosts")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
            ToolbarItem(placement: .primaryAction) { Button { adding = true } label: { Image(systemName: "plus") } }
        }
        .sheet(isPresented: $adding) {
            NavigationStack { HostEditorView(host: HostEntry(), isNew: true) }
        }
    }
}

/// Connection settings for one host. These stay on the phone — only the
/// profile (layout, bookmarks) lives on the host.
struct HostEditorView: View {
    @EnvironmentObject var hosts: HostStore
    @EnvironmentObject var keys: KeyStore
    @EnvironmentObject var workspace: Workspace
    @Environment(\.dismiss) private var dismiss

    @State var host: HostEntry
    let isNew: Bool
    @State private var password = ""
    @State private var portText = "22"
    @State private var newLocal = ""
    @State private var newRemoteHost = "localhost"
    @State private var newRemote = ""
    @State private var forgotKey = false

    var body: some View {
        Form {
            Section {
                TextField("Name (optional)", text: $host.name)
                TextField("Host or IP", text: $host.hostname)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                TextField("User", text: $host.user)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("Port", text: $portText).keyboardType(.numberPad)
            } header: { Text("Connection") } footer: {
                Text("Rippon connects with its own SSH client, so ~/.ssh/config aliases, agents and ProxyJump don't apply. Use the real host name or IP.")
            }

            Section("Authentication") {
                Picker("Method", selection: $host.auth) {
                    Text("SSH key").tag(AuthKind.key)
                    Text("Password").tag(AuthKind.password)
                }
                .pickerStyle(.segmented)
                if host.auth == .key {
                    if keys.keys.isEmpty {
                        NavigationLink { KeysView() } label: { Text("No keys yet — generate or import one") }
                    } else {
                        Picker("Key", selection: Binding(get: { host.keyID ?? "" }, set: { host.keyID = $0.isEmpty ? nil : $0 })) {
                            Text("Choose…").tag("")
                            ForEach(keys.keys) { k in Text("\(k.name) (\(k.type))").tag(k.id) }
                        }
                        NavigationLink { KeysView() } label: { Text("Manage keys") }
                    }
                } else {
                    SecureField("Password", text: $password)
                }
            }

            Section {
                TextField("e.g. claude", text: $host.newSessionCommand)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().font(.body.monospaced())
            } header: { Text("New tmux session command") } footer: {
                Text("Runs inside each tmux session you create from the app.")
            }

            Section {
                ForEach(host.tunnels) { t in Text(t.label).font(.callout.monospaced()) }
                    .onDelete { host.tunnels.remove(atOffsets: $0) }
                HStack {
                    TextField("local", text: $newLocal).keyboardType(.numberPad).frame(width: 64)
                    Text("→")
                    TextField("host", text: $newRemoteHost).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Text(":")
                    TextField("port", text: $newRemote).keyboardType(.numberPad).frame(width: 64)
                    Button("Add") { addTunnel() }.disabled(tunnelError != nil)
                }
                if let e = tunnelError, !(newLocal.isEmpty && newRemote.isEmpty) {
                    Text(e).font(.footnote).foregroundStyle(.red)
                }
            } header: { Text("Port forwards") } footer: {
                Text("A port on the host, served on this iPhone's localhost while the app is open — open http://localhost:<local> in a session's browser. iOS stops them when Rippon is in the background; they restart when you come back.")
            }

            if !isNew {
                Section {
                    Button("Forget saved host key") {
                        KnownHosts.forget(host)
                        forgotKey = true
                    }
                    if forgotKey { Text("Forgotten. The next connection will trust whatever key the host presents.").font(.footnote) }
                } footer: {
                    Text("Only needed if the host was rebuilt and Rippon refuses its new key.")
                }
                Section {
                    Button("Delete host", role: .destructive) {
                        let wasActive = workspace.host?.id == host.id
                        hosts.remove(host.id)
                        if wasActive { workspace.start() }
                        dismiss()
                    }
                }
            }
        }
        .navigationTitle(isNew ? "New host" : host.label)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if isNew { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Save", action: save).disabled(!valid)
            }
        }
        .onAppear {
            portText = String(host.port)
            password = Keychain.password(for: host.id) ?? ""
            if host.keyID == nil { host.keyID = keys.keys.first?.id }
        }
    }

    private var valid: Bool {
        !host.hostname.trimmingCharacters(in: .whitespaces).isEmpty
            && !host.user.trimmingCharacters(in: .whitespaces).isEmpty
            && (Int(portText).map { (1...65535).contains($0) } ?? false)
            && (host.auth == .password || host.keyID != nil)
    }

    private var tunnelError: String? {
        if let e = Tunnel.error(local: Int(newLocal), remoteHost: newRemoteHost, remote: Int(newRemote)) { return e }
        if host.tunnels.contains(where: { $0.localPort == Int(newLocal) }) { return "That local port is already forwarded." }
        return nil
    }

    private func addTunnel() {
        guard tunnelError == nil, let l = Int(newLocal), let r = Int(newRemote) else { return }
        host.tunnels.append(Tunnel(localPort: l, remoteHost: newRemoteHost.isEmpty ? "localhost" : newRemoteHost, remotePort: r))
        newLocal = ""; newRemote = ""
    }

    private func save() {
        host.port = Int(portText) ?? 22
        host.hostname = host.hostname.trimmingCharacters(in: .whitespaces)
        host.user = host.user.trimmingCharacters(in: .whitespaces)
        if host.auth == .password { Keychain.setPassword(password, for: host.id) }
        let first = hosts.hosts.isEmpty
        hosts.upsert(host)
        if first || isNew && workspace.host == nil {
            hosts.activeHostID = host.id
            workspace.start()
        } else if isNew {
            workspace.switchHost(host.id)
        } else {
            workspace.hostEdited(host)
        }
        dismiss()
    }
}
