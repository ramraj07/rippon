import SwiftUI
import WebKit

struct BrowserPane: View {
    @ObservedObject var controller: BrowserController
    let session: String
    @EnvironmentObject var workspace: Workspace
    @State private var address = ""
    @State private var editing = false
    @FocusState private var addressFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .top) {
                WebViewHost(webView: controller.webView)
                if controller.loading {
                    ProgressView(value: controller.progress).progressViewStyle(.linear).tint(.accentColor)
                }
                if let error = controller.error {
                    Text(error)
                        .font(.footnote)
                        .padding(10)
                        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 8))
                        .padding()
                }
            }
            Divider()
            toolbar
        }
        .onAppear { address = controller.url }
        .onChange(of: controller.url) { _, u in if !editing { address = u } }
    }

    private var toolbar: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: controller.url.hasPrefix("https") ? "lock.fill" : "globe")
                    .foregroundStyle(.secondary).font(.caption)
                TextField("Search or enter address", text: $address, onEditingChanged: { editing = $0 })
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.webSearch)
                    .submitLabel(.go)
                    .focused($addressFocused)
                    .onSubmit {
                        controller.navigate(address)
                        addressFocused = false
                    }
                if controller.loading {
                    Button { controller.webView.stopLoading() } label: { Image(systemName: "xmark") }
                } else {
                    Button { controller.webView.reload() } label: { Image(systemName: "arrow.clockwise") }
                        .keyboardShortcut("r", modifiers: .command)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: 10))

            HStack {
                Button { controller.webView.goBack() } label: { Image(systemName: "chevron.backward") }
                    .disabled(!controller.canGoBack)
                Spacer()
                Button { controller.webView.goForward() } label: { Image(systemName: "chevron.forward") }
                    .disabled(!controller.canGoForward)
                Spacer()
                BookmarksMenu(controller: controller, session: session)
                Spacer()
                if let u = URL(string: controller.url), u.scheme?.hasPrefix("http") == true {
                    ShareLink(item: u) { Image(systemName: "square.and.arrow.up") }
                } else {
                    Image(systemName: "square.and.arrow.up").foregroundStyle(.tertiary)
                }
                Spacer()
                Button {
                    if let u = URL(string: controller.url) { UIApplication.shared.open(u) }
                } label: { Image(systemName: "safari") }
            }
            .font(.title3)
            .padding(.horizontal, 8)
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 4)
        .background(.bar)
    }
}

/// Bookmarks, both kinds the desktop keeps: pages saved for this session only
/// (its PR, its dashboard), and pages saved for every session.
struct BookmarksMenu: View {
    @ObservedObject var controller: BrowserController
    let session: String
    @EnvironmentObject var workspace: Workspace

    var body: some View {
        let mine = workspace.profile?.sessionBookmarks(session) ?? []
        let all = workspace.profile?.bookmarks ?? []
        let current = controller.url
        Menu {
            if !mine.isEmpty {
                Section("This session") {
                    ForEach(mine) { b in Button(b.title) { controller.navigate(b.url) } }
                }
            }
            if !all.isEmpty {
                Section("All sessions") {
                    ForEach(all) { b in Button(b.title) { controller.navigate(b.url) } }
                }
            }
            if current.lowercased().hasPrefix("http") {
                Section {
                    if mine.contains(where: { $0.url == current }) {
                        Button(role: .destructive) {
                            workspace.edit { p in p.setSessionBookmarks(p.sessionBookmarks(session).filter { $0.url != current }, for: session) }
                        } label: { Label("Remove from this session", systemImage: "bookmark.slash") }
                    } else {
                        Button {
                            let b = Bookmark(title: controller.title, url: current)
                            workspace.edit { p in p.setSessionBookmarks(p.sessionBookmarks(session).filter { $0.url != b.url } + [b], for: session) }
                        } label: { Label("Bookmark for this session", systemImage: "bookmark") }
                    }
                    if all.contains(where: { $0.url == current }) {
                        Button(role: .destructive) {
                            workspace.edit { p in p.bookmarks = p.bookmarks.filter { $0.url != current } }
                        } label: { Label("Remove from all sessions", systemImage: "bookmark.slash") }
                    } else {
                        Button {
                            let b = Bookmark(title: controller.title, url: current)
                            workspace.edit { p in p.bookmarks = p.bookmarks.filter { $0.url != b.url } + [b] }
                        } label: { Label("Bookmark for all sessions", systemImage: "books.vertical") }
                    }
                }
            }
        } label: {
            Image(systemName: mine.contains(where: { $0.url == current }) || all.contains(where: { $0.url == current }) ? "bookmark.fill" : "bookmark")
        }
    }
}

struct WebViewHost: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
