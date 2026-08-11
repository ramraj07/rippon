export const CONFIG_VERSION = 5 as const

/**
 * One local port forward: a port on the remote host, reached over the SSH
 * connection and republished on this machine. `localhost:<localPort>` here maps
 * to `<remoteHost>:<remotePort>` as seen *from the remote machine* — so a dev
 * server bound to the box's own localhost shows up in a browser pane locally.
 * This is `ssh -L <localPort>:<remoteHost>:<remotePort>`.
 */
export interface Tunnel {
  localPort: number
  /** Host to connect to from the remote side. Almost always "localhost". */
  remoteHost: string
  remotePort: number
}

/** One SSH target for the whole app. Tabs are tmux sessions living on it. */
export interface SshConfig {
  host: string
  /** Extra flags for the ssh binary, e.g. ["-i", "/path/key.pem"]. */
  args: string[]
  /** Optional command tmux runs when a new session is created. */
  newSessionCommand?: string
  /** Local port forwards held open for as long as a host is configured. */
  tunnels: Tunnel[]
}

/** Live state of the background ssh process holding the forwards open. */
export interface TunnelStatus {
  running: boolean
  /** One label per forward, e.g. "localhost:8080 → localhost:3000". */
  forwards: string[]
  /** The last problem ssh reported (bind clash, auth, unreachable), or null. */
  error: string | null
}

export const PORT_MIN = 1
export const PORT_MAX = 65535
/** Conservative: these become bare `-L host:port` args, so keep them boring. */
export const REMOTE_HOST_RE = /^[A-Za-z0-9._-]+$/

export function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= PORT_MIN && value <= PORT_MAX
}

/** Validate one row of the tunnel editor; null means it is good to save. */
export function tunnelError(t: { localPort: unknown; remoteHost: string; remotePort: unknown }): string | null {
  if (!isPort(t.localPort)) return `Local port must be ${PORT_MIN}–${PORT_MAX}.`
  if (!isPort(t.remotePort)) return `Remote port must be ${PORT_MIN}–${PORT_MAX}.`
  if (t.remoteHost && !REMOTE_HOST_RE.test(t.remoteHost)) {
    return 'Remote host: letters, numbers, dot, dash and underscore only.'
  }
  return null
}

/** How a forward reads in the UI and in status labels. */
export function tunnelLabel(t: Tunnel): string {
  return `localhost:${t.localPort} → ${t.remoteHost || 'localhost'}:${t.remotePort}`
}

/** A saved page. Lives either on one session or on the config as a whole. */
export interface Bookmark {
  title: string
  url: string
}

export type BookmarkScope = 'global' | 'session'

/** Local decoration for a tmux session, keyed by session name. Shared by all views. */
export interface SessionConfig {
  url: string
  splitRatio: number
  /** Whether the browser pane is open. Off until asked for — see defaultSession. */
  showBrowser: boolean
  /** Pages saved for this session only — its PR, its dashboard. */
  bookmarks: Bookmark[]
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
  /**
   * Zoom for this view's browser panes. Chromium keeps zoom per origin on the
   * session, so it cannot differ between panes showing the same site — but a
   * whole view can carry its own, re-applied whenever the view becomes active.
   */
  zoom: number
}

export const ZOOM_MIN = 0.3
export const ZOOM_MAX = 2
export const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5]

export function clampZoom(value: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100))
}

/**
 * Everything that is presentation, not connection: layouts, tabs, per-session
 * decoration, bookmarks. Stored *on the remote host* under a profile name, so it
 * lives next to the tmux sessions it decorates and follows the box you work on
 * rather than the laptop you sit at. The SSH login is the boundary — anyone who
 * can get a shell as that user is trusted with these.
 */
export interface Profile {
  version: typeof CONFIG_VERSION
  /**
   * Detach a session's ssh client while it is off screen, reattaching when it
   * comes back. tmux keeps the session and its scrollback either way; this only
   * trades local buffering for one ssh channel per background pane.
   */
  detachHidden: boolean
  views: View[]
  activeViewId?: string
  sessions: Record<string, SessionConfig>
  /** Pages saved for every session. */
  bookmarks: Bookmark[]
}

/**
 * The per-machine file (`~/.rippon/config.json`). Just enough to open the
 * connection — host, flags, forwards — plus which profile to load from the box.
 * Everything else is in the Profile, remote.
 */
export interface LocalConfig {
  version: typeof CONFIG_VERSION
  ssh: SshConfig
  /** Name of the profile to load from the host. */
  activeProfile: string
}

