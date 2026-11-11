import UIKit
import SwiftTerm

/// Finds the web links on screen, underlines them, and opens one when tapped.
///
/// SwiftTerm only treats a plain URL as a link while a pointer hovers over it,
/// which never happens on a phone, so the screen is scanned here instead. A link
/// that runs into the right edge carries on at the start of the next row, the
/// way long URLs wrap in a terminal.
@MainActor
final class TerminalLinks: NSObject, UIGestureRecognizerDelegate {
    struct Link {
        let url: URL
        /// Screen cells it covers: (row, first col, last col) per row.
        let spans: [(row: Int, from: Int, to: Int)]
    }

    private weak var view: TerminalView?
    private let open: (URL) -> Void
    private let overlay = LinkOverlay()
    private let tap = UITapGestureRecognizer()
    private(set) var links: [Link] = []
    private var scanQueued = false

    init(view: TerminalView, open: @escaping (URL) -> Void) {
        self.view = view
        self.open = open
        super.init()
        overlay.isUserInteractionEnabled = false
        overlay.backgroundColor = .clear
        view.addSubview(overlay)
        tap.addTarget(self, action: #selector(tapped(_:)))
        tap.delegate = self
        tap.cancelsTouchesInView = false
        view.addGestureRecognizer(tap)
    }

    /// Call after the screen changes; scans at most a few times a second.
    func screenChanged() {
        guard !scanQueued else { return }
        scanQueued = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            MainActor.assumeIsolated {
                self?.scanQueued = false
                self?.scan()
            }
        }
    }

    private func scan() {
        guard let view else { return }
        let term = view.getTerminal()
        let rows = term.rows, cols = term.cols
        // One Character per cell, so a column is an index.
        var grid: [[Character]] = []
        grid.reserveCapacity(rows)
        for r in 0..<rows {
            var line: [Character] = []
            line.reserveCapacity(cols)
            for c in 0..<cols {
                let ch = term.getCharacter(col: c, row: r) ?? " "
                line.append(ch == "\u{0}" ? " " : ch)
            }
            grid.append(line)
        }

        var found: [Link] = []
        var r = 0
        while r < rows {
            var c = 0
            let line = grid[r]
            while c < cols {
                guard let start = Self.urlStart(in: line, at: c) else { c += 1; continue }
                var spans: [(row: Int, from: Int, to: Int)] = []
                var text = ""
                var row = r, col = start
                var ended = false
                while !ended {
                    let cells = grid[row]
                    var end = col
                    while end < cols, Self.isURLChar(cells[end]) { end += 1 }
                    text += String(cells[col..<end])
                    spans.append((row, col, end - 1))
                    // Wrapped: it ran to the edge and the next row goes straight on.
                    if end == cols, row + 1 < rows, let first = grid[row + 1].first, Self.isURLChar(first) {
                        row += 1
                        col = 0
                    } else {
                        ended = true
                        c = end
                    }
                }
                let trimmed = Self.trim(text)
                let cut = text.count - trimmed.count
                if cut > 0, var last = spans.popLast() {
                    last.to -= cut
                    if last.to >= last.from { spans.append(last) }
                }
                if let url = URL(string: trimmed), url.host != nil, !spans.isEmpty {
                    found.append(Link(url: url, spans: spans))
                }
                if row > r { r = row; break }
            }
            r += 1
        }
        links = found
        draw()
    }

    private func draw() {
        guard let view else { return }
        let size = TerminalScroller.cellSize(of: view)
        overlay.frame = view.bounds
        overlay.lines = links.flatMap { l in
            l.spans.map { s in
                CGRect(x: CGFloat(s.from) * size.width, y: CGFloat(s.row + 1) * size.height - 1.5,
                       width: CGFloat(s.to - s.from + 1) * size.width, height: 1)
            }
        }
        view.bringSubviewToFront(overlay)
    }

    private func link(at p: CGPoint) -> Link? {
        guard let view else { return nil }
        let size = TerminalScroller.cellSize(of: view)
        let row = Int((p.y - view.bounds.minY) / size.height)
        let col = Int(p.x / size.width)
        return links.first { $0.spans.contains { $0.row == row && col >= $0.from - 1 && col <= $0.to + 1 } }
    }

    // MARK: Tapping

    func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        guard let view else { return false }
        return link(at: g.location(in: view)) != nil
    }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        true
    }

    @objc private func tapped(_ g: UITapGestureRecognizer) {
        guard let view, let l = link(at: g.location(in: view)) else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        open(l.url)
    }

    // MARK: Spotting URLs

    private static let schemes: [[Character]] = [Array("https://"), Array("http://")]

    private static func urlStart(in line: [Character], at c: Int) -> Int? {
        for s in schemes where c + s.count <= line.count && Array(line[c..<(c + s.count)]) == s {
            if c > 0, line[c - 1].isLetter || line[c - 1].isNumber { return nil }
            return c
        }
        return nil
    }

    private static func isURLChar(_ ch: Character) -> Bool {
        guard ch.isASCII, let a = ch.asciiValue, a > 32, a < 127 else { return false }
        return !"<>\"'`{}|\\^".contains(ch)
    }

    /// Drops punctuation that ends a sentence rather than the link, and a
    /// closing bracket that has no opening one in the link.
    private static func trim(_ s: String) -> String {
        var s = Substring(s)
        while let last = s.last {
            if ".,;:!?*".contains(last) { s.removeLast(); continue }
            if last == ")", s.filter({ $0 == "(" }).count < s.filter({ $0 == ")" }).count { s.removeLast(); continue }
            if last == "]", s.filter({ $0 == "[" }).count < s.filter({ $0 == "]" }).count { s.removeLast(); continue }
            break
        }
        return String(s)
    }
}

/// Draws the underlines; passes every touch through.
final class LinkOverlay: UIView {
    var lines: [CGRect] = [] { didSet { setNeedsDisplay() } }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        contentMode = .redraw
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func draw(_ rect: CGRect) {
        UIColor.systemBlue.withAlphaComponent(0.9).setFill()
        for l in lines { UIRectFill(l) }
    }
}
