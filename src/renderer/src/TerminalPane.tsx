import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { SshConfig } from '@shared/types'

export interface TerminalHandle {
  focus(): void
  reconnect(): void
}

interface Props {
  tabId: string
  ssh: SshConfig
  active: boolean
  /** Called when a link in the terminal is clicked — routed to the browser pane. */
  onOpenUrl(url: string): void
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
  { tabId, ssh, active, onOpenUrl },
  ref
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [status, setStatus] = useState<'idle' | 'connecting' | 'running' | 'exited'>('idle')

  // Keep the latest callbacks reachable from the terminal, which is built once.
  const openUrlRef = useRef(onOpenUrl)
  openUrlRef.current = onOpenUrl
  const sshRef = useRef(ssh)
  sshRef.current = ssh

  function connect(): void {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    if (!sshRef.current.host) {
      term.writeln('\x1b[33mNo SSH host configured for this tab. Open tab settings (⚙) to set one.\x1b[0m')
      return
    }
    try {
      fit.fit()
    } catch {
      // not laid out yet; the pty gets a sane default and we resize on the next fit
    }
    setStatus('connecting')
    term.write(`\x1b[2m→ ssh ${sshRef.current.host}\x1b[0m\r\n`)
    void window.rippon.pty.start(tabId, sshRef.current, term.cols, term.rows)
    setStatus('running')
  }

  useImperativeHandle(ref, () => ({
    focus: () => termRef.current?.focus(),
    reconnect: () => {
      termRef.current?.reset()
      void window.rippon.pty.kill(tabId)
      connect()
    }
  }))

  // Build the terminal once per tab and keep it alive while the tab is hidden.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily:
        'SFMono-Regular, ui-monospace, Menlo, "JetBrains Mono", "Fira Code", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 50000,
      allowProposedApi: true,
      theme: THEME,
      // OSC 8 hyperlinks (what most agents emit for PR links).
      linkHandler: {
        activate: (_event, uri) => openUrlRef.current(uri)
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // Plain-text URLs printed to stdout.
    term.loadAddon(new WebLinksAddon((_event, uri) => openUrlRef.current(uri)))
    term.open(host)

    termRef.current = term
    fitRef.current = fit

    const onDataDisposable = term.onData((data) => void window.rippon.pty.write(tabId, data))

    const offData = window.rippon.pty.onData((id, data) => {
      if (id === tabId) term.write(data)
    })
    const offExit = window.rippon.pty.onExit((id, code) => {
      if (id !== tabId) return
      setStatus('exited')
      term.write(`\r\n\x1b[2m— session ended (exit ${code}). Press Enter to reconnect. —\x1b[0m\r\n`)
    })

    const observer = new ResizeObserver(() => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      try {
        fit.fit()
        void window.rippon.pty.resize(tabId, term.cols, term.rows)
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
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [tabId])

  // Reconnect on Enter after the remote session ends.
  useEffect(() => {
    const term = termRef.current
    if (!term || status !== 'exited') return
    const d = term.onKey(({ domEvent }) => {
      if (domEvent.key === 'Enter') {
        term.reset()
        connect()
      }
    })
    return () => d.dispose()
  }, [status])

  // Connect lazily: the first time the tab is shown, or immediately if autoConnect.
  useEffect(() => {
    if (status !== 'idle') return
    if (!active && !ssh.autoConnect) return
    const t = setTimeout(connect, 0)
    return () => clearTimeout(t)
  }, [active, ssh.autoConnect, ssh.host, status])

  useEffect(() => {
    if (!active) return
    const t = setTimeout(() => {
      const term = termRef.current
      const fit = fitRef.current
      if (!term || !fit || !hostRef.current?.clientWidth) return
      try {
        fit.fit()
        void window.rippon.pty.resize(tabId, term.cols, term.rows)
      } catch {
        /* ignore */
      }
      term.focus()
    }, 0)
    return () => clearTimeout(t)
  }, [active, tabId])

  return (
    <div className="pane terminal-pane">
      <div className="pane-header">
        <span className={`dot dot-${status}`} />
        <span className="pane-title">{ssh.host || 'no host'}</span>
        {ssh.command ? <span className="pane-sub">{ssh.command}</span> : null}
        <span className="spacer" />
        <button
          className="icon-btn"
          title="Reconnect (⌘⇧R)"
          onClick={() => {
            termRef.current?.reset()
            void window.rippon.pty.kill(tabId)
            connect()
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
