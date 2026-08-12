import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type PointerEvent as ReactPointerEvent
} from 'react'
import TerminalPane, { type TerminalHandle } from './TerminalPane'
import BrowserPane, { type BrowserHandle } from './BrowserPane'
import SshSettings from './SshSettings'
import {
  CloseSessionDialog,
  ColumnsDialog,
  ContextMenu,
  ErrorDialog,
  NameDialog,
  TextDialog,
  ViewDialog,
  type MenuItem
} from './Dialogs'
import {
  defaultSession,
  defaultView,
  clampZoom,
  MAX_COLUMNS,
  MAX_TILES,
  normalizeConfig,
  profileNameError,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  suggestColumns,
  VIEW_TYPE_LABELS,
  type Bookmark,
  type BookmarkScope,
  type RipponConfig,
  type SessionConfig,
  type SessionInfo,
  type SshConfig,
  type TunnelStatus,
  type View,
  type ViewType
} from '@shared/types'

const SAVE_DEBOUNCE_MS = 400
const POLL_MS = 5000

type Dialog =
  | { kind: 'settings' }
  | { kind: 'new-session' }
  | { kind: 'rename-session'; name: string }
  | { kind: 'close-session'; name: string }
  | { kind: 'new-view' }
  | { kind: 'edit-view'; id: string }
  | { kind: 'fill-tiles' }
  | { kind: 'rename-bookmark'; scope: BookmarkScope; session: string; bookmark: Bookmark }
  | { kind: 'new-profile' }
  | { kind: 'rename-profile' }
  | { kind: 'error'; title: string; detail: string }
  | null

type Ctx = { x: number; y: number; items: MenuItem[] } | null

function makeViewId(): string {
  return `view-${Math.random().toString(36).slice(2, 9)}`
}

