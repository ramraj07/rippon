import SwiftUI

/// Pick, order and add to the keys on the bar above the keyboard.
struct KeyBarSettingsView: View {
    @ObservedObject private var store = KeyBarStore.shared
    @State private var addingSnippet = false

    var body: some View {
        List {
            Section {
                ForEach(store.keys) { key in
                    HStack {
                        Text(key.title).font(.body.monospaced()).frame(minWidth: 44, alignment: .leading)
                        Text(key.name).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                .onMove { store.keys.move(fromOffsets: $0, toOffset: $1) }
                .onDelete { store.keys.remove(atOffsets: $0) }
            } header: { Text("On the bar") } footer: {
                Text("Drag to reorder, swipe to remove. The bar scrolls sideways when the keys don't fit.")
            }

            Section("Add a key") {
                ForEach(missing, id: \.self) { kind in
                    Button { store.keys.append(BarKey(kind)) } label: {
                        HStack {
                            Text(BarKey(kind).title).font(.body.monospaced()).frame(minWidth: 44, alignment: .leading)
                            Text(BarKey(kind).name).foregroundStyle(.secondary)
                            Spacer()
                            Image(systemName: "plus.circle.fill").foregroundStyle(.green)
                        }
                    }
                    .tint(.primary)
                }
                Button { addingSnippet = true } label: {
                    Label("Add a snippet (a key that types text)", systemImage: "text.badge.plus")
                }
            }

            Section {
                Button("Reset to default keys", role: .destructive) { store.reset() }
            }
        }
        .environment(\.editMode, .constant(.active))
        .navigationTitle("Keyboard bar")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $addingSnippet) { SnippetSheet { store.keys.append($0) } }
    }

    private var missing: [BarKey.Kind] {
        let have = Set(store.keys.map(\.kind))
        return BarKey.Kind.allCases.filter { $0 != .snippet && !have.contains($0) }
    }
}

private struct SnippetSheet: View {
    let add: (BarKey) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var label = ""
    @State private var text = ""
    @State private var thenReturn = true

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Types, e.g. /clear", text: $text)
                    TextField("Key label (optional)", text: $label)
                    Toggle("Then press Return", isOn: $thenReturn)
                }
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.body.monospaced())
            }
            .navigationTitle("New snippet")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        add(BarKey(snippet: label.trimmingCharacters(in: .whitespaces), text: text, thenReturn: thenReturn))
                        dismiss()
                    }
                    .disabled(text.isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }
}
