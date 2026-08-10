import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent
} from 'react'
import TerminalPane, { type TerminalHandle } from './TerminalPane'
import BrowserPane, { type BrowserHandle } from './BrowserPane'
import TabSettings from './TabSettings'
import { defaultConfig, newTab, type RipponConfig, type TabConfig } from '@shared/types'

const SAVE_DEBOUNCE_MS = 400

function makeId(): string {
  return `tab-${Math.random().toString(36).slice(2, 9)}`
}

export default function App(): JSX.Element {
  const [config, setConfig] = useState<RipponConfig>(defaultConfig)
  const [configPath, setConfigPath] = useState('')
  const [ready, setReady] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const terminals = useRef(new Map<string, TerminalHandle | null>())
  const browsers = useRef(new Map<string, BrowserHandle | null>())
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Mirrors `config` for use inside stable callbacks and menu handlers. */
  const configRef = useRef(config)
  configRef.current = config

  const activeId = config.activeTabId ?? config.tabs[0]?.id

  /** Single write path: update local state now, persist to disk debounced. */
  const commit = useCallback((next: RipponConfig) => {
    configRef.current = next
    setConfig(next)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void window.rippon.config.save(next)
    }, SAVE_DEBOUNCE_MS)
  }, [])

  const updateTab = useCallback(
    (id: string, patch: (t: TabConfig) => TabConfig) => {
      const cur = configRef.current
      commit({ ...cur, tabs: cur.tabs.map((t) => (t.id === id ? patch(t) : t)) })
    },
    [commit]
  )

  const selectTab = useCallback(
    (id: string) => {
      if (configRef.current.activeTabId === id) return
      commit({ ...configRef.current, activeTabId: id })
    },
    [commit]
  )

  const addTab = useCallback(() => {
    const cur = configRef.current
    const tab = newTab(makeId(), { title: `Tab ${cur.tabs.length + 1}` })
    commit({ ...cur, tabs: [...cur.tabs, tab], activeTabId: tab.id })
    setEditingId(tab.id)
  }, [commit])

  const closeTab = useCallback(
    (id: string) => {
      const cur = configRef.current
      const idx = cur.tabs.findIndex((t) => t.id === id)
      if (idx === -1) return
      const tabs = cur.tabs.filter((t) => t.id !== id)
      const nextActive =
        cur.activeTabId === id ? tabs[Math.min(idx, tabs.length - 1)]?.id : cur.activeTabId
      void window.rippon.pty.kill(id)
      terminals.current.delete(id)
      browsers.current.delete(id)
      commit({ ...cur, tabs, activeTabId: nextActive })
    },
    [commit]
  )

  const cycleTab = useCallback(
    (delta: number) => {
      const cur = configRef.current
      if (cur.tabs.length < 2) return
      const idx = cur.tabs.findIndex((t) => t.id === cur.activeTabId)
      const next = cur.tabs[(idx + delta + cur.tabs.length) % cur.tabs.length]
      if (next) selectTab(next.id)
    },
    [selectTab]
  )

  // Initial load + external config changes (another machine syncing the file in).
  useEffect(() => {
    void window.rippon.config.get().then(({ config: cfg, path }) => {
      setConfig(cfg.tabs.length ? cfg : { ...cfg, tabs: [newTab(makeId(), { title: 'Tab 1' })] })
      setConfigPath(path)
      setReady(true)
    })

    const offConfig = window.rippon.config.onChanged((cfg, path) => {
      configRef.current = cfg
      setConfig(cfg)
      setConfigPath(path)
    })
    const offError = window.rippon.onError(setError)
    return () => {
      offConfig()
      offError()
    }
  }, [])

  // Menu commands.
  useEffect(() => {
    return window.rippon.onMenu((action, payload) => {
      const id = configRef.current.activeTabId
      switch (action) {
        case 'menu:new-tab':
          return addTab()
        case 'menu:close-tab':
          return id ? closeTab(id) : undefined
        case 'menu:cycle-tab':
          return cycleTab(typeof payload === 'number' ? payload : 1)
        case 'menu:select-tab-index': {
          const t = configRef.current.tabs[typeof payload === 'number' ? payload : 0]
          return t ? selectTab(t.id) : undefined
        }
        case 'menu:focus-address':
          return id ? browsers.current.get(id)?.focusAddress() : undefined
        case 'menu:focus-terminal':
          return id ? terminals.current.get(id)?.focus() : undefined
        case 'menu:reload-browser':
          return id ? browsers.current.get(id)?.reload() : undefined
        case 'menu:reconnect-ssh':
          return id ? terminals.current.get(id)?.reconnect() : undefined
      }
    })
  }, [addTab, closeTab, cycleTab, selectTab])

  const editingTab = config.tabs.find((t) => t.id === editingId) ?? null

  return (
    <div className="app">
      <header className="titlebar">
        <div className="tabstrip">
          {config.tabs.map((tab) => (
            <div
              key={tab.id}
              className={`tab ${tab.id === activeId ? 'tab-active' : ''}`}
              onClick={() => selectTab(tab.id)}
              onDoubleClick={() => setEditingId(tab.id)}
              title={tab.ssh.host ? `${tab.ssh.host}${tab.ssh.command ? ` — ${tab.ssh.command}` : ''}` : 'No host set'}
            >
              <span className="tab-title">{tab.title}</span>
              <button
                className="tab-gear"
                title="Tab settings"
                onClick={(e) => {
                  e.stopPropagation()
                  setEditingId(tab.id)
                }}
              >
                ⚙
              </button>
              <button
                className="tab-close"
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(tab.id)
                }}
              >
                ×
              </button>
            </div>
          ))}
          <button className="tab-add" title="New tab (⌘T)" onClick={addTab}>
            +
          </button>
        </div>
        <button
          className="config-path"
          title={`Config: ${configPath}\nClick to choose a different file`}
          onClick={() => void window.rippon.config.choosePath()}
        >
          {configPath.replace(/^\/Users\/[^/]+/, '~')}
        </button>
      </header>

      {error ? (
        <div className="error-bar">
          {error}
          <button onClick={() => setError(null)}>×</button>
        </div>
      ) : null}

      <main className="tabs-body">
        {!ready ? <div className="empty">Loading config…</div> : null}
        {ready && config.tabs.length === 0 ? (
          <div className="empty">
            No tabs yet. <button onClick={addTab}>Create one</button>
          </div>
        ) : null}

        {config.tabs.map((tab) => (
          <TabPanel
            key={tab.id}
            tab={tab}
            active={tab.id === activeId}
            terminals={terminals.current}
            browsers={browsers.current}
            updateTab={updateTab}
          />
        ))}
      </main>

      {editingTab ? (
        <TabSettings
          tab={editingTab}
          onClose={() => setEditingId(null)}
          onDelete={() => {
            closeTab(editingTab.id)
            setEditingId(null)
          }}
          onSave={(next) => {
            updateTab(next.id, () => next)
            setEditingId(null)
          }}
        />
      ) : null}
    </div>
  )
}

