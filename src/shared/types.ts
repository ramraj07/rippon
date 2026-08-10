export const CONFIG_VERSION = 1 as const

/** One tab = one SSH session (left) + one browser view (right). */
export interface TabConfig {
  id: string
  title: string
  ssh: SshConfig
  browser: BrowserConfig
  /** Fraction of the tab width given to the terminal pane, 0.15–0.85. */
  splitRatio: number
}

export interface SshConfig {
  /** ssh_config alias or user@host. Passed straight to the ssh binary. */
  host: string
  /** Remote command to run, e.g. "tmux new -A -s agent". Empty = login shell. */
  command?: string
  /** Extra flags for ssh, e.g. ["-p", "2222"]. */
  args?: string[]
  /** Connect as soon as the app opens instead of on first tab activation. */
  autoConnect?: boolean
}

export interface BrowserConfig {
  url: string
}

export interface RipponConfig {
  version: typeof CONFIG_VERSION
  activeTabId?: string
  tabs: TabConfig[]
}

export type PtyStatus = 'idle' | 'running' | 'exited'

export function defaultConfig(): RipponConfig {
  return { version: CONFIG_VERSION, tabs: [] }
}

export function newTab(id: string, partial: Partial<TabConfig> = {}): TabConfig {
  return {
    id,
    title: partial.title ?? 'New tab',
    ssh: { host: '', command: '', ...(partial.ssh ?? {}) },
    browser: { url: 'https://github.com/pulls', ...(partial.browser ?? {}) },
    splitRatio: partial.splitRatio ?? 0.5
  }
}

/** Coerce anything read off disk into a valid config, dropping junk. */
export function normalizeConfig(raw: unknown): RipponConfig {
  const cfg = (raw ?? {}) as Partial<RipponConfig>
  const tabs = Array.isArray(cfg.tabs) ? cfg.tabs : []
  const seen = new Set<string>()
  const normTabs: TabConfig[] = []

  for (const [i, t] of tabs.entries()) {
    if (!t || typeof t !== 'object') continue
    let id = typeof t.id === 'string' && t.id ? t.id : `tab-${i}`
    while (seen.has(id)) id = `${id}-${i}`
    seen.add(id)

    const ssh = (t.ssh ?? {}) as Partial<SshConfig>
    const browser = (t.browser ?? {}) as Partial<BrowserConfig>
    const ratio = typeof t.splitRatio === 'number' ? t.splitRatio : 0.5

    normTabs.push({
      id,
      title: typeof t.title === 'string' && t.title ? t.title : ssh.host || 'Tab',
      ssh: {
        host: typeof ssh.host === 'string' ? ssh.host : '',
        command: typeof ssh.command === 'string' ? ssh.command : '',
        args: Array.isArray(ssh.args) ? ssh.args.filter((a) => typeof a === 'string') : [],
        autoConnect: ssh.autoConnect === true
      },
      browser: { url: typeof browser.url === 'string' ? browser.url : 'about:blank' },
      splitRatio: Math.min(0.85, Math.max(0.15, ratio))
    })
  }

  const activeTabId =
    typeof cfg.activeTabId === 'string' && normTabs.some((t) => t.id === cfg.activeTabId)
      ? cfg.activeTabId
      : normTabs[0]?.id

  return { version: CONFIG_VERSION, activeTabId, tabs: normTabs }
}
