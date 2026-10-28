import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import type { MenuItem } from './Dialogs'
import FindBar, { type FindHandle } from './FindBar'
import type { FindMatches, SessionInfo, HostConfig } from '@shared/types'

const NO_MATCHES: FindMatches = { active: 0, total: 0 }

const BASE_FONT_SIZE = 13

/** How long an attach may stay silent before the pane says it is still waiting. */
const SILENT_ATTACH_MS = 12_000

/** Every mounted terminal, so ⌘C can find the one the selection is in. */
const live = new Map<string, Terminal>()
let lastFocused: string | null = null

/**
 * ⌘C, routed here from the menu. An xterm selection is drawn on a canvas, not
 * held in the DOM, so the browser's own copy command cannot see it: the focused
 * terminal goes first, then an ordinary text field or DOM selection, then the
 * terminal that last had focus — a selection survives clicking a button.
 */
export function copyFromPage(): void {
  const active = document.activeElement
  for (const term of live.values()) {
    if (term.textarea === active && term.hasSelection()) {
      void window.rippon.clipboard.write(term.getSelection())
      return
    }
  }
  const isXterm = active instanceof HTMLElement && !!active.closest('.xterm')
  const domSelection = window.getSelection()?.toString() ?? ''
  const editable = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
  if (!isXterm && (domSelection || editable)) {
    document.execCommand('copy')
    return
  }
  const last = lastFocused ? live.get(lastFocused) : undefined
  if (last?.hasSelection()) void window.rippon.clipboard.write(last.getSelection())
}

/** OSC 52 carries base64 of UTF-8 bytes; atob alone would mangle anything non-ASCII. */
function decodeBase64(b64: string): string | null {
  try {
    const bin = atob(b64)
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
  } catch {
    return null
  }
}

export interface TerminalHandle {
  focus(): void
  reattach(): void
  openFind(): void
  /** Advance the open search. Opens the bar if ⌘G was pressed cold. */
  stepFind(delta: 1 | -1): void
}

