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
/// Selecting still works: press and hold for a moment before dragging, and the
/// drag goes to the terminal as before (tmux's own selection when its mouse mode
/// is on). Holding still longer brings up the copy/paste menu.
@MainActor
final class TerminalScroller: NSObject, UIGestureRecognizerDelegate {
    /// A hold this long before moving means "select", not "scroll".
    static let holdToSelect: CFTimeInterval = 0.3

    private weak var view: TerminalView?
    private let onScroll: (_ lines: Int, _ at: CGPoint) -> Void
    private let pan = HoldAwarePan()
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
    }

    private var lineHeight: CGFloat {
        guard let view else { return 16 }
        let rows = max(1, view.getTerminal().rows)
        return max(4, view.bounds.height / CGFloat(rows))
    }

    // MARK: Gesture arbitration

    func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        guard g === pan else { return true }
        if let started = pan.touchStartedAt, CACurrentMediaTime() - started > TerminalScroller.holdToSelect {
            return false
        }
        let v = pan.velocity(in: pan.view)
        return abs(v.y) >= abs(v.x)
    }

    /// Every other drag on the terminal — SwiftTerm's selection and mouse drags,
    /// and the scroll view's own pan — waits to see whether this one wants it.
    func gestureRecognizer(_ g: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
        g === pan && other is UIPanGestureRecognizer && other.view === pan.view
    }

    // MARK: Scrolling

    @objc private func handle(_ g: UIPanGestureRecognizer) {
        guard let view else { return }
        switch g.state {
        case .began:
            stopMomentum()
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