interface TabPanelProps {
  tab: TabConfig
  active: boolean
  terminals: Map<string, TerminalHandle | null>
  browsers: Map<string, BrowserHandle | null>
  updateTab(id: string, patch: (t: TabConfig) => TabConfig): void
}

function TabPanel({ tab, active, terminals, browsers, updateTab }: TabPanelProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [dragRatio, setDragRatio] = useState<number | null>(null)
  const ratio = dragRatio ?? tab.splitRatio

  function startDrag(e: ReactPointerEvent<HTMLDivElement>): void {
    const container = containerRef.current
    if (!container) return
    e.currentTarget.setPointerCapture(e.pointerId)

    const move = (ev: PointerEvent): void => {
      const rect = container.getBoundingClientRect()
      const next = Math.min(0.85, Math.max(0.15, (ev.clientX - rect.left) / rect.width))
      setDragRatio(next)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDragRatio((final) => {
        if (final !== null) updateTab(tab.id, (t) => ({ ...t, splitRatio: final }))
        return null
      })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onUrlChange = useCallback(
    (url: string) => {
      updateTab(tab.id, (t) => (t.browser.url === url ? t : { ...t, browser: { url } }))
    },
    [tab.id, updateTab]
  )

  const openUrl = useCallback(
    (url: string) => {
      browsers.get(tab.id)?.navigate(url)
    },
    [browsers, tab.id]
  )

  return (
    <div
      ref={containerRef}
      className="tab-panel"
      style={{ display: active ? 'flex' : 'none' }}
    >
      <div className="split-left" style={{ width: `calc(${ratio * 100}% - 3px)` }}>
        <TerminalPane
          ref={(h) => {
            terminals.set(tab.id, h)
          }}
          tabId={tab.id}
          ssh={tab.ssh}
          active={active}
          onOpenUrl={openUrl}
        />
      </div>
      <div className="splitter" onPointerDown={startDrag} />
      <div className="split-right">
        <BrowserPane
          ref={(h) => {
            browsers.set(tab.id, h)
          }}
          url={tab.browser.url}
          active={active}
          onUrlChange={onUrlChange}
        />
      </div>
    </div>
  )
}
