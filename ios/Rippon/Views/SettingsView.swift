import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var workspace: Workspace
    @EnvironmentObject var hosts: HostStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Form {
            Section("Terminal") {
                Stepper(value: Binding(get: { hosts.fontSize }, set: { workspace.setFontSize($0) }), in: 8...32, step: 1) {
                    Text("Text size: \(Int(hosts.fontSize)) pt")
                }
            }
            Section {
                NavigationLink { HostsView() } label: { Label("Hosts", systemImage: "server.rack") }
                NavigationLink { KeysView() } label: { Label("SSH keys", systemImage: "key") }
            }
            if let h = workspace.host {
                Section("Current host") {
                    LabeledContent("Destination", value: h.destination)
                    LabeledContent("Profile", value: workspace.profileName)
                    if !h.tunnels.isEmpty {
                        ForEach(h.tunnels) { t in
                            let up = workspace.forwards.running.contains(t.label)
                            Label(t.label, systemImage: up ? "checkmark.circle.fill" : "exclamationmark.circle")
                                .foregroundStyle(up ? .green : .orange)
                                .font(.caption.monospaced())
                        }
                        ForEach(workspace.forwards.errors, id: \.self) { e in
                            Text(e).font(.caption2.monospaced()).foregroundStyle(.red)
                        }
                    }
                }
            }
            Section("This build") {
                LabeledContent("Commit", value: Bundle.main.object(forInfoDictionaryKey: "RipponCommit") as? String ?? "unknown")
                    .font(.callout.monospaced())
                LabeledContent("Built", value: Bundle.main.object(forInfoDictionaryKey: "RipponBuiltAt") as? String ?? "unknown")
            }
            Section {
                Text("Layouts, per-session pages and bookmarks are stored on the host in ~/.rippon/profiles, so the desktop app and this iPhone share them. Tiled and multi-view layouts from the desktop are kept as they are.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
    }
}
