import { app } from 'electron'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { defaultConfig, normalizeConfig, type RipponConfig } from '../shared/types'

/**
 * Config lives in a plain JSON file the user can point anywhere — typically
 * inside a Google Drive / Dropbox folder so tabs follow them across machines.
 * The *location* of that file is the one thing stored per-machine, in userData.
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
  private cache: RipponConfig = defaultConfig()
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

  async load(): Promise<RipponConfig> {
    try {
      const text = await fsp.readFile(this.currentPath, 'utf8')
      this.lastWritten = text
      this.cache = normalizeConfig(JSON.parse(text))
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== 'ENOENT') {
        this.emit('error', `Could not read ${this.currentPath}: ${e.message}`)
      }
      this.cache = defaultConfig()
      // Materialize the file so the user has something to sync / hand-edit.
      await this.save(this.cache)
    }
    this.startWatching()
    return this.cache
  }

  async save(cfg: RipponConfig): Promise<void> {
    const normalized = normalizeConfig(cfg)
    const text = JSON.stringify(normalized, null, 2) + '\n'
    if (text === this.lastWritten) return

    this.cache = normalized
    this.lastWritten = text

    await fsp.mkdir(path.dirname(this.currentPath), { recursive: true })
    // Write-then-rename so a half-written file is never synced or read.
    const tmp = `${this.currentPath}.${process.pid}.tmp`
    await fsp.writeFile(tmp, text)
    await fsp.rename(tmp, this.currentPath)
  }

  async setPath(newPath: string): Promise<RipponConfig> {
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
      this.cache = normalizeConfig(JSON.parse(text))
    } catch {
      this.emit('error', `${this.currentPath} is not valid JSON; ignoring the change.`)
      return
    }
    this.emit('external-change', this.cache)
  }

  dispose(): void {
    this.stopWatching()
  }
}
