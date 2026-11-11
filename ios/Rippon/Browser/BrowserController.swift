import UIKit
import WebKit

/// The browser pane for one session — where the PRs its agent opens get read.
/// Every session shares one persistent website data store, so a GitHub login
/// done in any pane holds for all of them and across launches.
@MainActor
final class BrowserController: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
    let webView: WKWebView
    @Published var url: String = ""
    @Published var title: String = ""
    @Published var loading = false
    @Published var progress: Double = 0
    @Published var canGoBack = false
    @Published var canGoForward = false
    @Published var error: String?

    /// Where the page settled, for saving to the profile.
    var onNavigate: ((String) -> Void)?

    private var observers: [NSKeyValueObservation] = []
    private var loadedOnce = false

    init(initialURL: String) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = true
        webView.isInspectable = true
        url = initialURL
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        observers = [
            webView.observe(\.estimatedProgress) { [weak self] wv, _ in
                MainActor.assumeIsolated { self?.progress = wv.estimatedProgress }
            },
            webView.observe(\.isLoading) { [weak self] wv, _ in
                MainActor.assumeIsolated { self?.loading = wv.isLoading }
            },
            webView.observe(\.canGoBack) { [weak self] wv, _ in
                MainActor.assumeIsolated { self?.canGoBack = wv.canGoBack }
            },
            webView.observe(\.canGoForward) { [weak self] wv, _ in
                MainActor.assumeIsolated { self?.canGoForward = wv.canGoForward }
            },
            webView.observe(\.title) { [weak self] wv, _ in
                MainActor.assumeIsolated { self?.title = wv.title ?? "" }
            },
            webView.observe(\.url) { [weak self] wv, _ in
                MainActor.assumeIsolated {
                    if let u = wv.url?.absoluteString { self?.url = u }
                }
            }
        ]
    }

    /// Load the saved page the first time the pane is shown, not before — a web
    /// view per session is not free.
    func loadIfNeeded() {
        guard !loadedOnce else { return }
        loadedOnce = true
        navigate(url)
    }

    /// What the address bar does with whatever was typed: a URL, a bare host, or a search.
    func navigate(_ input: String) {
        loadedOnce = true
        guard let target = BrowserController.resolve(input) else { return }
        error = nil
        webView.load(URLRequest(url: target))
    }

    static func resolve(_ input: String) -> URL? {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if let u = URL(string: text), let scheme = u.scheme?.lowercased(), ["http", "https", "about"].contains(scheme) { return u }
        let looksLikeHost = !text.contains(" ") && (text.contains(".") || text.hasPrefix("localhost"))
        if looksLikeHost {
            let scheme = text.hasPrefix("localhost") || text.hasPrefix("127.") ? "http" : "https"
            return URL(string: "\(scheme)://\(text)")
        }
        var c = URLComponents(string: "https://www.google.com/search")!
        c.queryItems = [URLQueryItem(name: "q", value: text)]
        return c.url
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if let u = webView.url?.absoluteString, u.lowercased().hasPrefix("http") { onNavigate?(u) }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        report(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        report(error)
    }

    private func report(_ error: Error) {
        let e = error as NSError
        if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return }
        self.error = e.localizedDescription
    }

    /// target=_blank links open in this same pane rather than vanishing.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil { webView.load(navigationAction.request) }
        return nil
    }
}
