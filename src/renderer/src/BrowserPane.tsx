import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import {
  bookmarkLabel,
  type Bookmark,
  type BookmarkScope,
  type BrowserState,
  type FindMatches
} from '@shared/types'
import type { MenuItem } from './Dialogs'
import FindBar, { type FindHandle } from './FindBar'

const NO_MATCHES: FindMatches = { active: 0, total: 0 }

export interface BrowserHandle {
  navigate(url: string): void
  focusAddress(): void
  reload(): void
  openFind(): void
  /** Advance the open search. Opens the bar if ⌘G was pressed cold. */
  stepFind(delta: 1 | -1): void
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
  /** Hidden in tiled views, where a tile has no room to spare. */
  showBookmarks: boolean
  globalBookmarks: Bookmark[]
  sessionBookmarks: Bookmark[]
  onUrlChange(url: string): void
  onClose(): void
  onBookmarkAdd(scope: BookmarkScope, bookmark: Bookmark): void
  onBookmarkRemove(scope: BookmarkScope, url: string): void
  onBookmarkRename(scope: BookmarkScope, bookmark: Bookmark): void
  /** Raised to the app so native browser views hide behind the menu. */
  onContextMenu(x: number, y: number, items: MenuItem[]): void
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
  {
    id,
    url,
    active,
    suppressed,
    zoom,
    showBookmarks,
    globalBookmarks,
    sessionBookmarks,
    onUrlChange,
    onClose,
    onBookmarkAdd,
    onBookmarkRemove,
    onBookmarkRename,
    onContextMenu
  },
  ref
) {
  const slotRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  /** Where the view actually is, so we don't fight the address bar while typing. */
  const currentUrlRef = useRef(url)
  const editingRef = useRef(false)
  const [address, setAddress] = useState(url)
  const [state, setState] = useState<BrowserState | null>(null)
  const findRef = useRef<FindHandle>(null)
  const [finding, setFinding] = useState(false)
  const [matches, setMatches] = useState<FindMatches>(NO_MATCHES)
  /** Last query, so ⌘G can step without the bar re-sending it. */
  const queryRef = useRef('')

  const visible = active && !suppressed

  function navigate(target: string): void {
    const next = toUrl(target)
    currentUrlRef.current = next
    setAddress(next)
    void window.rippon.browser.navigate(id, next)
    onUrlChange(next)
  }

  function closeFind(): void {
    setFinding(false)
    setMatches(NO_MATCHES)
    queryRef.current = ''
    void window.rippon.browser.findStop(id)
    // Esc should leave you back on the page, as it would in a browser.
    void window.rippon.browser.focus(id)
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
    reload: () => void window.rippon.browser.reload(id),
    openFind: () => {
      setFinding(true)
      // Same as ⌘L: the native view holds the keyboard until we take it back.
      void window.rippon.focusPage().then(() => findRef.current?.focus())
    },
    stepFind: (delta) => {
      if (!queryRef.current) {
        setFinding(true)
        void window.rippon.focusPage().then(() => findRef.current?.focus())
        return
      }
      void window.rippon.browser.find(id, queryRef.current, delta > 0)
    }
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

  useEffect(() => {
    return window.rippon.browser.onFound((viewId, next) => {
      if (viewId === id) setMatches(next)
    })
  }, [id])

  // Track navigation happening inside the view.
  useEffect(() => {
    return window.rippon.browser.onState((viewId, next) => {
      if (viewId !== id) return
      setState(next)
      if (next.url && next.url !== currentUrlRef.current) {
        currentUrlRef.current = next.url
        if (!editingRef.current) setAddress(next.url)
        onUrlChange(next.url)
        // The matches belonged to the old page. Re-run against the new one so a
        // bar left open keeps meaning something.
        if (queryRef.current) {
          setMatches(NO_MATCHES)
          void window.rippon.browser.find(id, queryRef.current, true)
        }
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
  const here = currentUrlRef.current
  const inSession = sessionBookmarks.some((b) => b.url === here)
  const inGlobal = globalBookmarks.some((b) => b.url === here)
  // Session bookmarks sit after the global ones, so the shared set stays put.
  const savedScope: BookmarkScope | null = inSession ? 'session' : inGlobal ? 'global' : null
  const bookmarkBar = [
    ...globalBookmarks.map((bookmark) => ({ scope: 'global' as const, bookmark })),
    ...sessionBookmarks.map((bookmark) => ({ scope: 'session' as const, bookmark }))
  ]

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
        <button
          className={`icon-btn ${savedScope ? 'icon-btn-on' : ''}`}
          title={
            savedScope === 'session'
              ? 'Bookmarked for this session'
              : savedScope === 'global'
                ? 'Bookmarked everywhere'
                : 'Bookmark this page'
          }
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            const here: Bookmark = {
              url: currentUrlRef.current,
              title: state?.title || bookmarkLabel(currentUrlRef.current)
            }
            onContextMenu(Math.max(0, r.right - 220), r.bottom + 4, [
              {
                label: inSession ? 'Remove from this session' : 'Bookmark for this session',
                checked: inSession,
                onClick: () =>
                  inSession
                    ? onBookmarkRemove('session', here.url)
                    : onBookmarkAdd('session', here)
              },
              {
                label: inGlobal ? 'Remove from all sessions' : 'Bookmark for all sessions',
                checked: inGlobal,
                onClick: () =>
                  inGlobal ? onBookmarkRemove('global', here.url) : onBookmarkAdd('global', here)
              }
            ])
          }}
        >
          {savedScope ? '★' : '☆'}
        </button>
        <button className="icon-btn" title="Close browser pane" onClick={onClose}>
          ×
        </button>
      </div>

      {showBookmarks && bookmarkBar.length ? (
        <div className="bookmark-bar">
          {bookmarkBar.map(({ scope, bookmark }) => (
            <button
              key={`${scope}:${bookmark.url}`}
              className={`bookmark ${scope === 'session' ? 'bookmark-session' : ''}`}
              title={`${bookmark.url}\n${
                scope === 'session' ? 'This session only' : 'All sessions'
              } — right-click to rename or remove`}
              onClick={() => navigate(bookmark.url)}
              onContextMenu={(e) => {
                e.preventDefault()
                onContextMenu(e.clientX, e.clientY, [
                  { label: 'Rename…', onClick: () => onBookmarkRename(scope, bookmark) },
                  {
                    label: 'Remove',
                    danger: true,
                    onClick: () => onBookmarkRemove(scope, bookmark.url)
                  }
                ])
              }}
            >
              {bookmark.title}
            </button>
          ))}
        </div>
      ) : null}
      {state?.crashed || state?.hung ? (
        <div className="hung-bar">
          {state.crashed
            ? `This page crashed (${state.crashed}).`
            : 'This page has stopped responding and will not redraw or resize.'}
          <button onClick={() => void window.rippon.browser.reload(id)}>reload</button>
        </div>
      ) : null}
      {finding ? (
        <FindBar
          ref={findRef}
          matches={matches}
          onQuery={(query) => {
            queryRef.current = query
            if (!query) setMatches(NO_MATCHES)
            void window.rippon.browser.find(id, query, true)
          }}
          onStep={(delta) => {
            if (queryRef.current) void window.rippon.browser.find(id, queryRef.current, delta > 0)
          }}
          onClose={closeFind}
        />
      ) : null}
      <div className="webview-host" ref={slotRef} />
    </div>
  )
})

export default BrowserPane
