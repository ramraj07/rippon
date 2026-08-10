export const CONFIG_VERSION = 2 as const

/** One SSH target for the whole app. Tabs are tmux sessions living on it. */
export interface SshConfig {
  host: string
  /** Extra flags for the ssh binary, e.g. ["-i", "/path/key.pem"]. */
  args: string[]
  /** Optional command tmux runs when a new session is created. */
  newSessionCommand?: string
}

/** Local decoration for a tmux session, keyed by session name. */
export interface SessionConfig {
  url: string
  splitRatio: number
}

export interface RipponConfig {
  version: typeof CONFIG_VERSION
  ssh: SshConfig
  activeSession?: string
  /** Sessions the user closed the tab for but chose to keep running. */
  hidden: string[]
  sessions: Record<string, SessionConfig>
}

/** A tmux session as reported by the remote host. */
export interface SessionInfo {
  name: string
  created: number
  attached: boolean
  windows: number
}

export const DEFAULT_URL = 'https://github.com/pulls'

export function defaultConfig(): RipponConfig {
  return {
    version: CONFIG_VERSION,
    ssh: { host: '', args: [] },
    hidden: [],
    sessions: {}
  }
}

export function defaultSession(): SessionConfig {
  return { url: DEFAULT_URL, splitRatio: 0.5 }
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

/** Coerce anything read off disk — including a v1 file — into a valid config. */
export function normalizeConfig(raw: unknown): RipponConfig {
  const cfg = (raw ?? {}) as Record<string, unknown>
  const out = defaultConfig()

  // v1 stored ssh settings per tab; carry the first tab's over and drop the rest.
  const legacyTabs = Array.isArray(cfg.tabs) ? (cfg.tabs as Array<Record<string, unknown>>) : null
  const rawSsh = (cfg.ssh ?? legacyTabs?.[0]?.ssh ?? {}) as Record<string, unknown>

  out.ssh = {
    host: typeof rawSsh.host === 'string' ? rawSsh.host : '',
    args: Array.isArray(rawSsh.args) ? rawSsh.args.filter((a): a is string => typeof a === 'string') : [],
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
        typeof s.splitRatio === 'number' ? Math.min(0.85, Math.max(0.15, s.splitRatio)) : 0.5
    }
  }

  out.hidden = Array.isArray(cfg.hidden)
    ? [...new Set(cfg.hidden.filter((h): h is string => typeof h === 'string'))]
    : []

  if (typeof cfg.activeSession === 'string') out.activeSession = cfg.activeSession

  return out
}
