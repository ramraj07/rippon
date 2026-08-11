import { app } from 'electron'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  defaultLocalConfig,
  looksLikeLegacyConfig,
  normalizeLocalConfig,
  normalizeProfile,
  type LocalConfig,
  type Profile
} from '../shared/types'

/**
 * The local file holds only what a machine needs to open the connection — host,
 * flags, forwards — plus which profile to load. Everything else lives in that
 * profile, on the remote host. The *location* of this local file is itself the
 * one thing stored per-machine, in userData.
 *
 * A pre-profiles file (v1–v4) still carries the full presentation on disk; on
 * load we keep it as a `pendingLegacyProfile` and leave the file untouched until
 * the migration has safely pushed it to the host, so a failed/offline migration
 * never loses anyone's layout.
 */

interface Settings {
  configPath: string
}

const POLL_INTERVAL_MS = 2000

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

function defaultConfigPath(): string {
  return path.join(os.homedir(), '.rippon', 'config.json')
}

function readSettings(): Settings {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Partial<Settings>
    if (typeof raw.configPath === 'string' && raw.configPath) {
      return { configPath: raw.configPath }
    }
  } catch {
    // no settings yet, or corrupt — fall through to the default
  }
  return { configPath: defaultConfigPath() }
}

function writeSettings(s: Settings): void {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2))
}

export class ConfigStore extends EventEmitter {
  private currentPath: string
  private local: LocalConfig = defaultLocalConfig()
  private pendingLegacy: Profile | null = null
  /** Serialized form of our last write, so we can ignore the watch event it causes. */
  private lastWritten = ''
  private watching = false

  constructor() {
    super()
    this.currentPath = readSettings().configPath
  }

  get filePath(): string {
    return this.currentPath
  }

  get current(): LocalConfig {
    return this.local
  }

  /** Presentation lifted from a pre-profiles file, awaiting migration to the host. */
  get pendingLegacyProfile(): Profile | null {
    return this.pendingLegacy
  }

  clearPendingLegacy(): void {
    this.pendingLegacy = null
  }

  async load(): Promise<LocalConfig> {
    try {
      const text = await fsp.readFile(this.currentPath, 'utf8')
      // Track the on-disk text so our own later write does not read as external.
      this.lastWritten = text
      const raw = JSON.parse(text)
      this.local = normalizeLocalConfig(raw)
      this.pendingLegacy = looksLikeLegacyConfig(raw) ? normalizeProfile(raw) : null
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== 'ENOENT') {
        this.emit('error', `Could not read ${this.currentPath}: ${e.message}`)
      }
      this.local = defaultLocalConfig()
      this.pendingLegacy = null
      // Materialize the file so the user has something to sync / hand-edit.
      await this.save(this.local)
    }
    this.startWatching()
    return this.local
  }

  async save(local: LocalConfig): Promise<void> {
    const normalized = normalizeLocalConfig(local)
    const text = JSON.stringify(normalized, null, 2) + '\n'
    if (text === this.lastWritten) return

    this.local = normalized
    this.lastWritten = text

    await fsp.mkdir(path.dirname(this.currentPath), { recursive: true })
    // Write-then-rename so a half-written file is never synced or read.
    const tmp = `${this.currentPath}.${process.pid}.tmp`
    await fsp.writeFile(tmp, text)
    await fsp.rename(tmp, this.currentPath)
  }

  async setPath(newPath: string): Promise<LocalConfig> {
    this.stopWatching()
    this.currentPath = newPath
    writeSettings({ configPath: newPath })
    this.lastWritten = ''
    return this.load()
  }

  /**
   * Polling rather than fs.watch: Drive/Dropbox replace the inode on sync, which
   * silently breaks a watcher bound to the old file.
   */
  private startWatching(): void {
    if (this.watching) return
    this.watching = true
    fs.watchFile(this.currentPath, { interval: POLL_INTERVAL_MS }, () => {
      void this.reloadIfChanged()
    })
  }

  private stopWatching(): void {
    if (!this.watching) return
    fs.unwatchFile(this.currentPath)
    this.watching = false
  }

  private async reloadIfChanged(): Promise<void> {
    let text: string
    try {
      text = await fsp.readFile(this.currentPath, 'utf8')
    } catch {
      return
    }
    if (text === this.lastWritten) return
    this.lastWritten = text
    try {
      const raw = JSON.parse(text)
      this.local = normalizeLocalConfig(raw)
      this.pendingLegacy = looksLikeLegacyConfig(raw) ? normalizeProfile(raw) : null
    } catch {
      this.emit('error', `${this.currentPath} is not valid JSON; ignoring the change.`)
      return
    }
    this.emit('external-change', this.local)
  }

  dispose(): void {
    this.stopWatching()
  }
}
