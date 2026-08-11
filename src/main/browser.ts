import { BrowserWindow, WebContentsView, type Rectangle } from 'electron'
import { EventEmitter } from 'node:events'
import type { BrowserState, FindMatches } from '../shared/types'

/** Every browser pane shares this session, so a GitHub login in one is a login in all. */
export const BROWSER_PARTITION = 'persist:rippon-browser'

/*
 * No per-pane zoom: Chromium stores the zoom level per origin on the session,
 * and every pane shares one session so a login is shared. Scaling one pane
 * therefore scales every other pane on the same site.
 */

/** Ceiling on how often a guest is asked to lay the page out again, in ms. */
const MIN_APPLY_INTERVAL_MS = 70

/**
 * Narrowest layout viewport any page is given. Verified in isolation: two bare
 * WebContentsViews on the same session showing the same URL idle at 680x860,
 * spin at 100% CPU at 263x246, and idle again at 263x246 with zoom 0.5.
 */
const MIN_CSS_VIEWPORT = 560
const MIN_AUTO_ZOOM = 0.25

/**
 * Browser panes are WebContentsViews owned by the main process, with bounds
 * pushed from the renderer. The deprecated <webview> tag derives its guest size
 * from CSS, which does not reliably follow flex or survive a hidden ancestor —
 * the cause of panes rendering at a stale size after a resize.
 *
 * The tradeoff is that a WebContentsView always paints above the page, so the
 * renderer must hide panes while a modal or menu is open.
 */
export class BrowserViews extends EventEmitter {
  private views = new Map<string, WebContentsView>()
  private window: BrowserWindow | null = null
  private lastLogged = new Map<string, string>()
  private lastBounds = new Map<string, Rectangle>()
  private lastVisible = new Map<string, boolean>()
  private lastZoom = new Map<string, number>()
  private lastRequest = new Map<string, { width: number; zoom: number }>()
  private queued = new Map<string, { bounds: Rectangle; visible: boolean; zoom: number }>()
  private applyTimers = new Map<string, NodeJS.Timeout>()
  private lastApplied = new Map<string, number>()
  private hung = new Set<string>()
  private crashed = new Map<string, string>()
  /** The query currently live in each view's find session. See find(). */
  private findQuery = new Map<string, string>()

  attach(win: BrowserWindow): void {
    this.window = win
    win.on('closed', () => {
      this.destroyAll()
      this.window = null
    })
  }

  private emitState(id: string, view: WebContentsView): void {
    const wc = view.webContents
    if (wc.isDestroyed()) return
    const state: BrowserState = {
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      hung: this.hung.has(id),
      crashed: this.crashed.get(id) ?? null
    }
    this.emit('state', id, state)
  }

