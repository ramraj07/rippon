import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent
} from 'react'
import TerminalPane, { type TerminalHandle } from './TerminalPane'
import BrowserPane, { type BrowserHandle } from './BrowserPane'
import SshSettings from './SshSettings'
import { CloseSessionDialog, NameDialog } from './Dialogs'
import {
  defaultConfig,
  defaultSession,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  type RipponConfig,
  type SessionConfig,
  type SessionInfo,
  type SshConfig
} from '@shared/types'

const SAVE_DEBOUNCE_MS = 400
const POLL_MS = 5000
/** Roughly the rendered height of the tab context menu, used to keep it on screen. */
const CTX_MENU_HEIGHT = 84

type Dialog =
  | { kind: 'settings' }
  | { kind: 'new' }
  | { kind: 'rename'; name: string }
  | { kind: 'close'; name: string }
  | null

export default function App(): JSX.Element {
  const [config, setConfig] = useState<RipponConfig>(defaultConfig)
  const [configPath, setConfigPath] = useState('')
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [ready, setReady] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ name: string; x: number; y: number } | null>(null)

  const terminals = useRef(new Map<string, TerminalHandle | null>())
  const browsers = useRef(new Map<string, BrowserHandle | null>())
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Mirrors `config` for use inside stable callbacks and menu handlers. */
  const configRef = useRef(config)
  configRef.current = config

  const visible = useMemo(
    () => sessions.filter((s) => !config.hidden.includes(s.name)),
    [sessions, config.hidden]
  )
  const activeName =
    visible.find((s) => s.name === config.activeSession)?.name ?? visible[0]?.name ?? null
  const hiddenExisting = useMemo(
    () => sessions.filter((s) => config.hidden.includes(s.name)),
    [sessions, config.hidden]
  )

  /** Single write path: update local state now, persist to disk debounced. */
  const commit = useCallback((next: RipponConfig) => {
    configRef.current = next
    setConfig(next)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void window.rippon.config.save(next), SAVE_DEBOUNCE_MS)
  }, [])

  const refresh = useCallback(async () => {
    const ssh = configRef.current.ssh
    if (!ssh.host) {
      setSessions([])
      setListError(null)
      return
    }
    const res = await window.rippon.tmux.list(ssh)
    if (!res.ok) {
      setListError(res.error)
      return
    }
    setListError(null)
    setSessions(res.value)

    // Drop hidden entries whose session no longer exists remotely.
    const live = new Set(res.value.map((s) => s.name))
    const cur = configRef.current
    const prunedHidden = cur.hidden.filter((h) => live.has(h))
    if (prunedHidden.length !== cur.hidden.length) commit({ ...cur, hidden: prunedHidden })
  }, [commit])

  const selectSession = useCallback(
    (name: string) => {
      if (configRef.current.activeSession === name) return
      commit({ ...configRef.current, activeSession: name })
    },
    [commit]
  )

  const updateSession = useCallback(
    (name: string, patch: Partial<SessionConfig>) => {
      const cur = configRef.current
      const existing = cur.sessions[name] ?? defaultSession()
      const next = { ...existing, ...patch }
      if (next.url === existing.url && next.splitRatio === existing.splitRatio) return
      commit({ ...cur, sessions: { ...cur.sessions, [name]: next } })
    },
    [commit]
  )

  /** Pick the tab to show after `name` leaves the strip. */
  const neighbourOf = useCallback(
    (name: string): string | undefined => {
      const idx = visible.findIndex((s) => s.name === name)
      const rest = visible.filter((s) => s.name !== name)
      return rest[Math.min(Math.max(idx, 0), rest.length - 1)]?.name
    },
    [visible]
  )

  const createSession = useCallback(
    async (name: string) => {
      setDialog(null)
      const res = await window.rippon.tmux.create(configRef.current.ssh, name)
      if (!res.ok) {
        setListError(res.error)
        return
      }
      const cur = configRef.current
      commit({
        ...cur,
        hidden: cur.hidden.filter((h) => h !== name),
        activeSession: name,
        sessions: { ...cur.sessions, [name]: cur.sessions[name] ?? defaultSession() }
      })
      await refresh()
    },
    [commit, refresh]
  )

  const hideSession = useCallback(
    (name: string) => {
      setDialog(null)
      const cur = configRef.current
      commit({
        ...cur,
        hidden: [...new Set([...cur.hidden, name])],
        activeSession: neighbourOf(name)
      })
    },
    [commit, neighbourOf]
  )

  const killSession = useCallback(
    async (name: string) => {
      setDialog(null)
      const next = neighbourOf(name)
      const res = await window.rippon.tmux.kill(configRef.current.ssh, name)
      if (!res.ok) {
        setListError(res.error)
        return
      }
      const cur = configRef.current
      const { [name]: _removed, ...rest } = cur.sessions
      commit({
        ...cur,
        sessions: rest,
        hidden: cur.hidden.filter((h) => h !== name),
        activeSession: next
      })
      await refresh()
    },
    [commit, neighbourOf, refresh]
  )

  const renameSession = useCallback(
    async (from: string, to: string) => {
      setDialog(null)
      if (from === to) return
      const res = await window.rippon.tmux.rename(configRef.current.ssh, from, to)
      if (!res.ok) {
        setListError(res.error)
        return
      }
      const cur = configRef.current
      const { [from]: moved, ...rest } = cur.sessions
      commit({
        ...cur,
        sessions: { ...rest, [to]: moved ?? defaultSession() },
        hidden: cur.hidden.map((h) => (h === from ? to : h)),
        activeSession: cur.activeSession === from ? to : cur.activeSession
      })
      await refresh()
    },
    [commit, refresh]
  )

  const restoreSession = useCallback(
    (name: string) => {
      const cur = configRef.current
      commit({ ...cur, hidden: cur.hidden.filter((h) => h !== name), activeSession: name })
    },
    [commit]
  )

  function startSidebarDrag(e: ReactPointerEvent<HTMLDivElement>): void {
    e.currentTarget.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent): void => {
      setDragWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, ev.clientX)))
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDragWidth((final) => {
        if (final !== null) commit({ ...configRef.current, sidebarWidth: final })
        return null
      })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const saveSsh = useCallback(
    (ssh: SshConfig) => {
      setDialog(null)
      commit({ ...configRef.current, ssh })
      void refresh()
    },
    [commit, refresh]
  )

  // Initial load, plus external config changes (another machine syncing the file in).
  useEffect(() => {
    void window.rippon.config.get().then(({ config: cfg, path }) => {
      configRef.current = cfg
      setConfig(cfg)
      setConfigPath(path)
      setReady(true)
      if (!cfg.ssh.host) setDialog({ kind: 'settings' })
      void refresh()
    })

    const offConfig = window.rippon.config.onChanged((cfg, path) => {
      configRef.current = cfg
      setConfig(cfg)
      setConfigPath(path)
      void refresh()
    })
    const offError = window.rippon.onError(setListError)
    return () => {
      offConfig()
      offError()
    }
  }, [refresh])

  // Keep the tab strip in step with the remote session list.
  useEffect(() => {
    const timer = setInterval(() => void refresh(), POLL_MS)
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  // Menu commands.
  useEffect(() => {
    return window.rippon.onMenu((action, payload) => {
      const name = activeName
      switch (action) {
        case 'menu:new-session':
          return setDialog({ kind: 'new' })
        case 'menu:settings':
          return setDialog({ kind: 'settings' })
        case 'menu:refresh':
          return void refresh()
        case 'menu:close-tab':
          return name ? setDialog({ kind: 'close', name }) : undefined
        case 'menu:cycle-tab': {
          if (visible.length < 2 || !name) return
          const idx = visible.findIndex((s) => s.name === name)
          const delta = typeof payload === 'number' ? payload : 1
          return selectSession(visible[(idx + delta + visible.length) % visible.length].name)
        }
        case 'menu:select-tab-index': {
          const s = visible[typeof payload === 'number' ? payload : 0]
          return s ? selectSession(s.name) : undefined
        }
        case 'menu:focus-address':
          return name ? browsers.current.get(name)?.focusAddress() : undefined
        case 'menu:focus-terminal':
          return name ? terminals.current.get(name)?.focus() : undefined
        case 'menu:reload-browser':
          return name ? browsers.current.get(name)?.reload() : undefined
        case 'menu:reconnect-ssh':
          return name ? terminals.current.get(name)?.reattach() : undefined
      }
    })
  }, [activeName, refresh, selectSession, visible])

  return (
    <div className="app">
      <header className="titlebar">
        <button
          className="host-btn"
          title={`${config.ssh.host || 'No host set'}\nConfig: ${configPath}`}
          onClick={() => setDialog({ kind: 'settings' })}
        >
          {config.ssh.host || 'set up SSH…'} ⚙
        </button>
        <span className="spacer" />
      </header>

      {listError ? (
        <div className="error-bar">
          <span className="error-text-body">{listError}</span>
          <button onClick={() => void refresh()}>retry</button>
          <button onClick={() => setListError(null)}>×</button>
        </div>
      ) : null}

      <div className="body-row">
        <nav className="sidebar" style={{ width: dragWidth ?? config.sidebarWidth }}>
          <div className="sidebar-list">
            {visible.map((s) => (
              <div
                key={s.name}
                className={`vtab ${s.name === activeName ? 'vtab-active' : ''}`}
                onClick={() => selectSession(s.name)}
                onDoubleClick={() => setDialog({ kind: 'rename', name: s.name })}
                onContextMenu={(e) => {
                  e.preventDefault()
                  // Keep the menu on screen when right-clicking near the bottom.
                  setCtxMenu({
                    name: s.name,
                    x: e.clientX,
                    y: Math.min(e.clientY, window.innerHeight - CTX_MENU_HEIGHT)
                  })
                }}
                title={`${s.name} — ${s.windows} window(s)${s.attached ? ', attached' : ''}\nDouble-click or right-click to rename`}
              >
                <span className={`dot ${s.attached ? 'dot-attached' : ''}`} />
                <span className="vtab-text">
                  <span className="vtab-name">{s.name}</span>
                  <span className="vtab-meta">
                    {s.windows} window{s.windows === 1 ? '' : 's'}
                    {s.attached ? ' · attached' : ''}
                  </span>
                </span>
                <button
                  className="tab-close"
                  title="Close tab"
                  onClick={(e) => {
                    e.stopPropagation()
                    setDialog({ kind: 'close', name: s.name })
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <div className="sidebar-footer">
            {hiddenExisting.length ? (
              <>
                <div className="menu-label">Running, not shown</div>
                {hiddenExisting.map((s) => (
                  <button
                    key={s.name}
                    className="hidden-item"
                    title="Show this session again"
                    onClick={() => restoreSession(s.name)}
                  >
                    {s.name}
                  </button>
                ))}
              </>
            ) : null}
            <button className="new-session-btn" onClick={() => setDialog({ kind: 'new' })}>
              + New session
            </button>
          </div>
        </nav>

        <div className="sidebar-resizer" onPointerDown={startSidebarDrag} />

        <main className="tabs-body">
          {ready && visible.length === 0 ? (
            <div className="empty">
              {!config.ssh.host ? (
                <>
                  No host configured.
                  <button onClick={() => setDialog({ kind: 'settings' })}>Set up SSH</button>
                </>
              ) : (
                <>
                  No tmux sessions on {config.ssh.host}.
                  <button onClick={() => setDialog({ kind: 'new' })}>Create one</button>
                </>
              )}
            </div>
          ) : null}

          {visible.map((s) => (
            <TabPanel
              key={s.name}
              session={s}
              ssh={config.ssh}
              active={s.name === activeName}
              settings={config.sessions[s.name] ?? defaultSession()}
              terminals={terminals.current}
              browsers={browsers.current}
              onUpdate={updateSession}
              onRename={() => setDialog({ kind: 'rename', name: s.name })}
            />
          ))}
        </main>
      </div>

      {ctxMenu ? (
        <>
          <div
            className="menu-scrim"
            onMouseDown={() => setCtxMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              setCtxMenu(null)
            }}
          />
          <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            <button
              onClick={() => {
                setDialog({ kind: 'rename', name: ctxMenu.name })
                setCtxMenu(null)
              }}
            >
              Rename session…
            </button>
            <button
              onClick={() => {
                setDialog({ kind: 'close', name: ctxMenu.name })
                setCtxMenu(null)
              }}
            >
              Close tab…
            </button>
          </div>
        </>
      ) : null}

      {dialog?.kind === 'settings' ? (
        <SshSettings
          ssh={config.ssh}
          configPath={configPath}
          onSave={saveSsh}
          onClose={() => setDialog(null)}
          onChoosePath={() => void window.rippon.config.choosePath()}
        />
      ) : null}

      {dialog?.kind === 'new' ? (
        <NameDialog
          title="New tmux session"
          confirmLabel="Create"
          taken={sessions.map((s) => s.name)}
          onSubmit={(name) => void createSession(name)}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === 'rename' ? (
        <NameDialog
          title="Rename session"
          confirmLabel="Rename"
          initial={dialog.name}
          taken={sessions.map((s) => s.name)}
          onSubmit={(name) => void renameSession(dialog.name, name)}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === 'close' ? (
        <CloseSessionDialog
          name={dialog.name}
          onHide={() => hideSession(dialog.name)}
          onKill={() => void killSession(dialog.name)}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  )
}

interface TabPanelProps {
  session: SessionInfo
  ssh: SshConfig
  active: boolean
  settings: SessionConfig
  terminals: Map<string, TerminalHandle | null>
  browsers: Map<string, BrowserHandle | null>
  onUpdate(name: string, patch: Partial<SessionConfig>): void
  onRename(): void
}

function TabPanel({
  session,
  ssh,
  active,
  settings,
  terminals,
  browsers,
  onUpdate,
  onRename
}: TabPanelProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [dragRatio, setDragRatio] = useState<number | null>(null)
  const ratio = dragRatio ?? settings.splitRatio
  const name = session.name

  function startDrag(e: ReactPointerEvent<HTMLDivElement>): void {
    const container = containerRef.current
    if (!container) return
    e.currentTarget.setPointerCapture(e.pointerId)

    const move = (ev: PointerEvent): void => {
      const rect = container.getBoundingClientRect()
      setDragRatio(Math.min(0.85, Math.max(0.15, (ev.clientX - rect.left) / rect.width)))
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDragRatio((final) => {
        if (final !== null) onUpdate(name, { splitRatio: final })
        return null
      })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onUrlChange = useCallback((url: string) => onUpdate(name, { url }), [name, onUpdate])
  const openUrl = useCallback((url: string) => browsers.get(name)?.navigate(url), [browsers, name])

  return (
    <div ref={containerRef} className="tab-panel" style={{ display: active ? 'flex' : 'none' }}>
      <div className="split-left" style={{ width: `calc(${ratio * 100}% - 3px)` }}>
        <TerminalPane
          ref={(h) => {
            terminals.set(name, h)
          }}
          session={session}
          ssh={ssh}
          active={active}
          onOpenUrl={openUrl}
          onRename={onRename}
        />
      </div>
      <div className="splitter" onPointerDown={startDrag} />
      <div className="split-right">
        <BrowserPane
          ref={(h) => {
            browsers.set(name, h)
          }}
          url={settings.url}
          active={active}
          onUrlChange={onUrlChange}
        />
      </div>
    </div>
  )
}
