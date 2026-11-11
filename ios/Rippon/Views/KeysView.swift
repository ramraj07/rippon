import SwiftUI
import UniformTypeIdentifiers

struct KeysView: View {
    @EnvironmentObject var keys: KeyStore
    @State private var generating = false
    @State private var importing = false
    @State private var copied: String?

    var body: some View {
        List {
            Section {
                ForEach(keys.keys) { k in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(k.name).font(.headline)
                            Text(k.type).font(.caption).padding(.horizontal, 6).padding(.vertical, 2)
                                .background(.quaternary, in: Capsule())
                        }
                        if !k.publicKey.isEmpty {
                            Text(k.publicKey).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(2)
                            Button {
                                UIPasteboard.general.string = k.publicKey
                                copied = k.id
                            } label: {
                                Label(copied == k.id ? "Copied" : "Copy public key", systemImage: copied == k.id ? "checkmark" : "doc.on.doc")
                            }
                            .font(.footnote)
                            .buttonStyle(.borderless)
                        }
                    }
                    .padding(.vertical, 4)
                }
                .onDelete { idx in idx.map { keys.keys[$0].id }.forEach(keys.delete) }
            } footer: {
                Text("Private keys stay in this iPhone's Keychain and never leave it. Add a key's public half to ~/.ssh/authorized_keys on the host. ed25519 is recommended: RSA keys sign with SHA-1, which recent OpenSSH servers refuse by default.")
            }
        }
        .navigationTitle("SSH keys")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button { generating = true } label: { Label("Generate ed25519 key", systemImage: "wand.and.stars") }
                    Button { importing = true } label: { Label("Import private key", systemImage: "square.and.arrow.down") }
                } label: { Image(systemName: "plus") }
            }
        }
        .sheet(isPresented: $generating) {
            NameSheet(title: "Generate key", prompt: "Key name, e.g. iphone", initial: "rippon-iphone", action: "Generate") { name in
                let info = keys.generate(name: name)
                UIPasteboard.general.string = info.publicKey
                copied = info.id
            }
        }
        .sheet(isPresented: $importing) { ImportKeyView() }
    }
}

struct ImportKeyView: View {
    @EnvironmentObject var keys: KeyStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var text = ""
    @State private var passphrase = ""
    @State private var error: String?
    @State private var picking = false

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $name)
                Section {
                    TextEditor(text: $text)
                        .font(.caption.monospaced())
                        .frame(minHeight: 160)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Choose a file…") { picking = true }
                } header: { Text("Private key") } footer: {
                    Text("Paste the contents of a file like ~/.ssh/id_ed25519 — it starts with -----BEGIN OPENSSH PRIVATE KEY-----.")
                }
                SecureField("Passphrase (if it has one)", text: $passphrase)
                if let error { Text(error).foregroundStyle(.red).font(.footnote) }
            }
            .navigationTitle("Import key")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Import") {
                        do {
                            try keys.importKey(name: name, text: text, passphrase: passphrase)
                            dismiss()
                        } catch {
                            self.error = describe(error)
                        }
                    }
                    .disabled(text.isEmpty)
                }
            }
            .fileImporter(isPresented: $picking, allowedContentTypes: [.data, .text, .item]) { result in
                guard case .success(let url) = result else { return }
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                if let s = try? String(contentsOf: url, encoding: .utf8) {
                    text = s
                    if name.isEmpty { name = url.lastPathComponent }
                } else {
                    error = "That file is not a text key file."
                }
            }
        }
    }
}
