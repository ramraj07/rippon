import { BrowserWindow, WebContentsView, type Rectangle } from 'electron'
import { EventEmitter } from 'node:events'
import type { BrowserState } from '../shared/types'

/** Every browser pane shares this session, so a GitHub login in one is a login in all. */
export const BROWSER_PARTITION = 'persist:rippon-browser'

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
      canGoForward: wc.navigationHistory.canGoForward()
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
    wc.on('did-navigate', update)
    wc.on('did-navigate-in-page', update)
    wc.on('did-start-loading', update)
    wc.on('did-stop-loading', update)
    wc.on('page-title-updated', update)

    void wc.loadURL(url).catch(() => undefined)
  }

  setBounds(id: string, bounds: Rectangle, visible: boolean): void {
    const view = this.views.get(id)
    if (!view) return
    if (!visible || bounds.width < 1 || bounds.height < 1) {
      view.setVisible(false)
      return
    }
    view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height)
    })
    view.setVisible(true)
  }

  private act(id: string, fn: (wc: Electron.WebContents) => void): void {
    const view = this.views.get(id)
    if (!view || view.webContents.isDestroyed()) return
    fn(view.webContents)
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
    this.window?.contentView.removeChildView(view)
    view.webContents.close()
  }

  destroyAll(): void {
    for (const id of [...this.views.keys()]) this.destroy(id)
  }
}
