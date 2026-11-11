import SwiftUI

/// The `<name> ▾` chip: switch, create, rename or delete the host's profiles.
struct ProfileMenu: View {
    @EnvironmentObject var workspace: Workspace
    @State private var creating = false
    @State private var renaming = false
    @State private var deleting: String?

    var body: some View {
        Menu {
            Section("Profiles on this host") {
                ForEach(workspace.profiles, id: \.self) { p in
                    Button {
                        Task { await workspace.switchProfile(p) }
                    } label: {
                        if p == workspace.profileName { Label(p, systemImage: "checkmark") } else { Text(p) }
                    }
                }
            }
            Button { creating = true } label: { Label("New profile…", systemImage: "plus") }
            Button { renaming = true } label: { Label("Rename “\(workspace.profileName)”…", systemImage: "pencil") }
            let others = workspace.profiles.filter { $0 != workspace.profileName }
            if !others.isEmpty {
                Menu {
                    ForEach(others, id: \.self) { p in Button(p, role: .destructive) { deleting = p } }
                } label: { Label("Delete…", systemImage: "trash") }
            }
        } label: {
            HStack(spacing: 2) {
                Image(systemName: "person.crop.square")
                Text(workspace.profileName).font(.caption).lineLimit(1)
            }
        }
        .sheet(isPresented: $creating) {
            NameSheet(title: "New profile", prompt: "Profile name", initial: "", action: "Create") { name in
                await workspace.createProfile(name)
            }
        }
        .sheet(isPresented: $renaming) {
            NameSheet(title: "Rename profile", prompt: "New name", initial: workspace.profileName, action: "Rename") { name in
                await workspace.renameProfile(workspace.profileName, to: name)
            }
        }
        .confirmationDialog("Delete profile “\(deleting ?? "")” from the host?", isPresented: Binding(
            get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) { if let d = deleting { Task { await workspace.deleteProfile(d) } } }
        }
    }
}
