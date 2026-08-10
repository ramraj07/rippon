import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Webview, type WebviewElement } from './webview'

export interface BrowserHandle {
  navigate(url: string): void
  focusAddress(): void
  reload(): void
}

interface Props {
  url: string
  active: boolean
  onUrlChange(url: string): void
  onClose(): void
}

/** Turn whatever the user typed into something loadable. */
export function toUrl(input: string): string {
  const text = input.trim()
  if (!text) return 'about:blank'
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text
  const looksLikeHost = /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(text) || text.startsWith('localhost')
  if (looksLikeHost) return `https://${text}`
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`
}

const BrowserPane = forwardRef<BrowserHandle, Props>(function BrowserPane(
  { url, active, onUrlChange, onClose },
  ref
) {
  const viewRef = useRef<WebviewElement | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  /** Where the webview actually is, so we don't fight the address bar while typing. */
  const currentUrlRef = useRef(url)
  const [address, setAddress] = useState(url)
  const [loading, setLoading] = useState(false)
  const [nav, setNav] = useState({ back: false, forward: false })
  const [initialUrl] = useState(() => url)

  function navigate(target: string): void {
    const next = toUrl(target)
    currentUrlRef.current = next
    setAddress(next)
    const view = viewRef.current
    if (view) void view.loadURL(next).catch(() => undefined)
    onUrlChange(next)
  }

  useImperativeHandle(ref, () => ({
    navigate,
    focusAddress: () => {
      inputRef.current?.focus()
      inputRef.current?.select()
    },
    reload: () => viewRef.current?.reload()
  }))

  /**
   * The guest sizes itself from the element's own CSS width and height, and
   * does not reliably follow a size it inherits from flex. Measure the host and
   * set pixels explicitly so every resize reaches the content.
   */
  const syncSize = useCallback(() => {
    const host = hostRef.current
    const view = viewRef.current
    if (!host || !view) return
    const { width, height } = host.getBoundingClientRect()
    // Zero means we are inside a hidden pane; re-measured when it is shown again.
    if (width < 1 || height < 1) return
    view.style.width = `${Math.round(width)}px`
    view.style.height = `${Math.round(height)}px`
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    syncSize()
    const observer = new ResizeObserver(syncSize)
    observer.observe(host)
    return () => observer.disconnect()
  }, [syncSize])

  // A pane hidden during a resize keeps its old size until it is shown again.
  useEffect(() => {
    if (!active) return
    const t = setTimeout(syncSize, 0)
    return () => clearTimeout(t)
  }, [active, syncSize])

  // Follow config changes (external edits, or a link clicked in the terminal).
  useEffect(() => {
    if (url === currentUrlRef.current) return
    currentUrlRef.current = url
    setAddress(url)
    const view = viewRef.current
    if (view) void view.loadURL(url).catch(() => undefined)
  }, [url])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return

    const syncNav = (): void => {
      setNav({ back: view.canGoBack(), forward: view.canGoForward() })
    }
    const onNavigate = (e: Event): void => {
      const next = (e as Event & { url?: string }).url ?? view.getURL()
      if ((e as Event & { isMainFrame?: boolean }).isMainFrame === false) return
      currentUrlRef.current = next
      setAddress(next)
      onUrlChange(next)
      syncNav()
    }
    const onStart = (): void => setLoading(true)
    const onStop = (): void => {
      setLoading(false)
      syncNav()
    }

    view.addEventListener('did-navigate', onNavigate)
    view.addEventListener('did-navigate-in-page', onNavigate)
    view.addEventListener('did-start-loading', onStart)
    view.addEventListener('did-stop-loading', onStop)
    return () => {
      view.removeEventListener('did-navigate', onNavigate)
      view.removeEventListener('did-navigate-in-page', onNavigate)
      view.removeEventListener('did-start-loading', onStart)
      view.removeEventListener('did-stop-loading', onStop)
    }
  }, [onUrlChange])

  return (
    <div className="pane browser-pane">
      <div className="pane-header">
        <button
          className="icon-btn"
          disabled={!nav.back}
          title="Back"
          onClick={() => viewRef.current?.goBack()}
        >
          ‹
        </button>
        <button
          className="icon-btn"
          disabled={!nav.forward}
          title="Forward"
          onClick={() => viewRef.current?.goForward()}
        >
          ›
        </button>
        <button
          className="icon-btn"
          title="Reload (⌘R)"
          onClick={() => (loading ? viewRef.current?.stop() : viewRef.current?.reload())}
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
      <div className="webview-host" ref={hostRef}>
        <Webview
          ref={viewRef}
          src={initialUrl}
          partition="persist:rippon-browser"
          allowpopups="true"
          className={active ? 'webview' : 'webview webview-hidden'}
        />
      </div>
    </div>
  )
})

export default BrowserPane
