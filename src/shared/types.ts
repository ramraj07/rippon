export const CONFIG_VERSION = 6 as const

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

/**
 * Where the tmux sessions live: another machine over ssh, or this one.
 *
 * `local` is not a special case bolted on the side — it is the same workspace
 * with the ssh hop removed. Every command still goes through `remote()`, which
 * runs it through a login shell here instead of handing it to ssh, so sessions,
 * profiles and the file browser all behave identically either way.
 */
export type HostKind = 'ssh' | 'local'

/** One target for the tab strip. Tabs are the tmux sessions living on it. */
export interface HostConfig {
  kind: HostKind
  /** The ssh destination. Empty, and unused, when `kind` is "local". */
  host: string
  /** Extra flags for the ssh binary, e.g. ["-i", "/path/key.pem"]. */
  args: string[]
  /** Optional command tmux runs when a new session is created. */
  newSessionCommand?: string
  /** Local port forwards held open for as long as a host is configured. */
  tunnels: Tunnel[]
}

/**
 * A configured host, as it appears in the switcher.
 *
 * The active profile is per-host on purpose: profiles are stored *on* the host
 * they decorate, so "default" on one box has nothing to do with "default" on
 * another, and switching hosts has to bring its own profile choice with it.
 */
export interface HostEntry extends HostConfig {
  id: string
  /** What the switcher shows. Falls back to the ssh destination when blank. */
  name: string
  activeProfile: string
}

/** A local host needs nothing filled in; an ssh one needs somewhere to go. */
export function hostConfigured(h: HostConfig): boolean {
  return h.kind === 'local' || !!h.host.trim()
}

/** How a host reads in a chip, a menu or a title. */
export function hostLabel(h: HostEntry): string {
  return h.name.trim() || (h.kind === 'local' ? 'Local' : h.host.trim() || 'unnamed host')
}

/** How a host reads mid-sentence — "no sessions on <this>". */
export function hostTarget(h: HostConfig): string {
  return h.kind === 'local' ? 'this machine' : h.host.trim() || 'the host'
}

export function defaultHost(id: string, partial: Partial<HostEntry> = {}): HostEntry {
  return {
    id,
    name: '',
    kind: 'ssh',
    host: '',
    args: [],
    tunnels: [],
    activeProfile: DEFAULT_PROFILE,
    ...partial
  }
}

/** Live state of the background ssh process holding the forwards open. */
export interface TunnelStatus {
  running: boolean
  /** One label per forward, e.g. "localhost:8080 → localhost:3000". */
  forwards: string[]
  /** The last problem ssh reported (bind clash, auth, unreachable), or null. */
  error: string | null
}

/** One entry in a remote directory listing. */
export interface RemoteEntry {
  name: string
  type: 'dir' | 'file' | 'link' | 'other'
  /** Whether following it lands on a directory — a symlink to one opens like one. */
  isDir: boolean
  size: number
  /** Seconds since the epoch, as the remote host reports them. */
  mtime: number
}

export interface RemoteListing {
  /** Where `cd` actually landed: absolute, with ~ and .. already resolved. */
  path: string
  entries: RemoteEntry[]
  /** True when the directory held more entries than the browser will carry. */
  truncated: boolean
}

/**
 * The head of a remote file, classified.
 *
 * `binary` carries no content on purpose — there is nothing useful to show, and
 * shipping the bytes to draw mojibake with would only make the dialog slower.
 */
export interface RemotePreview {
  path: string
  size: number
  /** True when the file is longer than the slice that was fetched. */
  truncated: boolean
  kind: 'text' | 'image' | 'binary'
  /** Text for `text`, a data URI for `image`, empty for `binary`. */
  content: string
}

/** Which part of the app produced a log entry. */
export type ActivitySource = 'ssh' | 'tmux' | 'profile' | 'tunnel' | 'pane'

export type ActivityLevel = 'info' | 'ok' | 'warn' | 'error'

/**
 * One line in the SSH activity log.
 *
 * The log exists because ssh failures are diagnosed from what ssh said and how
 * long it took, and until now the app kept neither: a call that hung was killed
 * silently and reported as a bare "Command failed". So `detail` holds the whole
 * of what ssh wrote rather than a summary of it, and `ms` is recorded even for
 * successes — a poll that usually takes 200ms and starts taking 8s is the
 * warning that something is going wrong, and it is invisible without a baseline.
 */