/**
 * The merged view the renderer works with: local connection fields plus the
 * active profile's presentation. Split back apart by `splitConfig` on save.
 */
export interface RipponConfig {
  version: typeof CONFIG_VERSION
  ssh: SshConfig
  activeProfile: string
  detachHidden: boolean
  views: View[]
  activeViewId?: string
  sessions: Record<string, SessionConfig>
  bookmarks: Bookmark[]
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
  /** Reason the guest process died, or null if it is alive. */
  crashed: string | null
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
    zoom: 1,
    ...partial
  }
}

export function defaultProfile(): Profile {
  return {
    version: CONFIG_VERSION,
    detachHidden: false,
    views: [defaultView('view-main')],
    activeViewId: 'view-main',
    sessions: {},
    bookmarks: []
  }
}

export function defaultLocalConfig(): LocalConfig {
  return {
    version: CONFIG_VERSION,
    ssh: { host: '', args: [], tunnels: [] },
    activeProfile: DEFAULT_PROFILE
  }
}

export function defaultConfig(): RipponConfig {
  return mergeConfig(defaultLocalConfig(), defaultProfile())
}

/** Recombine the two persisted halves into what the renderer edits. */
export function mergeConfig(local: LocalConfig, profile: Profile): RipponConfig {
  return {
    version: CONFIG_VERSION,
    ssh: local.ssh,
    activeProfile: local.activeProfile,
    detachHidden: profile.detachHidden,
    views: profile.views,
    activeViewId: profile.activeViewId,
    sessions: profile.sessions,
    bookmarks: profile.bookmarks
  }
}

/** Tear the merged config back into the local file and the remote profile. */
export function splitConfig(cfg: RipponConfig): { local: LocalConfig; profile: Profile } {
  return {
    local: { version: CONFIG_VERSION, ssh: cfg.ssh, activeProfile: cfg.activeProfile },
    profile: {
      version: CONFIG_VERSION,
      detachHidden: cfg.detachHidden,
      views: cfg.views,
      activeViewId: cfg.activeViewId,
      sessions: cfg.sessions,
      bookmarks: cfg.bookmarks
    }
  }
}

/**
 * A session is a terminal until you ask for more. The browser pane costs a
 * renderer process each, so it is opened per session rather than by default.
 */
export function defaultSession(): SessionConfig {
  return { url: DEFAULT_URL, splitRatio: 0.5, showBrowser: false, bookmarks: [] }
}

function normalizeBookmarks(raw: unknown): Bookmark[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: Bookmark[] = []
  for (const b of raw) {
    if (!b || typeof b !== 'object') continue
    const { url, title } = b as Partial<Bookmark>
    if (typeof url !== 'string' || !/^https?:/i.test(url) || seen.has(url)) continue
    seen.add(url)
    out.push({ url, title: typeof title === 'string' && title ? title : bookmarkLabel(url) })
  }
  return out
}

/** Something short and recognisable when a page gives us no usable title. */
export function bookmarkLabel(url: string): string {
  try {
    const u = new URL(url)
    const tail = u.pathname.split('/').filter(Boolean).pop()
    return tail ? `${u.hostname.replace(/^www\./, '')}/${tail}` : u.hostname.replace(/^www\./, '')
  } catch {
    return url
  }
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

export const DEFAULT_PROFILE = 'default'
/** Profile names become `~/.rippon/profiles/<name>.json` on the host — same safe subset. */
export const PROFILE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

export function profileNameError(name: string): string | null {
  if (!name.trim()) return 'Name is required.'
  if (!PROFILE_NAME_RE.test(name)) {
    return 'Use letters, numbers, dashes and underscores only (max 64).'
  }
  return null
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** Drop anything malformed, and keep local ports unique — one listener each. */
function normalizeTunnels(raw: unknown): Tunnel[] {
  if (!Array.isArray(raw)) return []
  const out: Tunnel[] = []
  const seen = new Set<number>()
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue
    const t = value as Record<string, unknown>
    const remoteHost =
      typeof t.remoteHost === 'string' && t.remoteHost.trim() ? t.remoteHost.trim() : 'localhost'
    if (!isPort(t.localPort) || !isPort(t.remotePort)) continue
    if (!REMOTE_HOST_RE.test(remoteHost)) continue
    if (seen.has(t.localPort)) continue
    seen.add(t.localPort)
    out.push({ localPort: t.localPort, remoteHost, remotePort: t.remotePort })
  }
  return out
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
        : 210,
    zoom: typeof v.zoom === 'number' && Number.isFinite(v.zoom) ? clampZoom(v.zoom) : 1
  }
}

