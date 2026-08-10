import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import type { SessionInfo, SshConfig } from '@shared/types'

export interface TerminalHandle {
  focus(): void
  reattach(): void
}

interface Props {
  session: SessionInfo
  ssh: SshConfig
  active: boolean
  /** Drop the ssh client while this tab is hidden, reattaching when it returns. */
  detachWhenHidden: boolean
  /** Steal keyboard focus when shown. Off in tiled views, where several panes appear at once. */
  focusOnShow: boolean
  hasBrowser: boolean
  /** Called when a link in the terminal is clicked — routed to the browser pane. */
  onOpenUrl(url: string): void
  onRename(): void
  onOpenBrowser(): void
}

const THEME = {
  background: '#101216',
  foreground: '#d7dae0',
  cursor: '#7aa2f7',
  selectionBackground: '#2a3050',
  black: '#15161e',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',
  brightBlack: '#414868'
}

const TerminalPane = forwardRef<TerminalHandle, Props>(function TerminalPane(
  { session, ssh, active, detachWhenHidden, focusOnShow, hasBrowser, onOpenUrl, onRename, onOpenBrowser },
  ref
) {
  const id = session.name
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [status, setStatus] = useState<'idle' | 'attached' | 'detached'>('idle')
  /** Set when we drop the client on purpose, so the exit is not reported as a drop. */
  const backgroundDetach = useRef(false)

  // Keep the latest values reachable from the terminal, which is built once.
  const openUrlRef = useRef(onOpenUrl)
  openUrlRef.current = onOpenUrl
  const sshRef = useRef(ssh)
  sshRef.current = ssh

  function attach(): void {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    try {
      fit.fit()
    } catch {
      // not laid out yet; the pty gets a sane default and we resize on the next fit
    }
    term.write(`\x1b[2m→ attaching to ${id}\x1b[0m\r\n`)
    void window.rippon.pty.attach(id, sshRef.current, id, term.cols, term.rows)
    setStatus('attached')
  }

  useImperativeHandle(ref, () => ({
    focus: () => {
      // A browser view may hold keyboard focus; take it back first.
      void window.rippon.focusPage().then(() => termRef.current?.focus())
    },
    reattach: () => {
      termRef.current?.reset()
      void window.rippon.pty.kill(id)
      attach()
    }
  }))

  // Build the terminal once and keep it alive while the tab is hidden.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily:
        'SFMono-Regular, ui-monospace, Menlo, "JetBrains Mono", "Fira Code", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      // Every open session holds its own buffer, so this is paid per pane.
      scrollback: 10000,
      allowProposedApi: true,
      theme: THEME,
      // OSC 8 hyperlinks (what most agents emit for PR links).
      linkHandler: { activate: (_event, uri) => openUrlRef.current(uri) }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // Plain-text URLs printed to stdout.
    term.loadAddon(new WebLinksAddon((_event, uri) => openUrlRef.current(uri)))
    term.open(host)

    // The default DOM renderer costs a lot of CPU per pane once an agent starts
    // producing output, and we run many panes at once. Fall back quietly: if the
    // GPU context is lost, xterm reverts to the DOM renderer on its own.
    let webgl: WebglAddon | null = null
    try {
      webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        webgl?.dispose()
        webgl = null
      })
      term.loadAddon(webgl)
    } catch (err) {
      webgl = null
      // Worth knowing: the DOM fallback is what pegs this renderer under load.
      console.warn(`[rippon] WebGL terminal renderer unavailable for ${id}:`, err)
    }

    termRef.current = term
    fitRef.current = fit

    const onDataDisposable = term.onData((data) => void window.rippon.pty.write(id, data))

    const offData = window.rippon.pty.onData((ptyId, data) => {
      if (ptyId === id) term.write(data)
    })
    const offExit = window.rippon.pty.onExit((ptyId) => {
      if (ptyId !== id) return
      if (backgroundDetach.current) {
        // We asked for this. Clear the stale screen so the next attach starts
        // from tmux's own redraw rather than on top of an old frame.
        backgroundDetach.current = false
        term.reset()
        setStatus('idle')
        return
      }
      setStatus('detached')
      term.write('\r\n\x1b[2m— detached. Press Enter to reattach. —\x1b[0m\r\n')
    })

    const observer = new ResizeObserver(() => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      try {
        fit.fit()
        void window.rippon.pty.resize(id, term.cols, term.rows)
      } catch {
        // fit throws if the element is mid-teardown
      }
    })
    observer.observe(host)

    return () => {
      observer.disconnect()
      offData()
      offExit()
      onDataDisposable.dispose()
      webgl?.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      // Unmount means the tab is gone; drop the ssh client. The tmux session
      // itself is untouched and keeps running remotely.
      void window.rippon.pty.kill(id)
    }
  }, [id])

  // Reattach on Enter after a detach.
  useEffect(() => {
    const term = termRef.current
    if (!term || status !== 'detached') return
    const d = term.onKey(({ domEvent }) => {
      if (domEvent.key === 'Enter') {
        term.reset()
        attach()
      }
    })
    return () => d.dispose()
  }, [status])

  // Attach lazily, the first time the tab is shown — and again on return if
  // the previous hide dropped the client.
  useEffect(() => {
    if (status !== 'idle' || !active) return
    const t = setTimeout(attach, 0)
    return () => clearTimeout(t)
  }, [active, status])

  // Optionally give the ssh channel back while the tab is hidden. tmux holds
  // the session and its scrollback, so returning costs one redraw.
  useEffect(() => {
    if (!detachWhenHidden || active || status !== 'attached') return
    backgroundDetach.current = true
    void window.rippon.pty.kill(id)
  }, [active, detachWhenHidden, status, id])

  useEffect(() => {
    if (!active) return
    const t = setTimeout(() => {
      const term = termRef.current
      const fit = fitRef.current
      if (!term || !fit || !hostRef.current?.clientWidth) return
      try {
        fit.fit()
        void window.rippon.pty.resize(id, term.cols, term.rows)
      } catch {
        /* ignore */
      }
      if (focusOnShow) term.focus()
    }, 0)
    return () => clearTimeout(t)
  }, [active, id, focusOnShow])

  return (
    <div className="pane terminal-pane">
      <div className="pane-header">
        <span className={`dot dot-${status}`} />
        <span className="pane-title" onDoubleClick={onRename} title="Double-click to rename">
          {session.name}
        </span>
        <span className="spacer" />
        {!hasBrowser ? (
          <button className="icon-btn" title="Open browser pane" onClick={onOpenBrowser}>
            ⊞ browser
          </button>
        ) : null}
        <button
          className="icon-btn"
          title="Reattach (⌘⇧R)"
          onClick={() => {
            termRef.current?.reset()
            void window.rippon.pty.kill(id)
            attach()
          }}
        >
          ⟳
        </button>
      </div>
      <div className="terminal-host" ref={hostRef} />
    </div>
  )
})

export default TerminalPane
