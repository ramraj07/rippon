import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { BrowserState } from '@shared/types'

export interface BrowserHandle {
  navigate(url: string): void
  focusAddress(): void
  reload(): void
}

interface Props {
  /** Identifies the main-process view. The tmux session name. */
  id: string
  url: string
  active: boolean
  /**
   * A WebContentsView paints above the page, so anything overlaying the app —
   * a modal, a context menu — has to hide it.
   */
  suppressed: boolean
  /** The active view's zoom. Re-applied on navigation, since it lives per origin. */
  zoom: number
  onUrlChange(url: string): void
  onClose(): void
}

/** Turn whatever the user typed into something loadable. */
export function toUrl(input: string): string {
  const text = input.trim()
  if (!text) return 'about:blank'
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text
  const looksLikeHost =
    /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(text) || text.startsWith('localhost')
  if (looksLikeHost) return `https://${text}`
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`
}

/**
 * A native view has no CSS clipping: it is not confined to a scrolling
 * container and not clipped by the window. A pane scrolled below the fold of a
 * tile grid was therefore positioned off-window at full size, which paints over
 * anything in the way and — as it turns out — leaves the guest spinning.
 * Intersect the slot with everything that clips it and hand over that.
 */
function clippedRect(slot: HTMLElement): { x: number; y: number; width: number; height: number } {
  const r = slot.getBoundingClientRect()
  let left = r.left
  let top = r.top
  let right = r.right
  let bottom = r.bottom

  for (let el = slot.parentElement; el; el = el.parentElement) {
    if (getComputedStyle(el).overflow === 'visible') continue
    const c = el.getBoundingClientRect()
    left = Math.max(left, c.left)
    top = Math.max(top, c.top)
    right = Math.min(right, c.right)
    bottom = Math.min(bottom, c.bottom)
  }

  left = Math.max(left, 0)
  top = Math.max(top, 0)
  right = Math.min(right, window.innerWidth)
  bottom = Math.min(bottom, window.innerHeight)

  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(Math.max(0, right - left)),
    height: Math.round(Math.max(0, bottom - top))
  }
}

const BrowserPane = forwardRef<BrowserHandle, Props>(function BrowserPane(
  { id, url, active, suppressed, zoom, onUrlChange, onClose },
  ref
) {
  const slotRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  /** Where the view actually is, so we don't fight the address bar while typing. */
  const currentUrlRef = useRef(url)
  const editingRef = useRef(false)
  const [address, setAddress] = useState(url)
  const [state, setState] = useState<BrowserState | null>(null)

  const visible = active && !suppressed

  function navigate(target: string): void {
    const next = toUrl(target)
    currentUrlRef.current = next
    setAddress(next)
    void window.rippon.browser.navigate(id, next)
    onUrlChange(next)
  }

  useImperativeHandle(ref, () => ({
    navigate,
    focusAddress: () => {
      // The view may hold keyboard focus; take it back before focusing the input.
      void window.rippon.focusPage().then(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    },
    reload: () => void window.rippon.browser.reload(id)
  }))

  // Create the view on mount, tear it down when the pane closes.
  useEffect(() => {
    void window.rippon.browser.ensure(id, currentUrlRef.current)
    return () => {
      void window.rippon.browser.destroy(id)
    }
  }, [id])

  /**
   * The view has no layout of its own — the renderer measures this placeholder
   * and pushes the rectangle across. Coalesced to a frame so a splitter drag
   * does not flood the IPC channel.
   */
  const pending = useRef<number | null>(null)
  /** Last rectangle actually sent, so an unchanged one costs no IPC. */
  const lastSent = useRef('')

  const syncBounds = useCallback(() => {
    if (pending.current !== null) return
    pending.current = requestAnimationFrame(() => {
      pending.current = null
      const slot = slotRef.current
      if (!slot) return
      const bounds = clippedRect(slot)
      // Scrolled out of the grid, or hidden: nothing to show, so show nothing.
      const showing = visible && bounds.width >= 1 && bounds.height >= 1
      const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height},${showing}`
      if (key === lastSent.current) return
      lastSent.current = key
      void window.rippon.browser.setBounds(id, bounds, showing, zoom)
    })
  }, [id, visible, zoom])

  useEffect(() => {
    const slot = slotRef.current
    if (!slot) return
    syncBounds()

    const observer = new ResizeObserver(syncBounds)
    observer.observe(slot)
    window.addEventListener('resize', syncBounds)

    /*
     * Scrolling moves the pane without resizing it, so it has to be watched —
     * but only where it can actually happen. A capture listener on window sees
     * every scroll in the app, including the terminal viewport, which scrolls
     * on every line an agent prints. That turned agent output into a per-frame
     * forced layout plus an IPC round trip per pane.
     */
    const scrollers: EventTarget[] = []
    for (let el = slot.parentElement; el; el = el.parentElement) {
      const overflow = getComputedStyle(el).overflow
      if (overflow.includes('auto') || overflow.includes('scroll')) scrollers.push(el)
    }
    for (const target of scrollers) target.addEventListener('scroll', syncBounds, { passive: true })

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', syncBounds)
      for (const target of scrollers) target.removeEventListener('scroll', syncBounds)
      if (pending.current !== null) cancelAnimationFrame(pending.current)
      pending.current = null
    }
  }, [syncBounds])

  // Zoom travels with the bounds, so the main process can apply it first — see
  // applyZoom there. A resize that shrank the pane before scaling the page down
  // let it lay out narrow for a frame, which was enough to wedge it.
  useEffect(() => {
    lastSent.current = ''
    syncBounds()
  }, [zoom, syncBounds])

  // Track navigation happening inside the view.
  useEffect(() => {
    return window.rippon.browser.onState((viewId, next) => {
      if (viewId !== id) return
      setState(next)
      if (next.url && next.url !== currentUrlRef.current) {
        currentUrlRef.current = next.url
        if (!editingRef.current) setAddress(next.url)
        onUrlChange(next.url)
      }
    })
  }, [id, onUrlChange])

  // Follow config changes (external edits, or a link clicked in the terminal).
  useEffect(() => {
    if (url === currentUrlRef.current) return
    currentUrlRef.current = url
    setAddress(url)
    void window.rippon.browser.navigate(id, url)
  }, [id, url])

  const loading = state?.loading ?? false

  return (
    <div className="pane browser-pane">
      <div className="pane-header">
        <button
          className="icon-btn"
          disabled={!state?.canGoBack}
          title="Back"
          onClick={() => void window.rippon.browser.back(id)}
        >
          ‹
        </button>
        <button
          className="icon-btn"
          disabled={!state?.canGoForward}
          title="Forward"
          onClick={() => void window.rippon.browser.forward(id)}
        >
          ›
        </button>
        <button
          className="icon-btn"
          title="Reload (⌘R)"
          onClick={() =>
            void (loading ? window.rippon.browser.stop(id) : window.rippon.browser.reload(id))
          }
        >
          {loading ? '×' : '⟳'}
        </button>
        <form
          className="address-form"
          onSubmit={(e) => {
            e.preventDefault()
            navigate(address)
            inputRef.current?.blur()
          }}
        >
          <input
            ref={inputRef}
            className="address-input"
            value={address}
            spellCheck={false}
            placeholder="Enter a URL or search…"
            onFocus={() => (editingRef.current = true)}
            onBlur={() => (editingRef.current = false)}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setAddress(currentUrlRef.current)
                inputRef.current?.blur()
              }
            }}
          />
        </form>
        <button
          className="icon-btn"
          title="Open in system browser"
          onClick={() => void window.rippon.openExternal(currentUrlRef.current)}
        >
          ↗
        </button>
        <button className="icon-btn" title="Close browser pane" onClick={onClose}>
          ×
        </button>
      </div>
      {state?.crashed || state?.hung ? (
        <div className="hung-bar">
          {state.crashed
            ? `This page crashed (${state.crashed}).`
            : 'This page has stopped responding and will not redraw or resize.'}
          <button onClick={() => void window.rippon.browser.reload(id)}>reload</button>
        </div>
      ) : null}
      <div className="webview-host" ref={slotRef} />
    </div>
  )
})

export default BrowserPane