function normalizeSessions(raw: unknown): Record<string, SessionConfig> {
  const out: Record<string, SessionConfig> = {}
  const sessions = (raw ?? {}) as Record<string, unknown>
  for (const [name, value] of Object.entries(sessions)) {
    if (!SESSION_NAME_RE.test(name) || !value || typeof value !== 'object') continue
    const s = value as Partial<SessionConfig>
    out[name] = {
      url: typeof s.url === 'string' ? s.url : DEFAULT_URL,
      splitRatio:
        typeof s.splitRatio === 'number' ? Math.min(0.85, Math.max(0.15, s.splitRatio)) : 0.5,
      showBrowser: s.showBrowser === true,
      bookmarks: normalizeBookmarks(s.bookmarks)
    }
  }
  return out
}

function normalizeViews(cfg: Record<string, unknown>): { views: View[]; activeViewId: string } {
  let views: View[]
  if (Array.isArray(cfg.views) && cfg.views.length) {
    views = cfg.views.map(normalizeView)
  } else {
    // v2 and earlier had a single implicit vertical-tab view.
    views = [
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
  views = views.map((v, i) => {
    let id = v.id
    while (seen.has(id)) id = `${id}-${i}`
    seen.add(id)
    return { ...v, id }
  })

  const activeViewId =
    typeof cfg.activeViewId === 'string' && views.some((v) => v.id === cfg.activeViewId)
      ? cfg.activeViewId
      : views[0].id

  return { views, activeViewId }
}

/**
 * Coerce a remote profile file into a valid Profile. Also accepts a legacy
 * full config (v1–v4), whose presentation fields sit at the same keys, so the
 * one-time migration can lift them straight out.
 */
export function normalizeProfile(raw: unknown): Profile {
  const cfg = (raw ?? {}) as Record<string, unknown>
  const { views, activeViewId } = normalizeViews(cfg)
  return {
    version: CONFIG_VERSION,
    detachHidden: cfg.detachHidden === true,
    views,
    activeViewId,
    sessions: normalizeSessions(cfg.sessions),
    bookmarks: normalizeBookmarks(cfg.bookmarks)
  }
}

/** Coerce the local file — including a v1–v4 file that still held everything. */
export function normalizeLocalConfig(raw: unknown): LocalConfig {
  const cfg = (raw ?? {}) as Record<string, unknown>

  // v1 stored ssh settings per tab; carry the first tab's over and drop the rest.
  const legacyTabs = Array.isArray(cfg.tabs) ? (cfg.tabs as Array<Record<string, unknown>>) : null
  const rawSsh = (cfg.ssh ?? legacyTabs?.[0]?.ssh ?? {}) as Record<string, unknown>

  const ssh: SshConfig = {
    host: typeof rawSsh.host === 'string' ? rawSsh.host : '',
    args: strings(rawSsh.args),
    newSessionCommand:
      typeof rawSsh.newSessionCommand === 'string' ? rawSsh.newSessionCommand : undefined,
    tunnels: normalizeTunnels(rawSsh.tunnels)
  }
  // v1 kept the remote command on the tab; it is the closest thing to a session command.
  if (!ssh.newSessionCommand && typeof rawSsh.command === 'string' && rawSsh.command) {
    ssh.newSessionCommand = rawSsh.command
  }

  const activeProfile =
    typeof cfg.activeProfile === 'string' && PROFILE_NAME_RE.test(cfg.activeProfile)
      ? cfg.activeProfile
      : DEFAULT_PROFILE

  return { version: CONFIG_VERSION, ssh, activeProfile }
}

/** Coerce anything into the merged shape the renderer uses. */
export function normalizeConfig(raw: unknown): RipponConfig {
  return mergeConfig(normalizeLocalConfig(raw), normalizeProfile(raw))
}

/**
 * A pre-profiles file (v1–v4) that still carries presentation data and has no
 * `activeProfile`. The migration lifts its presentation up to a remote profile.
 */
export function looksLikeLegacyConfig(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  const r = raw as Record<string, unknown>
  if ('activeProfile' in r) return false
  return (
    'views' in r ||
    'sessions' in r ||
    'bookmarks' in r ||
    'hidden' in r ||
    'tabs' in r ||
    'activeViewId' in r ||
    'activeSession' in r
  )
}
