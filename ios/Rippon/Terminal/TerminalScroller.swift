import UIKit
import UIKit.UIGestureRecognizerSubclass
import SwiftTerm

/// One-finger scrolling for a terminal attached to tmux.
///
/// tmux draws on the alternate screen, so the terminal view has no scrollback
/// of its own to scroll — the history is tmux's. A vertical drag is therefore
/// turned into scrolling *on the host* (see `TerminalController.scroll`), and a
/// flick keeps going with a little momentum, like any iOS list.
///
/// Selecting is press, hold and drag: the word under the finger is picked first,
/// then the selection follows the finger from where it came down, and letting go
/// shows Copy. A tap clears it. This selects what is on screen locally, so it
/// works the same whether or not tmux's mouse mode is on.
@MainActor
final class TerminalScroller: NSObject, UIGestureRecognizerDelegate {
    /// A hold this long before moving means "select", not "scroll".
    static let holdToSelect: CFTimeInterval = 0.3

    private weak var view: TerminalView?
    private let onScroll: (_ lines: Int, _ at: CGPoint) -> Void
    private let pan = HoldAwarePan()
    private let press = UILongPressGestureRecognizer()
    private let clearTap = UITapGestureRecognizer()
    private var anchor: Position?
    /// While a selection end is being dragged: the end that stays put.
    private var dragging: Position?
    private var anchorPoint: CGPoint = .zero
    private var residual: CGFloat = 0
    private var lastPoint: CGPoint = .zero

    private var link: CADisplayLink?
    private var velocity: CGFloat = 0
    private var lastTick: CFTimeInterval = 0

