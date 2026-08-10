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

const BrowserPane = forwardRef<BrowserHandle, Props>(function BrowserPane(
  { id, url, active, suppressed, onUrlChange, onClose },
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
  const syncBounds = useCallback(() => {
    if (pending.current !== null) return
    pending.current = requestAnimationFrame(() => {
      pending.current = null
      const slot = slotRef.current
      if (!slot) return
      const r = slot.getBoundingClientRect()
      void window.rippon.browser.setBounds(
        id,
        { x: r.left, y: r.top, width: r.width, height: r.height },
        visible && r.width >= 1 && r.height >= 1
      )
    })
  }, [id, visible])

  useEffect(() => {
    const slot = slotRef.current
    if (!slot) return
    syncBounds()
    const observer = new ResizeObserver(syncBounds)
    observer.observe(slot)
    // Resizing the window moves the slot without resizing it in some layouts,
    // and a scrolling tile grid moves it without any resize at all.
    window.addEventListener('resize', syncBounds)
    window.addEventListener('scroll', syncBounds, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', syncBounds)
      window.removeEventListener('scroll', syncBounds, true)
      if (pending.current !== null) cancelAnimationFrame(pending.current)
      pending.current = null
    }
  }, [syncBounds])

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
      <div className="webview-host" ref={slotRef} />
    </div>
  )
})

export default BrowserPane
