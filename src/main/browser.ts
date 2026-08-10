import { BrowserWindow, WebContentsView, type Rectangle } from 'electron'
import { EventEmitter } from 'node:events'
import type { BrowserState } from '../shared/types'

/** Every browser pane shares this session, so a GitHub login in one is a login in all. */
export const BROWSER_PARTITION = 'persist:rippon-browser'

/*
 * No per-pane zoom: Chromium stores the zoom level per origin on the session,
 * and every pane shares one session so a login is shared. Scaling one pane
 * therefore scales every other pane on the same site.
 */

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
  private hung = new Set<string>()

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
      hung: this.hung.has(id)
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
      this.lastZoom.delete(id)
      update()
    })
    wc.on('did-navigate-in-page', update)
    wc.on('did-start-loading', update)
    wc.on('did-stop-loading', update)
    wc.on('page-title-updated', update)

    // A page that wedges its renderer stops laying out, so it also stops
    // following the pane's size. Surface it rather than leaving a frozen pane.
    wc.on('unresponsive', () => {
      this.hung.add(id)
      update()
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

  setBounds(id: string, bounds: Rectangle, visible: boolean): void {
    const view = this.views.get(id)
    if (!view) {
      if (process.env['RIPPON_TRACE']) console.log(`[bounds] ${id}: NO VIEW`)
      return
    }
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
      view.setBounds(next)
    }
    if (this.lastVisible.get(id) !== true) {
      this.lastVisible.set(id, true)
      view.setVisible(true)
    }
  }

  private act(id: string, fn: (wc: Electron.WebContents) => void): void {
    const view = this.views.get(id)
    if (!view || view.webContents.isDestroyed()) return
    fn(view.webContents)
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
    this.act(id, (wc) => wc.reload())
  }

  stop(id: string): void {
    this.act(id, (wc) => wc.stop())
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
    this.lastLogged.delete(id)
    this.hung.delete(id)
    this.window?.contentView.removeChildView(view)
    view.webContents.close()
  }

  destroyAll(): void {
    for (const id of [...this.views.keys()]) this.destroy(id)
  }
}
