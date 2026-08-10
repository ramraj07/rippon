export const CONFIG_VERSION = 3 as const

/** One SSH target for the whole app. Tabs are tmux sessions living on it. */
export interface SshConfig {
  host: string
  /** Extra flags for the ssh binary, e.g. ["-i", "/path/key.pem"]. */
  args: string[]
  /** Optional command tmux runs when a new session is created. */
  newSessionCommand?: string
}

/** Local decoration for a tmux session, keyed by session name. Shared by all views. */
export interface SessionConfig {
  url: string
  splitRatio: number
  /** Whether the browser pane is open. Off until asked for — see defaultSession. */
  showBrowser: boolean
}

export type ViewType = 'tabs-horizontal' | 'tabs-vertical' | 'tiled'

/**
 * A view is a saved arrangement of the same underlying sessions: which of them
 * it shows, how they are laid out, and where its focus is. Sessions themselves
 * are global — a view never owns one.
 */
export interface View {
  id: string
  name: string
  type: ViewType
  /** Sessions this view does not show. Ignored by tiled views, which use `tiles`. */
  hidden: string[]
  /** Tab views: the session on screen. Tiled views: the tile keyboard commands act on. */
  activeSession?: string
  /** Tiled views: grid width. */
  columns: number
  /** Tiled views: one entry per tile, in reading order. null is an empty tile. */
  tiles: (string | null)[]
  /** Vertical tab views: rail width in px. */
  sidebarWidth: number
}

export interface RipponConfig {
  version: typeof CONFIG_VERSION
  ssh: SshConfig
  /**
   * Detach a session's ssh client while it is off screen, reattaching when it
   * comes back. tmux keeps the session and its scrollback either way; this only
   * trades local buffering for one ssh channel per background pane.
   */
  detachHidden: boolean
  views: View[]
  activeViewId?: string
  sessions: Record<string, SessionConfig>
}

/** Navigation state of a browser pane, pushed from the main process. */
export interface BrowserState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** The page wedged its renderer; it will not repaint or resize until reloaded. */
  hung: boolean
}

/** A tmux session as reported by the remote host. */
export interface SessionInfo {
  name: string
  created: number
  attached: boolean
  windows: number
}

export const DEFAULT_URL = 'https://github.com/pulls'
export const SIDEBAR_MIN = 140
export const SIDEBAR_MAX = 400
export const MAX_COLUMNS = 6
export const MAX_TILES = 24

export const VIEW_TYPE_LABELS: Record<ViewType, string> = {
  'tabs-horizontal': 'Horizontal tabs',
  'tabs-vertical': 'Vertical tabs',
  tiled: 'Tiled'
}

/** A grid that is as square as possible reads best; used to prefill the tile dialog. */
export function suggestColumns(count: number): number {
  return Math.min(MAX_COLUMNS, Math.max(1, Math.ceil(Math.sqrt(Math.max(count, 1)))))
}

export function defaultView(id: string, partial: Partial<View> = {}): View {
  return {
    id,
    name: 'Main',
    type: 'tabs-vertical',
    hidden: [],
    columns: 2,
    tiles: [],
    sidebarWidth: 210,
    ...partial
  }
}

export function defaultConfig(): RipponConfig {
  return {
    version: CONFIG_VERSION,
    ssh: { host: '', args: [] },
    detachHidden: false,
    views: [defaultView('view-main')],
    activeViewId: 'view-main',
    sessions: {}
  }
}

/**
 * A session is a terminal until you ask for more. The browser pane costs a
 * renderer process each, so it is opened per session rather than by default.
 */
export function defaultSession(): SessionConfig {
  return { url: DEFAULT_URL, splitRatio: 0.5, showBrowser: false }
}

/**
 * tmux forbids "." and ":" in session names, and anything needing shell quoting
 * would have to survive a trip through ssh, so keep it to a safe subset.
 */
export const SESSION_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