    init(view: TerminalView, onScroll: @escaping (_ lines: Int, _ at: CGPoint) -> Void) {
        self.view = view
        self.onScroll = onScroll
        super.init()
        pan.addTarget(self, action: #selector(handle(_:)))
        pan.maximumNumberOfTouches = 1
        pan.delegate = self
        view.addGestureRecognizer(pan)

        // SwiftTerm's own long press only offers "Select", which picks one word
        // and cannot be dragged; this one replaces it.
        for g in view.gestureRecognizers ?? [] where g is UILongPressGestureRecognizer {
            g.isEnabled = false
        }
        press.addTarget(self, action: #selector(handlePress(_:)))
        press.minimumPressDuration = TerminalScroller.holdToSelect
        press.allowableMovement = 12
        press.delegate = self
        view.addGestureRecognizer(press)

        clearTap.addTarget(self, action: #selector(handleTap(_:)))
        clearTap.cancelsTouchesInView = false
        clearTap.delegate = self
        view.addGestureRecognizer(clearTap)
    }

    private var lineHeight: CGFloat {
        guard let view else { return 16 }
        let rows = max(1, view.getTerminal().rows)
        return max(4, view.bounds.height / CGFloat(rows))
    }

    // MARK: Gesture arbitration

    func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        guard g === pan else { return true }
        dragging = nil
        // A drag that starts on either end of the selection moves that end.
        if let view, view.hasActiveSelection {
            let at = cell(at: pan.location(in: view))
            let sel = view.selection!
            let (lo, hi) = Position.compare(sel.start, sel.end) == .before ? (sel.start, sel.end) : (sel.end, sel.start)
            if near(at, hi) { dragging = lo; return true }
            if near(at, lo) { dragging = hi; return true }
        }
        if let started = pan.touchStartedAt, CACurrentMediaTime() - started > TerminalScroller.holdToSelect {
            return false
        }
        let v = pan.velocity(in: pan.view)
        return abs(v.y) >= abs(v.x)
    }

    /// Every other drag on the terminal — SwiftTerm's selection and mouse drags,
    /// and the scroll view's own pan — waits to see whether scrolling or
    /// selecting wants it.
    func gestureRecognizer(_ g: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
        (g === pan || g === press) && other is UIPanGestureRecognizer && other !== pan && other.view === pan.view
    }

    /// The clearing tap rides alongside SwiftTerm's own taps (focus, clicks).
    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        g === clearTap || other === clearTap
    }

    // MARK: Selecting

    /// The size of one cell, worked out the way SwiftTerm does.
    private var cellSize: CGSize {
        guard let view else { return CGSize(width: 8, height: 16) }
        let font = view.font
        let scale = view.window?.screen.scale ?? UIScreen.main.scale
        let w = "W".size(withAttributes: [.font: font]).width
        let h = font.ascender - font.descender + font.leading
        return CGSize(width: max(1, (w * scale).rounded() / scale),
                      height: max(1, ceil(ceil(h) * scale) / scale))
    }

    /// The buffer cell under a point in the view's content coordinates.
    private func cell(at p: CGPoint) -> Position {
        guard let view else { return Position(col: 0, row: 0) }
        let term = view.getTerminal()
        let size = cellSize
        let col = min(max(0, Int(p.x / size.width)), term.cols - 1)
        let row = min(max(0, Int(p.y / size.height)), max(0, term.buffer.yDisp + term.rows - 1))
        return Position(col: col, row: row)
    }

    /// Within reach of a fingertip: a couple of cells either way.
    private func near(_ a: Position, _ b: Position) -> Bool {
        abs(a.row - b.row) <= 1 && abs(a.col - b.col) <= 3
    }

    @objc private func handlePress(_ g: UILongPressGestureRecognizer) {
        guard let view else { return }
        let p = g.location(in: view)
        switch g.state {
        case .began:
            stopMomentum()
            UIMenuController.shared.hideMenu()
            let c = cell(at: p)
            anchor = c
            anchorPoint = p
            view.selection.selectWordOrExpression(at: c, in: view.getTerminal().buffer)
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case .changed:
            guard let a = anchor else { return }
            let c = cell(at: p)
            if c != a || view.selection.selectionMode != .word {
                view.selection.selectionMode = .character
                view.setSelectionRange(start: a, end: c)
            }
        case .ended:
            anchor = nil
            if view.hasActiveSelection {
                // Above the higher of the two ends, so the menu doesn't cover it.
                view.showStandardContextMenu(at: p.y < anchorPoint.y ? p : anchorPoint)
            }
        default:
            anchor = nil
        }
    }

    @objc private func handleTap(_ g: UITapGestureRecognizer) {
        clearSelection()
    }

    /// Drops the selection and its menu, before scrolling or typing changes
    /// what is under it.
    func clearSelection() {
        guard let view, view.hasActiveSelection else { return }
        view.clearSelection()
        UIMenuController.shared.hideMenu()
    }

    // MARK: Scrolling

    @objc private func handle(_ g: UIPanGestureRecognizer) {
        guard let view else { return }
        switch g.state {
        case .began where dragging != nil:
            stopMomentum()
            UIMenuController.shared.hideMenu()
        case .changed where dragging != nil:
            view.selection.selectionMode = .character
            view.setSelectionRange(start: dragging!, end: cell(at: g.location(in: view)))
        case .ended where dragging != nil, .cancelled where dragging != nil:
            dragging = nil
            if view.hasActiveSelection { view.showStandardContextMenu(at: g.location(in: view)) }
        case .began:
            stopMomentum()
            clearSelection()
            residual = 0
            g.setTranslation(.zero, in: view)
        case .changed:
            lastPoint = g.location(in: view)
            let dy = g.translation(in: view).y
            g.setTranslation(.zero, in: view)
            move(by: dy)
        case .ended:
            startMomentum(g.velocity(in: view).y)
        default:
            break
        }
    }

    /// Dragging down reveals what is above: older history.
    private func move(by dy: CGFloat) {
        residual += dy
        let lines = Int(residual / lineHeight)
        guard lines != 0 else { return }
        residual -= CGFloat(lines) * lineHeight
        onScroll(lines, lastPoint)
    }

    private func startMomentum(_ v: CGFloat) {
        guard abs(v) > 300 else { return }
        velocity = v
        lastTick = CACurrentMediaTime()
        let l = CADisplayLink(target: self, selector: #selector(tick(_:)))
        l.add(to: .main, forMode: .common)
        link = l
    }

    @objc private func tick(_ l: CADisplayLink) {
        let now = CACurrentMediaTime()
        let dt = CGFloat(now - lastTick)
        lastTick = now
        move(by: velocity * dt)
        velocity *= pow(0.05, dt) // loses 95% of its speed per second
        if abs(velocity) < 60 { stopMomentum() }
    }

    func stopMomentum() {
        link?.invalidate()
        link = nil
    }
}

/// A pan that remembers when the finger came down, so a press-and-hold can be
/// told apart from a drag that starts at once.
final class HoldAwarePan: UIPanGestureRecognizer {
    private(set) var touchStartedAt: CFTimeInterval?

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        if touchStartedAt == nil || state == .possible && numberOfTouches == 0 {
            touchStartedAt = CACurrentMediaTime()
        }
        super.touchesBegan(touches, with: event)
    }

    override func reset() {
        super.reset()
        touchStartedAt = nil
    }
}