  ensure(id: string, url: string): void {
    if (this.views.has(id) || !this.window) return

    const view = new WebContentsView({
      webPreferences: { partition: BROWSER_PARTITION, contextIsolation: true, sandbox: true }
    })
    this.views.set(id, view)
    this.window.contentView.addChildView(view)
    // Stays hidden until the renderer reports where it belongs.
    view.setVisible(false)
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 })

    const wc = view.webContents
    wc.setWindowOpenHandler(({ url: target, disposition }) => {
      // window.open with features (OAuth / SSO flows) genuinely needs its own
      // window; a plain target=_blank link should just navigate the pane.
      if (disposition === 'new-window') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 560,
            height: 760,
            autoHideMenuBar: true,
            webPreferences: { partition: BROWSER_PARTITION, contextIsolation: true }
          }
        }
      }
      if (/^https?:/i.test(target)) void wc.loadURL(target)
      return { action: 'deny' }
    })

    const update = (): void => this.emitState(id, view)
    // A new origin arrives with whatever zoom the session has stored for it, so
    // drop the cache and let the renderer re-apply this view's value.
    wc.on('did-navigate', () => {
      // A new origin arrives with whatever the session stored for it.
      this.lastZoom.delete(id)
      // The old page's matches went with it, so the next find must start over.
      this.findQuery.delete(id)
      this.applyZoom()
      update()
    })
    wc.on('did-navigate-in-page', update)
    wc.on('did-start-loading', update)
    wc.on('did-stop-loading', update)
    wc.on('page-title-updated', update)

    wc.on('found-in-page', (_e, result) => {
      const matches: FindMatches = { active: result.activeMatchOrdinal, total: result.matches }
      this.emit('found', id, matches)
    })

    /*
     * Which pane ⌘F searches depends on where the caret was, and a native view
     * takes focus without the renderer ever seeing an event. Report it.
     */
    wc.on('focus', () => this.emit('focus', id))

    // A page that wedges its renderer stops laying out, so it also stops
    // following the pane's size. Surface it rather than leaving a frozen pane.
    wc.on('unresponsive', () => {
      this.hung.add(id)
      update()
    })
    // Without this a dead guest is just a blank rectangle with no explanation.
    wc.on('render-process-gone', (_e, details) => {
      console.error(
        `[browser] ${id} renderer gone: ${details.reason} exitCode=${details.exitCode}`
      )
      this.crashed.set(id, details.reason)
      this.hung.delete(id)
      update()
    })
    wc.on('did-start-loading', () => {
      this.crashed.delete(id)
    })
    wc.on('responsive', () => {
      this.hung.delete(id)
      update()
    })

    void wc.loadURL(url).then(
      () => {
        if (process.env['RIPPON_TRACE']) {
          console.log(`[view] ${id} guest renderer os pid = ${wc.getOSProcessId()}`)
        }
      },
      () => undefined
    )
  }

  /**
   * Queue a rectangle rather than applying it. Maximizing a window, or dragging
   * its edge, produces a burst of distinct sizes, and every one of them makes
   * the guest lay the whole page out again — enough to wedge a heavy page for
   * good. Applying at a bounded rate keeps the burst survivable; the trailing
   * flush guarantees the final size always lands.
   */
  setBounds(id: string, bounds: Rectangle, visible: boolean, zoom = 1): void {
    if (!this.views.has(id)) {
      if (process.env['RIPPON_TRACE']) console.log(`[bounds] ${id}: NO VIEW`)
      return
    }
    this.queued.set(id, { bounds, visible, zoom })

    const since = Date.now() - (this.lastApplied.get(id) ?? 0)
    if (since >= MIN_APPLY_INTERVAL_MS) {
      this.flushBounds(id)
      return
    }
    if (!this.applyTimers.has(id)) {
      this.applyTimers.set(
        id,
        setTimeout(() => {
          this.applyTimers.delete(id)
          this.flushBounds(id)
        }, MIN_APPLY_INTERVAL_MS - since)
      )
    }
  }

  private flushBounds(id: string): void {
    const view = this.views.get(id)
    const queued = this.queued.get(id)
    if (!view || !queued) return
    this.queued.delete(id)
    this.lastApplied.set(id, Date.now())
    const { bounds, visible, zoom } = queued
    this.lastRequest.set(id, { width: bounds.width, zoom })

    if (process.env['RIPPON_TRACE']) {
      // Only when the geometry actually changes — a drag fires this every frame.
      const key = `${Math.round(bounds.width)}x${Math.round(bounds.height)}@${Math.round(bounds.x)},${Math.round(bounds.y)}:${visible}`
      if (key !== this.lastLogged.get(id)) {
        this.lastLogged.set(id, key)
        console.log(`[bounds] ${id} ${key}`)
        setTimeout(() => {
          view.webContents
            .executeJavaScript('innerWidth + "x" + innerHeight')
            .then((g) => console.log(`[guest]  ${id} viewport ${g}  (bounds were ${key})`))
            .catch(() => undefined)
        }, 500)
      }
    }
    // Every one of these is a compositor change for the guest, so only make
    // them when something actually differs.
    if (!visible || bounds.width < 1 || bounds.height < 1) {
      if (this.lastVisible.get(id) !== false) {
        this.lastVisible.set(id, false)
        view.setVisible(false)
      }
      return
    }
    const next = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height)
    }
    const prev = this.lastBounds.get(id)
    if (
      !prev ||
      prev.x !== next.x ||
      prev.y !== next.y ||
      prev.width !== next.width ||
      prev.height !== next.height
    ) {
      this.lastBounds.set(id, next)
      // Zoom first: a page that lays out narrow even for one frame can enter a
      // loop it never leaves, so it must never see the smaller size unscaled.
      this.applyZoom()
      view.setBounds(next)
    }
    if (this.lastVisible.get(id) !== true) {
      this.lastVisible.set(id, true)
      view.setVisible(true)
      this.applyZoom()
    }
  }

  private act(id: string, fn: (wc: Electron.WebContents) => void): void {
    const view = this.views.get(id)
    if (!view || view.webContents.isDestroyed()) return
    fn(view.webContents)
  }

  /**
   * Cap zoom so the page always lays out at MIN_CSS_VIEWPORT or wider. Sites hit
   * their least-tested breakpoints below that; GitHub's PR inbox spins its
   * renderer at 100% CPU indefinitely at ~260px and never recovers.
   */
  private applyZoom(): void {
    /*
     * One value for every pane, taken from the narrowest one on screen. Zoom is
     * stored per origin on the shared session, so a pane cannot hold its own:
     * when panes resized a few ms apart each set their own, the first to widen
     * raised the zoom while the second was still small — handing that one a
     * viewport narrow enough to wedge it. Deriving from the narrowest means
     * zoom only ever rises once every pane can take it.
     */
    let zoom = Number.POSITIVE_INFINITY
    for (const [id, req] of this.lastRequest) {
      if (this.lastVisible.get(id) !== true) continue
      const fitted = req.width > 0 ? req.width / MIN_CSS_VIEWPORT : 1
      zoom = Math.min(zoom, Math.max(MIN_AUTO_ZOOM, Math.min(req.zoom, fitted)))
    }
    if (!Number.isFinite(zoom)) return
    for (const id of this.views.keys()) this.setZoom(id, zoom)
  }

  /**
   * Chromium stores this per origin on the session, so it is shared by every
   * pane on the same site. The renderer re-applies the active view's value on
   * navigation, which is what makes it behave as a per-view setting.
   */
  setZoom(id: string, factor: number): void {
    const view = this.views.get(id)
    if (!view || view.webContents.isDestroyed()) return
    if (Math.abs((this.lastZoom.get(id) ?? 1) - factor) < 0.005) return
    this.lastZoom.set(id, factor)
    view.webContents.setZoomFactor(factor)
  }

  navigate(id: string, url: string): void {
    this.act(id, (wc) => void wc.loadURL(url).catch(() => undefined))
  }

  goBack(id: string): void {
    this.act(id, (wc) => wc.navigationHistory.goBack())
  }

  goForward(id: string): void {
    this.act(id, (wc) => wc.navigationHistory.goForward())
  }

  reload(id: string): void {
    this.act(id, (wc) => {
      if (!this.hung.has(id)) {
        wc.reload()
        return
      }
      /*
       * A wedged renderer never gets round to servicing a reload — the whole
       * problem is that it is not returning to its event loop. Kill the process
       * first; the reload then comes up in a fresh one.
       */
      this.hung.delete(id)
      try {
        wc.forcefullyCrashRenderer()
      } catch {
        // already gone, which is the state we wanted
      }
      setTimeout(() => {
        if (!wc.isDestroyed()) wc.reload()
      }, 100)
    })
  }

  stop(id: string): void {
    this.act(id, (wc) => wc.stop())
  }

  /**
   * findInPage separates starting a search from advancing one, and gets it
   * wrong either way if told the wrong thing: findNext on a query it has not
   * seen searches for nothing, and omitting it re-reports the same match
   * forever. Tracking the live query lets callers just say what to search for
   * and which way to go — a changed query restarts, an unchanged one steps.
   */
  find(id: string, query: string, forward = true): void {
    if (!query) {
      this.stopFind(id)
      return
    }
    this.act(id, (wc) => {
      const findNext = this.findQuery.get(id) === query
      this.findQuery.set(id, query)
      wc.findInPage(query, { forward, findNext })
    })
  }

  stopFind(id: string): void {
    if (!this.findQuery.delete(id)) return
    this.act(id, (wc) => wc.stopFindInPage('clearSelection'))
  }

  focus(id: string): void {
    this.act(id, (wc) => wc.focus())
  }

  destroy(id: string): void {
    const view = this.views.get(id)
    if (!view) return
    this.views.delete(id)
    this.lastBounds.delete(id)
    this.lastVisible.delete(id)
    this.lastZoom.delete(id)
    this.lastRequest.delete(id)
    this.queued.delete(id)
    this.lastApplied.delete(id)
    const timer = this.applyTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.applyTimers.delete(id)
    }
    this.lastLogged.delete(id)
    this.hung.delete(id)
    this.findQuery.delete(id)
    this.window?.contentView.removeChildView(view)
    view.webContents.close()
  }

  destroyAll(): void {
    for (const id of [...this.views.keys()]) this.destroy(id)
  }
}
