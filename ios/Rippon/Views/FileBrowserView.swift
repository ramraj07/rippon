import SwiftUI

/// The host's files — preview text and images, and download anything to the
/// share sheet (Save to Files, AirDrop, …).
struct FileBrowserView: View {
    @EnvironmentObject var workspace: Workspace
    @Environment(\.dismiss) private var dismiss
    @State private var path = "~"
    @State private var typed = "~"
    @State private var listing: RemoteListing?
    @State private var error: String?
    @State private var loading = false
    @State private var previewing: RemoteEntry?

    var body: some View {
        List {
            Section {
                HStack {
                    TextField("Path", text: $typed)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .font(.callout.monospaced())
                        .onSubmit { open(typed) }
                    if loading { ProgressView() }
                }
                if let l = listing, l.path != "/" {
                    Button { open((l.path as NSString).deletingLastPathComponent) } label: {
                        Label("..", systemImage: "arrow.turn.left.up")
                    }
                }
            }
            if let error {
                Text(error).font(.footnote.monospaced()).foregroundStyle(.red)
            }
            if let l = listing {
                Section {
                    ForEach(l.entries) { e in
                        Button {
                            if e.isDir { open(join(l.path, e.name)) } else { previewing = e }
                        } label: {
                            HStack {
                                Image(systemName: e.isDir ? "folder.fill" : e.kind == .link ? "link" : "doc")
                                    .foregroundStyle(e.isDir ? Color.accentColor : Color.secondary)
                                    .frame(width: 22)
                                Text(e.name).foregroundStyle(.primary).lineLimit(1)
                                Spacer()
                                if !e.isDir {
                                    Text(ByteCountFormatter.string(fromByteCount: Int64(e.size), countStyle: .file))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                } footer: {
                    if l.truncated { Text("Showing the first 5,000 entries.") }
                }
            }
        }
        .navigationTitle(listing.map { ($0.path as NSString).lastPathComponent } ?? "Files")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
            ToolbarItem(placement: .primaryAction) {
                Button { open(path) } label: { Image(systemName: "arrow.clockwise") }
            }
        }
        .refreshable { await load(path) }
        .task { await load(path) }
        .sheet(item: $previewing) { e in
            NavigationStack { FilePreviewView(path: join(listing?.path ?? path, e.name)) }
        }
    }

    private func join(_ dir: String, _ name: String) -> String {
        dir.hasSuffix("/") ? dir + name : dir + "/" + name
    }

    private func open(_ p: String) {
        Task { await load(p) }
    }

    private func load(_ p: String) async {
        guard let c = workspace.connection else { error = "Not connected."; return }
        loading = true
        defer { loading = false }
        do {
            let l = try await RemoteFiles.list(c, path: p)
            listing = l
            path = l.path
            typed = l.path
            error = nil
        } catch {
            self.error = describe(error)
        }
    }
}

struct FilePreviewView: View {
    let path: String
    @EnvironmentObject var workspace: Workspace
    @Environment(\.dismiss) private var dismiss
    @State private var preview: RemotePreview?
    @State private var error: String?
    @State private var downloaded: URL?
    @State private var progress: Int?

    var body: some View {
        Group {
            if let preview {
                switch preview.kind {
                case .text(let s):
                    ScrollView([.vertical, .horizontal]) {
                        Text(s).font(.caption.monospaced()).textSelection(.enabled).padding()
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                case .image(let data):
                    if let img = UIImage(data: data) {
                        ScrollView([.vertical, .horizontal]) { Image(uiImage: img).resizable().scaledToFit() }
                    } else {
                        ContentUnavailableView("Can't show this image", systemImage: "photo")
                    }
                case .binary:
                    ContentUnavailableView("Binary file", systemImage: "doc.zipper",
                                           description: Text("Download it to open it in another app."))
                }
            } else if let error {
                Text(error).font(.footnote.monospaced()).foregroundStyle(.red).padding()
            } else {
                ProgressView()
            }
        }
        .safeAreaInset(edge: .bottom) {
            if let p = preview, p.truncated {
                Text("Showing the first 256 KB of \(ByteCountFormatter.string(fromByteCount: Int64(p.size), countStyle: .file)).")
                    .font(.caption).padding(8).frame(maxWidth: .infinity).background(.bar)
            }
        }
        .navigationTitle((path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            ToolbarItem(placement: .primaryAction) {
                if let downloaded {
                    ShareLink(item: downloaded) { Image(systemName: "square.and.arrow.up") }
                } else if let progress {
                    Text(ByteCountFormatter.string(fromByteCount: Int64(progress), countStyle: .file)).font(.caption)
                } else {
                    Button { download() } label: { Image(systemName: "arrow.down.circle") }
                }
            }
        }
        .task {
            guard let c = workspace.connection else { error = "Not connected."; return }
            do { preview = try await RemoteFiles.preview(c, path: path) } catch { self.error = describe(error) }
        }
    }

    private func download() {
        guard let c = workspace.connection else { return }
        progress = 0
        Task {
            do {
                downloaded = try await RemoteFiles.download(c, path: path) { n in
                    Task { @MainActor in progress = n }
                }
            } catch {
                self.error = describe(error)
                progress = nil
            }
        }
    }
}