export function sessionNameError(name: string): string | null {
  if (!name.trim()) return 'Name is required.'
  if (!SESSION_NAME_RE.test(name)) {
    return 'Use letters, numbers, dashes and underscores only (max 64).'
  }
  return null
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function normalizeView(raw: unknown, index: number): View {
  const v = (raw ?? {}) as Record<string, unknown>
  const type =
    v.type === 'tabs-horizontal' || v.type === 'tabs-vertical' || v.type === 'tiled'
      ? v.type
      : 'tabs-vertical'

  const tiles = Array.isArray(v.tiles)
    ? v.tiles
        .slice(0, MAX_TILES)
        .map((t) => (typeof t === 'string' && SESSION_NAME_RE.test(t) ? t : null))
    : []

  return {
    id: typeof v.id === 'string' && v.id ? v.id : `view-${index}`,
    name: typeof v.name === 'string' && v.name ? v.name : `View ${index + 1}`,
    type,
    hidden: [...new Set(strings(v.hidden))],
    activeSession: typeof v.activeSession === 'string' ? v.activeSession : undefined,
    columns:
      typeof v.columns === 'number' && Number.isFinite(v.columns)
        ? Math.min(MAX_COLUMNS, Math.max(1, Math.round(v.columns)))
        : 2,
    tiles,
    sidebarWidth:
      typeof v.sidebarWidth === 'number' && Number.isFinite(v.sidebarWidth)
        ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(v.sidebarWidth)))
        : 210
  }
}

/** Coerce anything read off disk — including a v1 or v2 file — into a valid config. */
export function normalizeConfig(raw: unknown): RipponConfig {
  const cfg = (raw ?? {}) as Record<string, unknown>
  const out = defaultConfig()

  // v1 stored ssh settings per tab; carry the first tab's over and drop the rest.
  const legacyTabs = Array.isArray(cfg.tabs) ? (cfg.tabs as Array<Record<string, unknown>>) : null
  const rawSsh = (cfg.ssh ?? legacyTabs?.[0]?.ssh ?? {}) as Record<string, unknown>

  out.ssh = {
    host: typeof rawSsh.host === 'string' ? rawSsh.host : '',
    args: strings(rawSsh.args),
    newSessionCommand:
      typeof rawSsh.newSessionCommand === 'string' ? rawSsh.newSessionCommand : undefined
  }
  // v1 kept the remote command on the tab; it is the closest thing to a session command.
  if (!out.ssh.newSessionCommand && typeof rawSsh.command === 'string' && rawSsh.command) {
    out.ssh.newSessionCommand = rawSsh.command
  }

  const sessions = (cfg.sessions ?? {}) as Record<string, unknown>
  for (const [name, value] of Object.entries(sessions)) {
    if (!SESSION_NAME_RE.test(name) || !value || typeof value !== 'object') continue
    const s = value as Partial<SessionConfig>
    out.sessions[name] = {
      url: typeof s.url === 'string' ? s.url : DEFAULT_URL,
      splitRatio:
        typeof s.splitRatio === 'number' ? Math.min(0.85, Math.max(0.15, s.splitRatio)) : 0.5,
      showBrowser: s.showBrowser === true
    }
  }

  out.detachHidden = cfg.detachHidden === true

  if (Array.isArray(cfg.views) && cfg.views.length) {
    out.views = cfg.views.map(normalizeView)
  } else {
    // v2 and earlier had a single implicit vertical-tab view.
    out.views = [
      defaultView('view-main', {
        hidden: [...new Set(strings(cfg.hidden))],
        activeSession: typeof cfg.activeSession === 'string' ? cfg.activeSession : undefined,
        sidebarWidth:
          typeof cfg.sidebarWidth === 'number' && Number.isFinite(cfg.sidebarWidth)
            ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(cfg.sidebarWidth)))
            : 210
      })
    ]
  }

  // Ids must be unique or view selection breaks.
  const seen = new Set<string>()
  out.views = out.views.map((v, i) => {
    let id = v.id
    while (seen.has(id)) id = `${id}-${i}`
    seen.add(id)
    return { ...v, id }
  })

  out.activeViewId =
    typeof cfg.activeViewId === 'string' && out.views.some((v) => v.id === cfg.activeViewId)
      ? cfg.activeViewId
      : out.views[0].id

  return out
}