interface Props {
  session: SessionInfo
  ssh: HostConfig
  active: boolean
  /** Drop the ssh client while this tab is hidden, reattaching when it returns. */
  detachWhenHidden: boolean
  /** Steal keyboard focus when shown. Off in tiled views, where several panes appear at once. */
  focusOnShow: boolean
  hasBrowser: boolean
  /** The view's zoom; scales the terminal font as it does the browser page. */
  zoom: number
  /** Called when a link in the terminal is clicked — routed to the browser pane. */
  onOpenUrl(url: string): void
  onRename(): void
  onOpenBrowser(): void
  /** Reported so ⌘F knows this pane, not the browser, is where the caret is. */
  onFocus(): void
  /**
   * Raised to the app rather than rendered here: a native browser view paints
   * above the page, so any menu has to be one the app knows to hide behind.
   */
  onContextMenu(x: number, y: number, items: MenuItem[]): void
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

/**
 * Every match is tinted like a selection; the current one is picked out in the
 * cursor blue. The overview-ruler entries put a mark on the scrollbar for each
 * hit, which is the only way to see matches that are off-screen in 10k lines of
 * scrollback.
 */
const SEARCH_OPTIONS: ISearchOptions = {
  decorations: {
    matchBackground: '#2a3050',
    matchBorder: '#414868',
    matchOverviewRuler: '#414868',
    activeMatchBackground: '#3b5aa6',
    activeMatchBorder: '#7aa2f7',
    activeMatchColorOverviewRuler: '#7aa2f7'
  }
}

const TerminalPane = forwardRef<TerminalHandle, Props>(function TerminalPane(
  {
    session,
    ssh,
    active,
    detachWhenHidden,
    focusOnShow,
    hasBrowser,
    zoom,
    onOpenUrl,
    onRename,
    onOpenBrowser,
    onFocus,
    onContextMenu
  },
  ref
) {
  const id = session.name
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const findRef = useRef<FindHandle>(null)
  const [finding, setFinding] = useState(false)
  const [matches, setMatches] = useState<FindMatches>(NO_MATCHES)
  /** Last query, so ⌘G can step without the bar re-sending it. */
  const queryRef = useRef('')
  const [status, setStatus] = useState<'idle' | 'attached' | 'detached'>('idle')
  /** Set when we drop the client on purpose, so the exit is not reported as a drop. */
  const backgroundDetach = useRef(false)
  /** Bumped per attach, so a late timer or failure from an earlier one stays quiet. */
  const attempt = useRef(0)
  const gotOutput = useRef(false)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  // Keep the latest values reachable from the terminal, which is built once.
  const openUrlRef = useRef(onOpenUrl)
  openUrlRef.current = onOpenUrl
  const sshRef = useRef(ssh)
  sshRef.current = ssh
  const onFocusRef = useRef(onFocus)
  onFocusRef.current = onFocus

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
    const mine = ++attempt.current
    gotOutput.current = false
    setStatus('attached')
    window.rippon.pty.attach(id, sshRef.current, id, term.cols, term.rows).then(
      () => {
        /*
         * ssh that hangs before it ever reaches tmux — a wedged master, a host
         * that accepts the connection and then says nothing — prints nothing
         * either, and the pane looks merely empty. Say so.
         */
        setTimeout(() => {
          if (attempt.current !== mine || gotOutput.current) return
          termRef.current?.write(
            `\x1b[33m… no output from ${sshRef.current.kind === 'local' ? 'tmux' : 'ssh'} after ${
              SILENT_ATTACH_MS / 1000
            }s — still waiting. ⌘⇧R reattaches; the Activity log has the ssh side.\x1b[0m\r\n`
          )
        }, SILENT_ATTACH_MS)
      },
      (err: unknown) => {
        if (attempt.current !== mine) return
        // Electron prefixes the main-process error with its own wrapper text.
        const message = String(err instanceof Error ? err.message : err).replace(
          /^Error invoking remote method '[^']+': (Error: )?/,
          ''
        )
        termRef.current?.write(
          `\x1b[31m✗ attach failed: ${message}\x1b[0m\r\n\x1b[2m— Press Enter to retry. —\x1b[0m\r\n`
        )
        setStatus('detached')
      }
    )
  }

  function step(delta: 1 | -1): void {
    const search = searchRef.current
    const query = queryRef.current
    if (!search || !query) return
    if (delta > 0) search.findNext(query, SEARCH_OPTIONS)
    else search.findPrevious(query, SEARCH_OPTIONS)
  }