export interface ActivityEntry {
  /** Assigned in order within a run; also the renderer's row key. */
  seq: number
  at: number
  source: ActivitySource
  level: ActivityLevel
  text: string
  /** How long the call took, when the entry describes one. */
  ms?: number
  /** The full text ssh produced, shown when the row is expanded. */
  detail?: string
  /**
   * How many times this identical line has repeated. The session poll runs every
   * 5s, so without collapsing it would bury everything else within the hour.
   */
  count?: number
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
 * The per-machine file (`~/.rippon/config.json`). Just enough to open a
 * connection — the hosts, their flags and forwards, and which profile each one
 * loads. Everything else is in the Profile, on the host.
 */
export interface LocalConfig {
  version: typeof CONFIG_VERSION
  hosts: HostEntry[]
  activeHostId: string
}

/**
 * The merged view the renderer works with: the whole host list plus the active
 * host's presentation. Split back apart by `splitConfig` on save.
 *
 * The host list is carried whole rather than flattened to the active one, so
 * the switcher has something to draw without a second round trip — but only the
 * active host's profile is ever in hand, which is why switching hosts drops the
 * layout lock exactly as switching profiles does.
 */
export interface RipponConfig {
  version: typeof CONFIG_VERSION
  hosts: HostEntry[]
  activeHostId: string
  detachHidden: boolean
  views: View[]
  activeViewId?: string
  sessions: Record<string, SessionConfig>
  bookmarks: Bookmark[]
}

/**
 * The host the rest of the app means when it says "the host".
 *
 * Never null: an empty or dangling `activeHostId` falls back to the first entry,
 * and the normalizers guarantee there is always at least one. Callers that would
 * otherwise have to handle "no host configured" get an unconfigured host
 * instead, which `hostConfigured` answers for.
 */
export function activeHost(cfg: { hosts: HostEntry[]; activeHostId: string }): HostEntry {
  return cfg.hosts.find((h) => h.id === cfg.activeHostId) ?? cfg.hosts[0]
}

/** Replace the active host in place, keeping its position in the list. */
export function withActiveHost(cfg: RipponConfig, patch: Partial<HostEntry>): RipponConfig {
  const id = activeHost(cfg).id
  return { ...cfg, hosts: cfg.hosts.map((h) => (h.id === id ? { ...h, ...patch } : h)) }
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

/**
 * How a search is going, in a browser pane or a terminal. Both panes report the
 * same shape so one find bar can render either.
 */
export interface FindMatches {
  /** 1-based position of the highlighted match, or 0 when nothing matched. */
  active: number
  total: number
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
  return { version: CONFIG_VERSION, hosts: [defaultHost('host-1')], activeHostId: 'host-1' }
}

export function defaultConfig(): RipponConfig {
  return mergeConfig(defaultLocalConfig(), defaultProfile())
}

/** Recombine the two persisted halves into what the renderer edits. */
export function mergeConfig(local: LocalConfig, profile: Profile): RipponConfig {
  return {
    version: CONFIG_VERSION,
    hosts: local.hosts,
    activeHostId: local.activeHostId,
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
    local: { version: CONFIG_VERSION, hosts: cfg.hosts, activeHostId: cfg.activeHostId },
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

/**
 * Coerce one host entry, from a v6 file or from the single-host shape that
 * every earlier version stored under `ssh`.
 */
function normalizeHost(raw: unknown, index: number): HostEntry {
  const h = (raw ?? {}) as Record<string, unknown>
  const kind: HostKind = h.kind === 'local' ? 'local' : 'ssh'
  const entry: HostEntry = {
    id: typeof h.id === 'string' && h.id ? h.id : `host-${index + 1}`,
    name: typeof h.name === 'string' ? h.name : '',
    kind,
    host: kind === 'local' ? '' : typeof h.host === 'string' ? h.host : '',
    args: strings(h.args),
    // A local host has no ssh to forward over, and its "remote" ports are
    // already this machine's — so both are dropped rather than kept and ignored.
    tunnels: kind === 'local' ? [] : normalizeTunnels(h.tunnels),
    activeProfile:
      typeof h.activeProfile === 'string' && PROFILE_NAME_RE.test(h.activeProfile)
        ? h.activeProfile
        : DEFAULT_PROFILE
  }
  if (typeof h.newSessionCommand === 'string' && h.newSessionCommand) {
    entry.newSessionCommand = h.newSessionCommand
  }
  // v1 kept the remote command on the tab; it is the closest thing to a session command.
  if (!entry.newSessionCommand && typeof h.command === 'string' && h.command) {
    entry.newSessionCommand = h.command
  }
  if (kind === 'local') entry.args = []
  return entry
}

/**
 * Coerce the local file — v6, or any earlier version, which held exactly one
 * host and stored it inline under `ssh`.
 *
 * The result always has at least one host: an empty list would leave the app
 * with nothing to select and nothing to offer the settings dialog to edit.
 */
export function normalizeLocalConfig(raw: unknown): LocalConfig {
  const cfg = (raw ?? {}) as Record<string, unknown>

  let hosts: HostEntry[]
  if (Array.isArray(cfg.hosts) && cfg.hosts.length) {
    hosts = cfg.hosts.map(normalizeHost)
  } else {
    // v1 stored ssh settings per tab; carry the first tab's over and drop the rest.
    const legacyTabs = Array.isArray(cfg.tabs) ? (cfg.tabs as Array<Record<string, unknown>>) : null
    const rawSsh = (cfg.ssh ?? legacyTabs?.[0]?.ssh ?? {}) as Record<string, unknown>
    hosts = [normalizeHost({ ...rawSsh, kind: 'ssh', activeProfile: cfg.activeProfile }, 0)]
  }

  // Ids must be unique or host selection picks the wrong one.
  const seen = new Set<string>()
  hosts = hosts.map((h, i) => {
    let id = h.id
    while (seen.has(id)) id = `${id}-${i}`
    seen.add(id)
    return { ...h, id }
  })

  const activeHostId =
    typeof cfg.activeHostId === 'string' && hosts.some((h) => h.id === cfg.activeHostId)
      ? cfg.activeHostId
      : hosts[0].id

  return { version: CONFIG_VERSION, hosts, activeHostId }
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
  if ('hosts' in r || 'activeProfile' in r) return false
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