export default function App(): JSX.Element {
  const [config, setConfig] = useState<RipponConfig>(() => normalizeConfig({}))
  const [configPath, setConfigPath] = useState('')
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [ready, setReady] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [tunnelStatus, setTunnelStatus] = useState<TunnelStatus | null>(null)
  const [profiles, setProfiles] = useState<string[]>([])
  const [dialog, setDialog] = useState<Dialog>(null)
  const [ctx, setCtx] = useState<Ctx>(null)
  const [dragWidth, setDragWidth] = useState<number | null>(null)

  const terminals = useRef(new Map<string, TerminalHandle | null>())
  const browsers = useRef(new Map<string, BrowserHandle | null>())
  /**
   * Which half of the tab last held the keyboard, so ⌘F searches the pane the
   * user is actually looking at. A native browser view takes focus without the
   * renderer seeing any event, so the main process reports that side for us.
   */
  const focusedPane = useRef<'terminal' | 'browser'>('terminal')
  const noteTerminalFocus = useCallback(() => {
    focusedPane.current = 'terminal'
  }, [])
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Mirrors `config` for use inside stable callbacks and menu handlers. */
  const configRef = useRef(config)
  configRef.current = config

  const view = config.views.find((v) => v.id === config.activeViewId) ?? config.views[0]
  const tiled = view.type === 'tiled'

  /** Sessions this view shows in its tab strip / rail. */
  const listed = useMemo(
    () => sessions.filter((s) => !view.hidden.includes(s.name)),
    [sessions, view.hidden]
  )
  const hiddenExisting = useMemo(
    () => sessions.filter((s) => view.hidden.includes(s.name)),
    [sessions, view.hidden]
  )
  const live = useMemo(() => new Set(sessions.map((s) => s.name)), [sessions])

  const activeName = tiled
    ? (view.activeSession && view.tiles.includes(view.activeSession) ? view.activeSession : null) ??
      view.tiles.find((t): t is string => !!t && live.has(t)) ??
      null
    : listed.find((s) => s.name === view.activeSession)?.name ?? listed[0]?.name ?? null

  /** Sessions rendered on screen right now, and so worth attaching. */
  const onScreen = useMemo(() => {
    if (tiled) return new Set(view.tiles.filter((t): t is string => !!t && live.has(t)))
    return new Set(activeName ? [activeName] : [])
  }, [tiled, view.tiles, live, activeName])

  /** Which of the ⌘1–⌘9 slots maps to which session, per layout. */
  const indexed = tiled ? view.tiles : listed.map((s) => s.name)

  /** Single write path: update local state now, persist to disk debounced. */
  const commit = useCallback((next: RipponConfig) => {
    configRef.current = next
    setConfig(next)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void window.rippon.config.save(next), SAVE_DEBOUNCE_MS)
  }, [])

  /** Patch the active view. */
  const updateView = useCallback(
    (patch: Partial<View> | ((v: View) => Partial<View>)) => {
      const cur = configRef.current
      const id = cur.activeViewId
      commit({
        ...cur,
        views: cur.views.map((v) => (v.id === id ? { ...v, ...(typeof patch === 'function' ? patch(v) : patch) } : v))
      })
    },
    [commit]
  )

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

    // Drop references to sessions that no longer exist remotely.
    const names = new Set(res.value.map((s) => s.name))
    const cur = configRef.current
    let changed = false
    const views = cur.views.map((v) => {
      const hidden = v.hidden.filter((h) => names.has(h))
      const tiles = v.tiles.map((t) => (t && names.has(t) ? t : null))
      if (hidden.length !== v.hidden.length || tiles.some((t, i) => t !== v.tiles[i])) {
        changed = true
        return { ...v, hidden, tiles }
      }
      return v
    })
    if (changed) commit({ ...cur, views })
  }, [commit])

  const selectSession = useCallback(
    (name: string) => {
      if (configRef.current.views.find((v) => v.id === configRef.current.activeViewId)?.activeSession === name) {
        return
      }
      updateView({ activeSession: name })
    },
    [updateView]
  )

  const updateSession = useCallback(
    (name: string, patch: Partial<SessionConfig>) => {
      const cur = configRef.current
      const existing = cur.sessions[name] ?? defaultSession()
      const next = { ...existing, ...patch }
      if (
        next.url === existing.url &&
        next.splitRatio === existing.splitRatio &&
        next.showBrowser === existing.showBrowser
      ) {
        return
      }
      commit({ ...cur, sessions: { ...cur.sessions, [name]: next } })
    },
    [commit]
  )

  /** Pick what to show after `name` leaves the current view. */
  const neighbourOf = useCallback(
    (name: string): string | undefined => {
      const idx = listed.findIndex((s) => s.name === name)
      const rest = listed.filter((s) => s.name !== name)
      return rest[Math.min(Math.max(idx, 0), rest.length - 1)]?.name
    },
    [listed]
  )

  /**
   * Report a failed action the user asked for. Anything they clicked gets a
   * dialog with the message intact — the error bar is for the background poll,
   * where a modal every few seconds would be unusable, and it clips to one line
   * anyway.
   */
  const failed = useCallback((title: string, detail: string) => {
    setDialog({ kind: 'error', title, detail })
  }, [])

  // ---------- session actions ----------

  const createSession = useCallback(
    async (name: string) => {
      setDialog(null)
      const res = await window.rippon.tmux.create(configRef.current.ssh, name)
      if (!res.ok) {
        failed(`Could not create session “${name}”`, res.error)
        return
      }
      const cur = configRef.current
      commit({
        ...cur,
        sessions: { ...cur.sessions, [name]: cur.sessions[name] ?? defaultSession() },
        views: cur.views.map((v) => {
          if (v.id !== cur.activeViewId) return v
          const hidden = v.hidden.filter((h) => h !== name)
          if (v.type !== 'tiled') return { ...v, hidden, activeSession: name }
          // Drop it into the first free tile, adding one if the grid is full.
          const slot = v.tiles.findIndex((t) => t === null)
          const tiles =
            slot === -1
              ? v.tiles.length < MAX_TILES
                ? [...v.tiles, name]
                : v.tiles
              : v.tiles.map((t, i) => (i === slot ? name : t))
          return { ...v, hidden, tiles, activeSession: name }
        })
      })
      await refresh()
    },
    [commit, failed, refresh]
  )

  /** Remove from this view only; the session keeps running. */
  const hideSession = useCallback(
    (name: string) => {
      setDialog(null)
      updateView((v) =>
        v.type === 'tiled'
          ? { tiles: v.tiles.map((t) => (t === name ? null : t)) }
          : { hidden: [...new Set([...v.hidden, name])], activeSession: neighbourOf(name) }
      )
    },
    [neighbourOf, updateView]
  )

  const killSession = useCallback(
    async (name: string) => {
      setDialog(null)
      const next = neighbourOf(name)
      const res = await window.rippon.tmux.kill(configRef.current.ssh, name)
      if (!res.ok) {
        failed(`Could not kill session “${name}”`, res.error)
        return
      }
      const cur = configRef.current
      const { [name]: _gone, ...rest } = cur.sessions
      commit({
        ...cur,
        sessions: rest,
        views: cur.views.map((v) => ({
          ...v,
          hidden: v.hidden.filter((h) => h !== name),
          tiles: v.tiles.map((t) => (t === name ? null : t)),
          activeSession: v.activeSession === name ? (v.id === cur.activeViewId ? next : undefined) : v.activeSession
        }))
      })
      await refresh()
    },
    [commit, failed, neighbourOf, refresh]
  )

  const renameSession = useCallback(
    async (from: string, to: string) => {
      setDialog(null)
      if (from === to) return
      const res = await window.rippon.tmux.rename(configRef.current.ssh, from, to)
      if (!res.ok) {
        failed(`Could not rename “${from}” to “${to}”`, res.error)
        return
      }
      const cur = configRef.current
      const { [from]: moved, ...rest } = cur.sessions
      commit({
        ...cur,
        sessions: { ...rest, [to]: moved ?? defaultSession() },
        views: cur.views.map((v) => ({
          ...v,
          hidden: v.hidden.map((h) => (h === from ? to : h)),
          tiles: v.tiles.map((t) => (t === from ? to : t)),
          activeSession: v.activeSession === from ? to : v.activeSession
        }))
      })
      await refresh()
    },
    [commit, failed, refresh]
  )

  const restoreSession = useCallback(
    (name: string) => {
      updateView((v) => ({ hidden: v.hidden.filter((h) => h !== name), activeSession: name }))
    },
    [updateView]
  )

  // ---------- view actions ----------

  const selectView = useCallback(
    (id: string) => {
      if (configRef.current.activeViewId === id) return
      commit({ ...configRef.current, activeViewId: id })
    },
    [commit]
  )

  const addView = useCallback(
    (name: string, type: ViewType, zoom: number) => {
      setDialog(null)
      const cur = configRef.current
      const id = makeViewId()
      // A fresh tiled view starts with a grid sized to what is running.
      const names = sessions.map((s) => s.name)
      const v = defaultView(id, {
        name,
        type,
        zoom,
        columns: suggestColumns(names.length),
        tiles: type === 'tiled' ? names.slice(0, MAX_TILES) : []
      })
      commit({ ...cur, views: [...cur.views, v], activeViewId: id })
    },
    [commit, sessions]
  )

  const editView = useCallback(
    (id: string, name: string, type: ViewType, zoom: number) => {
      setDialog(null)
      const cur = configRef.current
      commit({
        ...cur,
        views: cur.views.map((v) => {
          if (v.id !== id) return v
          // Switching into an empty grid, seed it rather than showing nothing.
          const tiles =
            type === 'tiled' && v.tiles.every((t) => t === null)
              ? sessions.filter((s) => !v.hidden.includes(s.name)).map((s) => s.name).slice(0, MAX_TILES)
              : v.tiles
          const columns = type === 'tiled' && !v.tiles.length ? suggestColumns(tiles.length) : v.columns
          return { ...v, name, type, tiles, columns, zoom }
        })
      })
    },
    [commit, sessions]
  )

  const deleteView = useCallback(
    (id: string) => {
      const cur = configRef.current
      if (cur.views.length < 2) return
      const idx = cur.views.findIndex((v) => v.id === id)
      const views = cur.views.filter((v) => v.id !== id)
      commit({
        ...cur,
        views,
        activeViewId:
          cur.activeViewId === id ? views[Math.min(idx, views.length - 1)].id : cur.activeViewId
      })
    },
    [commit]
  )

  const assignTile = useCallback(
    (index: number, name: string | null) => {
      // Keep it one session per tile, so moving a session clears its old slot.
      updateView((v) => ({
        tiles: v.tiles.map((t, i) => (i === index ? name : t === name ? null : t)),
        activeSession: name ?? v.activeSession
      }))
    },
    [updateView]
  )

  const fillTiles = useCallback(
    (columns: number) => {
      setDialog(null)
      updateView({ columns, tiles: sessions.map((s) => s.name).slice(0, MAX_TILES) })
    },
    [sessions, updateView]
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
        if (final !== null) updateView({ sidebarWidth: final })
        return null
      })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** Global bookmarks live on the config; session ones on that session. */
  const editBookmarks = useCallback(
    (scope: BookmarkScope, name: string, fn: (list: Bookmark[]) => Bookmark[]) => {
      const cur = configRef.current
      if (scope === 'global') {
        commit({ ...cur, bookmarks: fn(cur.bookmarks) })
        return
      }
      const existing = cur.sessions[name] ?? defaultSession()
      commit({
        ...cur,
        sessions: { ...cur.sessions, [name]: { ...existing, bookmarks: fn(existing.bookmarks) } }
      })
    },
    [commit]
  )

  // ---------- profiles ----------

  /** Replace the whole in-memory config without re-persisting it. */
  const applyConfig = useCallback((next: RipponConfig) => {
    configRef.current = next
    setConfig(next)
  }, [])

  /** Re-fetch the active profile from the host — used to retry after it was down. */
  const reload = useCallback(async () => {
    const res = await window.rippon.config.reload()
    applyConfig(res.config)
    setProfiles(res.profiles)
    setListError(res.error)
    await refresh()
  }, [applyConfig, refresh])

  const saveSettings = useCallback(
    async (ssh: SshConfig, detachHidden: boolean) => {
      setDialog(null)
      const cur = configRef.current
      const hostChanged =
        ssh.host !== cur.ssh.host || ssh.args.join(' ') !== cur.ssh.args.join(' ')
      if (hostChanged) {
        // Save the connection change, then load the *new* host's profile rather
        // than pushing this host's layout onto it. detachHidden follows the
        // profile, so it comes from the new host, not this dialog.
        applyConfig({ ...cur, ssh })
        await window.rippon.config.saveLocal(ssh, cur.activeProfile)
        await reload()
      } else {
        // Same host: ordinary autosave, including detachHidden into the profile.
        commit({ ...cur, ssh, detachHidden })
        void refresh()
      }
    },
    [applyConfig, commit, reload, refresh]
  )

  const useProfile = useCallback(
    async (name: string) => {
      setCtx(null)
      if (name === configRef.current.activeProfile) return
      const res = await window.rippon.profile.use(name)
      if (!res.ok) {
        failed(`Could not switch to profile “${name}”`, res.error)
        return
      }
      setProfiles(res.value.profiles)
      applyConfig(res.value.config)
      setListError(null)
      await refresh()
    },
    [applyConfig, failed, refresh]
  )

  const createProfile = useCallback(
    async (name: string) => {
      setDialog(null)
      const res = await window.rippon.profile.create(name)
      if (!res.ok) {
        failed(`Could not create profile “${name}”`, res.error)
        return
      }
      setProfiles(res.value)
      await useProfile(name)
    },
    [failed, useProfile]
  )

  const renameProfile = useCallback(
    async (to: string) => {
      setDialog(null)
      const from = configRef.current.activeProfile
      if (from === to) return
      const res = await window.rippon.profile.rename(from, to)
      if (!res.ok) {
        failed(`Could not rename profile “${from}” to “${to}”`, res.error)
        return
      }
      setProfiles(res.value.profiles)
      applyConfig({ ...configRef.current, activeProfile: res.value.activeProfile })
    },
    [applyConfig, failed]
  )

  const deleteProfile = useCallback(async (name: string) => {
    setCtx(null)
    const res = await window.rippon.profile.delete(name)
    if (!res.ok) {
      failed(`Could not delete profile “${name}”`, res.error)
      return
    }
    setProfiles(res.value)
  }, [failed])

  const profileMenu = useCallback(
    (x: number, y: number) => {
      const cur = configRef.current
      const others = profiles.filter((p) => p !== cur.activeProfile)
      setCtx({
        x,
        y,
        items: [
          ...profiles.map((p) => ({
            label: p,
            checked: p === cur.activeProfile,
            onClick: () => void useProfile(p)
          })),
          { label: 'New profile…', separator: true, onClick: () => setDialog({ kind: 'new-profile' }) },
          { label: `Rename “${cur.activeProfile}”…`, onClick: () => setDialog({ kind: 'rename-profile' }) },
          ...(others.length
            ? [
                {
                  label: 'Delete a profile…',
                  danger: true,
                  onClick: () =>
                    setCtx({
                      x,
                      y,
                      items: others.map((p, i) => ({
                        label: `Delete “${p}”`,
                        danger: true,
                        separator: i === 0,
                        onClick: () => void deleteProfile(p)
                      }))
                    })
                }
              ]
            : [])
        ]
      })
    },
    [profiles, useProfile, deleteProfile]
  )

  // ---------- menus ----------

  const sessionMenuItems = useCallback(
    (name: string): MenuItem[] => {
      return [
        { label: 'Rename session…', onClick: () => setDialog({ kind: 'rename-session', name }) },
        {
          label: tiled ? 'Clear tile' : 'Close tab…',
          onClick: () => (tiled ? hideSession(name) : setDialog({ kind: 'close-session', name }))
        },
        {
          label: 'Kill session…',
          danger: true,
          separator: true,
          onClick: () => setDialog({ kind: 'close-session', name })
        }
      ]
    },
    [hideSession, tiled]
  )

  const sessionMenu = useCallback(
    (name: string, x: number, y: number) => setCtx({ x, y, items: sessionMenuItems(name) }),
    [sessionMenuItems]
  )

  /** Terminal actions first, then everything the session itself offers. */
  const terminalMenu = useCallback(
    (name: string, x: number, y: number, items: MenuItem[]) => {
      const session = sessionMenuItems(name)
      setCtx({ x, y, items: [...items, { ...session[0], separator: true }, ...session.slice(1)] })
    },
    [sessionMenuItems]
  )

  const viewMenu = useCallback(
    (v: View, x: number, y: number) => {
      const cur = configRef.current
      setCtx({
        x,
        y,
        items: [
          { label: 'Rename view…', onClick: () => setDialog({ kind: 'edit-view', id: v.id }) },
          ...(Object.keys(VIEW_TYPE_LABELS) as ViewType[]).map((t, i) => ({
            label: VIEW_TYPE_LABELS[t],
            checked: v.type === t,
            separator: i === 0,
            onClick: () => editView(v.id, v.name, t, v.zoom)
          })),
          ...(cur.views.length > 1
            ? [
                {
                  label: 'Delete view',
                  danger: true,
                  separator: true,
                  onClick: () => deleteView(v.id)
                }
              ]
            : [])
        ]
      })
    },
    [deleteView, editView]
  )

  // ---------- effects ----------

  useEffect(() => {
    void window.rippon.config.get().then(({ config: cfg, path, profiles: profs, error }) => {
      configRef.current = cfg
      setConfig(cfg)
      setConfigPath(path)
      setProfiles(profs)
      setReady(true)
      if (error) setListError(error)
      if (!cfg.ssh.host) setDialog({ kind: 'settings' })
      void refresh()
    })

    const offConfig = window.rippon.config.onChanged((cfg, path, profs) => {
      configRef.current = cfg
      setConfig(cfg)
      setConfigPath(path)
      setProfiles(profs)
      void refresh()
    })
    const offError = window.rippon.onError(setListError)
    return () => {
      offConfig()
      offError()
    }
  }, [refresh])

  // Keep the session list in step with the host.
  useEffect(() => {
    const timer = setInterval(() => void refresh(), POLL_MS)
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  // Follow the tunnel forwarder's state, seeded with whatever it is doing now.
  useEffect(() => {
    void window.rippon.tunnel.status().then(setTunnelStatus)
    return window.rippon.tunnel.onStatus(setTunnelStatus)
  }, [])

  // Reconcile the forwards whenever the host, flags or tunnel list changes —
  // covers first load, a saved change, and a config edited on another machine.
  const sshKey = JSON.stringify(config.ssh)
  useEffect(() => {
    void window.rippon.tunnel.sync(configRef.current.ssh)
  }, [sshKey])

  useEffect(() => {
    return window.rippon.browser.onFocused(() => {
      focusedPane.current = 'browser'
    })
  }, [])

  useEffect(() => {
    return window.rippon.onMenu((action, payload) => {
      const name = activeName

      /** The pane ⌘F applies to: whichever last had focus, if it is still there. */
      const findable = (): TerminalHandle | BrowserHandle | null => {
        if (!name) return null
        const browser = browsers.current.get(name) ?? null
        if (focusedPane.current === 'browser' && browser) return browser
        return terminals.current.get(name) ?? browser
      }

      switch (action) {
        case 'menu:new-session':
          return setDialog({ kind: 'new-session' })
        case 'menu:new-view':
          return setDialog({ kind: 'new-view' })
        case 'menu:settings':
          return setDialog({ kind: 'settings' })
        case 'menu:refresh':
          return void refresh()
        case 'menu:zoom': {
          const step = typeof payload === 'number' ? payload : 0
          return updateView((v) => ({
            zoom: step === 0 ? 1 : clampZoom(v.zoom * (step > 0 ? 1.1 : 1 / 1.1))
          }))
        }
        case 'menu:close-tab':
          return name ? setDialog({ kind: 'close-session', name }) : undefined
        case 'menu:cycle-view': {
          const cur = configRef.current
          if (cur.views.length < 2) return
          const i = cur.views.findIndex((v) => v.id === cur.activeViewId)
          const delta = typeof payload === 'number' ? payload : 1
          return selectView(cur.views[(i + delta + cur.views.length) % cur.views.length].id)
        }
        case 'menu:cycle-tab': {
          const names = indexed.filter((n): n is string => !!n)
          if (names.length < 2 || !name) return
          const i = names.indexOf(name)
          const delta = typeof payload === 'number' ? payload : 1
          return selectSession(names[(i + delta + names.length) % names.length])
        }
        case 'menu:select-tab-index': {
          const n = indexed[typeof payload === 'number' ? payload : 0]
          return n ? selectSession(n) : undefined
        }
        case 'menu:focus-address':
          return name ? browsers.current.get(name)?.focusAddress() : undefined
        case 'menu:focus-terminal':
          return name ? terminals.current.get(name)?.focus() : undefined
        case 'menu:reload-browser':
          return name ? browsers.current.get(name)?.reload() : undefined
        case 'menu:reconnect-ssh':
          return name ? terminals.current.get(name)?.reattach() : undefined
        case 'menu:find':
          return findable()?.openFind()
        case 'menu:find-step':
          return findable()?.stepFind(payload === -1 ? -1 : 1)
      }
    })
  }, [activeName, indexed, refresh, selectSession, selectView, updateView])

  // ---------- render ----------

  const rows = Math.max(1, Math.ceil(view.tiles.length / view.columns))
  const paneLayerStyle: CSSProperties = tiled
    ? {
        display: 'grid',
        gridTemplateColumns: `repeat(${view.columns}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
        gap: 4,
        padding: 4
      }
    : {}

  function tilePosition(index: number): CSSProperties {
    return {
      gridColumn: (index % view.columns) + 1,
      gridRow: Math.floor(index / view.columns) + 1
    }
  }

  const editingView = dialog?.kind === 'edit-view' ? config.views.find((v) => v.id === dialog.id) : null
  // Browser views are native and paint over the page, so they hide behind any overlay.
  const overlayOpen = dialog !== null || ctx !== null

  return (
    <div className="app">
      <header className="titlebar">
        <span className="wordmark">Rippon</span>
        <button
          className="profile-chip"
          title={`Profile: ${config.activeProfile}\nStored on ${config.ssh.host || 'the host'} — click to switch or manage`}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            profileMenu(r.left, r.bottom + 4)
          }}
        >
          {config.activeProfile} ▾
        </button>
        <div className="viewbar">
          {config.views.map((v) => (
            <button
              key={v.id}
              className={`view-chip ${v.id === view.id ? 'view-chip-active' : ''}`}
              title={`${v.name} — ${VIEW_TYPE_LABELS[v.type]}\nRight-click for layout and rename`}
              onClick={() => selectView(v.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                viewMenu(v, e.clientX, e.clientY)
              }}
            >
              {v.name}
            </button>
          ))}
          <button className="view-add" title="New view" onClick={() => setDialog({ kind: 'new-view' })}>
            ＋
          </button>
        </div>
        <span className="spacer" />
        {config.ssh.tunnels.length ? (
          <button
            className={`tunnel-chip tunnel-chip-${
              tunnelStatus?.error ? 'error' : tunnelStatus?.running ? 'ok' : 'idle'
            }`}
            title={`${
              tunnelStatus?.error
                ? `Tunnel error: ${tunnelStatus.error}`
                : tunnelStatus?.forwards.length
                  ? `Forwarding:\n${tunnelStatus.forwards.join('\n')}`
                  : 'Port forwards configured'
            }\nClick to manage`}
            onClick={() => setDialog({ kind: 'settings' })}
          >
            ⇄ {config.ssh.tunnels.length}
          </button>
        ) : null}
        <button
          className="host-btn"
          title={`${config.ssh.host || 'No host set'}\nConfig: ${configPath}`}
          onClick={() => setDialog({ kind: 'settings' })}
        >
          {config.ssh.host || 'set up SSH…'} ⚙
        </button>
      </header>

      {listError ? (
        <div className="error-bar">
          <span className="error-text-body">{listError}</span>
          <button onClick={() => void reload()}>retry</button>
          <button onClick={() => setListError(null)}>×</button>
        </div>
      ) : null}

      {view.type === 'tabs-horizontal' ? (
        <div className="tabstrip">
          {listed.map((s) => (
            <div
              key={s.name}
              className={`htab ${s.name === activeName ? 'htab-active' : ''}`}
              onClick={() => selectSession(s.name)}
              onDoubleClick={() => setDialog({ kind: 'rename-session', name: s.name })}
              onContextMenu={(e) => {
                e.preventDefault()
                sessionMenu(s.name, e.clientX, e.clientY)
              }}
              title={`${s.name} — ${s.windows} window(s)${s.attached ? ', attached' : ''}`}
            >
              <span className={`dot ${s.attached ? 'dot-attached' : ''}`} />
              <span className="htab-title">{s.name}</span>
              <button
                className="tab-close"
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation()
                  setDialog({ kind: 'close-session', name: s.name })
                }}
              >
                ×
              </button>
            </div>
          ))}
          <button
            className="strip-add"
            title="New session"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setCtx({
                x: r.left,
                y: r.bottom + 4,
                items: [
                  { label: 'New session…', onClick: () => setDialog({ kind: 'new-session' }) },
                  ...hiddenExisting.map((s, i) => ({
                    label: s.name,
                    separator: i === 0,
                    onClick: () => restoreSession(s.name)
                  }))
                ]
              })
            }}
          >
            ＋
          </button>
        </div>
      ) : null}

      {tiled ? (
        <div className="tilebar">
          <span className="tilebar-label">Columns</span>
          {Array.from({ length: MAX_COLUMNS }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              className={`radio-btn ${view.columns === n ? 'radio-active' : ''}`}
              onClick={() => updateView({ columns: n })}
            >
              {n}
            </button>
          ))}
          <span className="spacer" />
          <button className="bar-btn" onClick={() => setDialog({ kind: 'fill-tiles' })}>
            Tile all sessions…
          </button>
          <button
            className="bar-btn"
            disabled={view.tiles.length >= MAX_TILES}
            onClick={() => updateView((v) => ({ tiles: [...v.tiles, null] }))}
          >
            + Tile
          </button>
          <button className="bar-btn" onClick={() => setDialog({ kind: 'new-session' })}>
            + New session
          </button>
        </div>
      ) : null}

      <div className="body-row">
        {view.type === 'tabs-vertical' ? (
          <>
            <nav className="sidebar" style={{ width: dragWidth ?? view.sidebarWidth }}>
              <div className="sidebar-list">
                {listed.map((s) => (
                  <div
                    key={s.name}
                    className={`vtab ${s.name === activeName ? 'vtab-active' : ''}`}
                    onClick={() => selectSession(s.name)}
                    onDoubleClick={() => setDialog({ kind: 'rename-session', name: s.name })}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      sessionMenu(s.name, e.clientX, e.clientY)
                    }}
                    title={`${s.name} — ${s.windows} window(s)${s.attached ? ', attached' : ''}\nDouble-click or right-click to rename`}
                  >
                    <span className={`dot ${s.attached ? 'dot-attached' : ''}`} />
                    <span className="vtab-name">{s.name}</span>
                    <button
                      className="tab-close"
                      title="Close tab"
                      onClick={(e) => {
                        e.stopPropagation()
                        setDialog({ kind: 'close-session', name: s.name })
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
                <button className="new-session-btn" onClick={() => setDialog({ kind: 'new-session' })}>
                  + New session
                </button>
              </div>
            </nav>
            <div className="sidebar-resizer" onPointerDown={startSidebarDrag} />
          </>
        ) : null}

        <main className={`panes ${tiled ? 'panes-grid' : 'panes-stack'}`} style={paneLayerStyle}>
          {ready && !sessions.length ? (
            <div className="empty">
              {!config.ssh.host ? (
                <>
                  No host configured.
                  <button onClick={() => setDialog({ kind: 'settings' })}>Set up SSH</button>
                </>
              ) : (
                <>
                  No tmux sessions on {config.ssh.host}.
                  <button onClick={() => setDialog({ kind: 'new-session' })}>Create one</button>
                </>
              )}
            </div>
          ) : null}

          {/*
            Every live session keeps one pane, mounted here for the life of the
            session. Views only move it and show or hide it, so switching view
            never tears down a terminal or reloads a browser.
          */}
          {sessions.map((s) => {
            const tileIndex = tiled ? view.tiles.indexOf(s.name) : -1
            const visible = onScreen.has(s.name)
            return (
              <SessionPane
                key={s.name}
                session={s}
                ssh={config.ssh}
                visible={visible}
                suppressed={overlayOpen}
                zoom={view.zoom}
                focusOnShow={!tiled}
                detachHidden={config.detachHidden}
                settings={config.sessions[s.name] ?? defaultSession()}
                showBookmarks={!tiled}
                globalBookmarks={config.bookmarks}
                onEditBookmarks={editBookmarks}
                onRenameBookmark={(scope, bookmark) =>
                  setDialog({ kind: 'rename-bookmark', scope, session: s.name, bookmark })
                }
                onBrowserMenu={(x, y, items) => setCtx({ x, y, items })}
                terminals={terminals.current}
                browsers={browsers.current}
                style={tiled && tileIndex >= 0 ? tilePosition(tileIndex) : undefined}
                focused={tiled && s.name === activeName}
                tile={
                  tiled && tileIndex >= 0
                    ? {
                        options: sessions.map((o) => o.name),
                        onAssign: (n) => assignTile(tileIndex, n)
                      }
                    : undefined
                }
                onSelect={() => selectSession(s.name)}
                onUpdate={updateSession}
                onRename={() => setDialog({ kind: 'rename-session', name: s.name })}
                onContextMenu={(x, y) => sessionMenu(s.name, x, y)}
                onTerminalMenu={terminalMenu}
                onTerminalFocus={noteTerminalFocus}
              />
            )
          })}

          {tiled
            ? view.tiles.map((t, i) =>
                t && live.has(t) ? null : (
                  <div key={`empty-${i}`} className="tile-empty" style={tilePosition(i)}>
                    <select
                      className="tile-select"
                      value=""
                      onChange={(e) => assignTile(i, e.target.value || null)}
                    >
                      <option value="">Empty tile — choose a session</option>
                      {sessions.map((s) => (
                        <option key={s.name} value={s.name}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                    <button
                      className="bar-btn"
                      onClick={() => updateView((v) => ({ tiles: v.tiles.filter((_, j) => j !== i) }))}
                    >
                      Remove tile
                    </button>
                  </div>
                )
              )
            : null}
        </main>
      </div>

      {ctx ? <ContextMenu x={ctx.x} y={ctx.y} items={ctx.items} onClose={() => setCtx(null)} /> : null}

      {dialog?.kind === 'settings' ? (
        <SshSettings
          ssh={config.ssh}
          detachHidden={config.detachHidden}
          configPath={configPath}
          tunnelStatus={tunnelStatus}
          onSave={saveSettings}
          onClose={() => setDialog(null)}
          onChoosePath={() => void window.rippon.config.choosePath()}
        />
      ) : null}

      {dialog?.kind === 'new-session' ? (
        <NameDialog
          title="New tmux session"
          confirmLabel="Create"
          taken={sessions.map((s) => s.name)}
          onSubmit={(name) => void createSession(name)}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === 'rename-session' ? (
        <NameDialog
          title="Rename session"
          confirmLabel="Rename"
          initial={dialog.name}
          taken={sessions.map((s) => s.name)}
          onSubmit={(name) => void renameSession(dialog.name, name)}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === 'close-session' ? (
        <CloseSessionDialog
          name={dialog.name}
          tiled={tiled}
          onHide={() => hideSession(dialog.name)}
          onKill={() => void killSession(dialog.name)}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === 'new-view' ? (
        <ViewDialog
          title="New view"
          confirmLabel="Create"
          initialName={`View ${config.views.length + 1}`}
          onSubmit={addView}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {editingView ? (
        <ViewDialog
          title="Edit view"
          confirmLabel="Save"
          initialName={editingView.name}
          initialType={editingView.type}
          initialZoom={editingView.zoom}
          onSubmit={(name, type, zoom) => editView(editingView.id, name, type, zoom)}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === 'new-profile' ? (
        <NameDialog
          title="New profile"
          confirmLabel="Create"
          label="Profile name"
          placeholder="review"
          validate={profileNameError}
          takenMessage="A profile with that name already exists."
          taken={profiles}
          onSubmit={(name) => void createProfile(name)}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === 'rename-profile' ? (
        <NameDialog
          title="Rename profile"
          confirmLabel="Rename"
          label="Profile name"
          initial={config.activeProfile}
          validate={profileNameError}
          takenMessage="A profile with that name already exists."
          taken={profiles}
          onSubmit={(name) => void renameProfile(name)}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === 'rename-bookmark' ? (
        <TextDialog
          title="Rename bookmark"
          label="Name"
          confirmLabel="Save"
          initial={dialog.bookmark.title}
          onSubmit={(title) => {
            editBookmarks(dialog.scope, dialog.session, (list) =>
              list.map((b) => (b.url === dialog.bookmark.url ? { ...b, title } : b))
            )
            setDialog(null)
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === 'fill-tiles' ? (
        <ColumnsDialog
          count={sessions.length}
          suggestion={suggestColumns(sessions.length)}
          onSubmit={fillTiles}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === 'error' ? (
        <ErrorDialog
          title={dialog.title}
          detail={dialog.detail}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  )
}

interface SessionPaneProps {
  session: SessionInfo
  ssh: SshConfig
  visible: boolean
  /** Something is overlaying the app, so main-process browser views must hide. */
  suppressed: boolean
  zoom: number
  focusOnShow: boolean
  focused: boolean
  detachHidden: boolean
  settings: SessionConfig
  terminals: Map<string, TerminalHandle | null>
  browsers: Map<string, BrowserHandle | null>
  style?: CSSProperties
  tile?: { options: string[]; onAssign(name: string | null): void }
  onSelect(): void
  onUpdate(name: string, patch: Partial<SessionConfig>): void
  onRename(): void
  onContextMenu(x: number, y: number): void
  onTerminalMenu(name: string, x: number, y: number, items: MenuItem[]): void
  onTerminalFocus(name: string): void
  showBookmarks: boolean
  globalBookmarks: Bookmark[]
  onEditBookmarks(scope: BookmarkScope, name: string, fn: (list: Bookmark[]) => Bookmark[]): void
  onRenameBookmark(scope: BookmarkScope, bookmark: Bookmark): void
  onBrowserMenu(x: number, y: number, items: MenuItem[]): void
}

function SessionPane({
  session,
  ssh,
  visible,
  suppressed,
  zoom,
  focusOnShow,
  focused,
  detachHidden,
  settings,
  terminals,
  browsers,
  style,
  tile,
  onSelect,
  onUpdate,
  onRename,
  onContextMenu,
  onTerminalMenu,
  onTerminalFocus,
  showBookmarks,
  globalBookmarks,
  onEditBookmarks,
  onRenameBookmark,
  onBrowserMenu
}: SessionPaneProps): JSX.Element {
  const splitRef = useRef<HTMLDivElement>(null)
  const [dragRatio, setDragRatio] = useState<number | null>(null)
  const ratio = dragRatio ?? settings.splitRatio
  const name = session.name
  const showBrowser = settings.showBrowser

  function startDrag(e: ReactPointerEvent<HTMLDivElement>): void {
    const container = splitRef.current
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

  // A link clicked in the terminal opens the browser pane if it is closed.
  const openUrl = useCallback(
    (url: string) => {
      if (showBrowser) browsers.get(name)?.navigate(url)
      else onUpdate(name, { showBrowser: true, url })
    },
    [browsers, name, onUpdate, showBrowser]
  )

  return (
    <div
      className={`pane-slot ${tile ? 'pane-slot-tile' : ''} ${focused ? 'pane-slot-focused' : ''}`}
      style={{ ...style, display: visible ? 'flex' : 'none' }}
      onMouseDown={onSelect}
    >
      {tile ? (
        <div className="tile-header">
          <select
            className="tile-select"
            value={name}
            onChange={(e) => tile.onAssign(e.target.value || null)}
          >
            {tile.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          <span className="spacer" />
          <button
            className="icon-btn"
            title="Tile actions"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              onContextMenu(r.left, r.bottom + 4)
            }}
          >
            ⋯
          </button>
        </div>
      ) : null}

      <div className="split-row" ref={splitRef}>
        <div
          className="split-left"
          style={showBrowser ? { width: `calc(${ratio * 100}% - 3px)` } : { flex: 1 }}
        >
          <TerminalPane
            ref={(h) => {
              terminals.set(name, h)
            }}
            session={session}
            ssh={ssh}
            active={visible}
            focusOnShow={focusOnShow}
            detachWhenHidden={detachHidden}
            hasBrowser={showBrowser}
            onOpenUrl={openUrl}
            onRename={onRename}
            onOpenBrowser={() => onUpdate(name, { showBrowser: true })}
            onFocus={() => onTerminalFocus(name)}
            onContextMenu={(x, y, items) => onTerminalMenu(name, x, y, items)}
          />
        </div>
        {showBrowser ? (
          <>
            <div className="splitter" onPointerDown={startDrag} />
            <div className="split-right">
              <BrowserPane
                ref={(h) => {
                  browsers.set(name, h)
                }}
                id={name}
                url={settings.url}
                active={visible}
                suppressed={suppressed}
                zoom={zoom}
                showBookmarks={showBookmarks}
                globalBookmarks={globalBookmarks}
                sessionBookmarks={settings.bookmarks}
                onUrlChange={onUrlChange}
                onClose={() => onUpdate(name, { showBrowser: false })}
                onBookmarkAdd={(scope, bookmark) =>
                  onEditBookmarks(scope, name, (list) =>
                    list.some((b) => b.url === bookmark.url) ? list : [...list, bookmark]
                  )
                }
                onBookmarkRemove={(scope, bookmarkUrl) =>
                  onEditBookmarks(scope, name, (list) => list.filter((b) => b.url !== bookmarkUrl))
                }
                onBookmarkRename={onRenameBookmark}
                onContextMenu={onBrowserMenu}
              />
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