  function openFind(): void {
    setFinding(true)
    /*
     * Seed from the selection, as a browser does — but only a single line of
     * it. A multi-line drag is someone copying output, not naming a search.
     */
    const selection = termRef.current?.getSelection() ?? ''
    const seed = selection.includes('\n') ? '' : selection.trim()
    // A browser view may hold the keyboard; take it back before focusing.
    void window.rippon.focusPage().then(() => findRef.current?.focus(seed || undefined))
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
    },
    openFind,
    stepFind: (delta) => {
      if (!queryRef.current) {
        openFind()
        return
      }
      step(delta)
    }
  }))

  // Build the terminal once and keep it alive while the tab is hidden.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily:
        'SFMono-Regular, ui-monospace, Menlo, "JetBrains Mono", "Fira Code", Consolas, monospace',
      fontSize: Math.round(BASE_FONT_SIZE * zoomRef.current),
      lineHeight: 1.2,
      cursorBlink: true,
      // Every open session holds its own buffer, so this is paid per pane.
      scrollback: 10000,
      allowProposedApi: true,
      /*
       * xterm defaults this to true on macOS, which meant right-clicking
       * re-selected the word under the pointer and threw away whatever had just
       * been dragged — so Copy only ever got that one word.
       */
      rightClickSelectsWord: false,
      // Lets Option-drag select locally even when an app has grabbed the mouse,
      // which is what tmux does with `set -g mouse on`.
      macOptionClickForcesSelection: true,
      theme: THEME,
      // OSC 8 hyperlinks (what most agents emit for PR links).
      linkHandler: { activate: (_event, uri) => openUrlRef.current(uri) }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    const search = new SearchAddon()
    term.loadAddon(search)
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
        /*
         * Chromium caps live WebGL contexts (16) and drops the oldest past that,
         * so with enough tabs open this fires. Disposing falls back to the DOM
         * renderer, but nothing repaints until output arrives — a quiet session
         * then shows as a blank tab. Repaint now.
         */
        console.warn(`[rippon] WebGL context lost for ${id}; falling back to DOM renderer`)
        try {
          webgl?.dispose()
        } catch {
          // already half torn down by the loss
        }
        webgl = null
        term.refresh(0, term.rows - 1)
      })
      term.loadAddon(webgl)
    } catch (err) {
      webgl = null
      // Worth knowing: the DOM fallback is what pegs this renderer under load.
      console.warn(`[rippon] WebGL terminal renderer unavailable for ${id}:`, err)
    }

    termRef.current = term
    fitRef.current = fit
    searchRef.current = search
    live.set(id, term)

    /*
     * OSC 52: how tmux (with `mouse on`) and remote editors put a copy on the
     * local clipboard. xterm.js ignores it unless told, so a mouse-mode drag
     * landed only in tmux's own buffer on the far end. Reads ("?") are refused.
     */
    const onOsc52 = term.parser.registerOscHandler(52, (data) => {
      const payload = data.slice(data.indexOf(';') + 1)
      if (!payload || payload === '?') return true
      const text = decodeBase64(payload)
      if (text !== null) void window.rippon.clipboard.write(text)
      return true
    })

    // resultIndex is -1 when nothing matched; the bar counts from 1.
    const onResults = search.onDidChangeResults(({ resultIndex, resultCount }) =>
      setMatches({ active: resultIndex + 1, total: resultCount })
    )
    // xterm's real keyboard target is the hidden textarea, not the host div.
    const onTermFocus = (): void => {
      lastFocused = id
      onFocusRef.current()
    }
    term.textarea?.addEventListener('focus', onTermFocus)
    // Debug handle: lets the main process inspect selection state. See
    // RIPPON_DEBUG_SELECT in src/main/index.ts.
    const debug = (window as unknown as { __rippon_terminals?: Map<string, Terminal> })
    ;(debug.__rippon_terminals ??= new Map()).set(id, term)

    const onDataDisposable = term.onData((data) => void window.rippon.pty.write(id, data))

    const offData = window.rippon.pty.onData((ptyId, data) => {
      if (ptyId !== id) return
      gotOutput.current = true
      term.write(data)
    })
    const offExit = window.rippon.pty.onExit((ptyId, code) => {
      if (ptyId !== id) return
      attempt.current++
      if (backgroundDetach.current) {
        // We asked for this. Clear the stale screen so the next attach starts
        // from tmux's own redraw rather than on top of an old frame.
        backgroundDetach.current = false
        term.reset()
        setStatus('idle')
        return
      }
      setStatus('detached')
      term.write(
        code
          ? `\r\n\x1b[31m— exited with code ${code}${
              gotOutput.current ? '' : ' before printing anything'
            }. Press Enter to reattach. —\x1b[0m\r\n`
          : '\r\n\x1b[2m— detached. Press Enter to reattach. —\x1b[0m\r\n'
      )
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
      onResults.dispose()
      onOsc52.dispose()
      live.delete(id)
      if (lastFocused === id) lastFocused = null
      term.textarea?.removeEventListener('focus', onTermFocus)
      searchRef.current = null
      /*
       * The WebGL addon goes first and on its own: letting Terminal.dispose()
       * tear it down reaches for render services the terminal has already
       * released, and it throws. Disposing it here means xterm's own pass finds
       * it already gone and skips it.
       *
       * Both are still guarded. Renaming a session unmounts a pane, so a throw
       * escaping this cleanup takes the whole React root with it — that is the
       * blank window, with every attached terminal lost.
       */
      try {
        webgl?.dispose()
      } catch {
        // Already torn down by a context loss, or never fully initialised.
      }
      webgl = null
      try {
        term.dispose()
      } catch (err) {
        console.warn(`[rippon] terminal ${id} failed to dispose cleanly:`, err)
      }
      termRef.current = null
      fitRef.current = null
      // Unmount means the tab is gone; drop the ssh client. The tmux session
      // itself is untouched and keeps running remotely.
      void window.rippon.pty.kill(id)
    }
  }, [id])

  // Zoom changes the cell size, so the grid — and tmux's idea of it — follows.
  useEffect(() => {
    const term = termRef.current
    const size = Math.round(BASE_FONT_SIZE * zoom)
    if (!term || term.options.fontSize === size) return
    term.options.fontSize = size
    if (!hostRef.current?.clientWidth) return
    try {
      fitRef.current?.fit()
      void window.rippon.pty.resize(id, term.cols, term.rows)
    } catch {
      /* mid-teardown */
    }
  }, [zoom, id])

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
      {finding ? (
        <FindBar
          ref={findRef}
          matches={matches}
          onQuery={(query) => {
            queryRef.current = query
            const search = searchRef.current
            if (!search) return
            if (!query) {
              search.clearDecorations()
              setMatches(NO_MATCHES)
              return
            }
            // Incremental, so typing extends the match under the cursor rather
            // than jumping to the next one on every keystroke.
            search.findNext(query, { ...SEARCH_OPTIONS, incremental: true })
          }}
          onStep={step}
          onClose={() => {
            setFinding(false)
            setMatches(NO_MATCHES)
            queryRef.current = ''
            searchRef.current?.clearDecorations()
            termRef.current?.focus()
          }}
        />
      ) : null}
      <div
        className="terminal-host"
        ref={hostRef}
        onContextMenu={(e) => {
          e.preventDefault()
          const term = termRef.current
          const selection = term?.getSelection() ?? ''
          /*
           * A full-screen program — which is what an agent's TUI is — turns on
           * mouse reporting, and then a drag belongs to that program rather than
           * to us: xterm forwards it and never starts a selection. Holding ⌥
           * overrides that, but it is not discoverable, so say so, and offer the
           * buffer copies that work whatever the mouse is doing.
           */
          const mouseGrabbed =
            hostRef.current?.querySelector('.xterm')?.classList.contains('enable-mouse-events') ??
            false

          const copyBuffer = (all: boolean): void => {
            if (!term) return
            const buf = term.buffer.active
            const from = all ? 0 : buf.viewportY
            const to = all ? buf.length : buf.viewportY + term.rows
            const lines: string[] = []
            for (let i = from; i < to; i++) {
              lines.push(buf.getLine(i)?.translateToString(true) ?? '')
            }
            void window.rippon.clipboard.write(lines.join('\n').replace(/\s+$/, ''))
          }

          onContextMenu(e.clientX, e.clientY, [
            {
              label: selection
                ? 'Copy selection'
                : mouseGrabbed
                  ? 'Copy selection — hold ⌥ and drag to select'
                  : 'Copy selection (nothing selected)',
              disabled: !selection,
              onClick: () => void window.rippon.clipboard.write(selection)
            },
            { label: 'Copy visible screen', onClick: () => copyBuffer(false) },
            { label: 'Copy all scrollback', onClick: () => copyBuffer(true) },
            {
              label: 'Paste',
              separator: true,
              onClick: () => {
                void window.rippon.clipboard.read().then((text) => {
                  if (text) void window.rippon.pty.write(id, text)
                })
              }
            },
            { label: 'Select all', onClick: () => term?.selectAll() }
          ])
        }}
      />
    </div>
  )
})

export default TerminalPane
