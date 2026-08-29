import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  powerMonitor,
  session,
  shell,
  type MenuItemConstructorOptions,
  type Rectangle
} from 'electron'
import path from 'node:path'
import { activity } from './activity'
import { BROWSER_PARTITION, BrowserViews } from './browser'
import { ConfigStore } from './config'
import { downloadFile, listDir, previewFile } from './files'
import { HealthMonitor } from './health'
import {
  createProfile,
  deleteProfile,
  listProfiles,
  readProfile,
  renameProfile,
  writeProfile
} from './profiles'
import { PtyManager } from './pty'
import {
  createSession,
  getMouseMode,
  killSession,
  listSessions,
  renameSession,
  setMouseMode
} from './tmux'
import { TunnelManager } from './tunnel'
import {
  activeHost,
  defaultProfile,
  hostConfigured,
  mergeConfig,
  splitConfig,
  type HostEntry,
  type LocalConfig,
  type Profile,
  type RipponConfig,
  type ActivityEntry,
  type SessionInfo,
  type HostConfig,
  type TunnelStatus
} from '../shared/types'
import type { BrowserState, FindMatches } from '../shared/types'

/*
 * Pin the profile directory. A packaged build takes its name from productName
 * ("Rippon") while a dev run takes it from package.json ("rippon"), so the two
 * would keep separate cookie jars — every browser login would have to be done
 * twice. Must run before ready.
 */
app.setPath('userData', path.join(app.getPath('appData'), 'rippon'))

const configStore = new ConfigStore()
const ptys = new PtyManager()
const browsers = new BrowserViews()
const tunnels = new TunnelManager()
let mainWindow: BrowserWindow | null = null
/**
 * Whether the screen is locked or the machine asleep. Tracked rather than
 * queried because there is no "is it locked" to ask — only the transitions.
 */
let screenLocked = false
/**
 * Only supervise the connection while someone is actually looking at the app.
 * A backgrounded window on a locked laptop has nothing to gain from a live
 * connection, and repairing one there would drop panes nobody is watching.
 */
const health = new HealthMonitor(
  () => activeHost(configStore.current),
  tunnels,
  () =>
    !shuttingDown &&
    !screenLocked &&
    !!mainWindow &&
    !mainWindow.isDestroyed() &&
    mainWindow.isVisible() &&
    !mainWindow.isMinimized() &&
    mainWindow.isFocused()
)
/**
 * Set the moment teardown starts. The render frame is disposed before the
 * window reports itself destroyed, and webContents.send logs its own error
 * asynchronously from inside — a try/catch around the call cannot suppress it.
 * The only fix is to stop sending, so pty output in flight is dropped here.
 */
let shuttingDown = false

function send(channel: string, ...args: unknown[]): void {
  if (shuttingDown || !mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.webContents.isDestroyed()) return
  mainWindow.webContents.send(channel, ...args)
}

function beginShutdown(): void {
  shuttingDown = true
  ptys.killAll()
  tunnels.stop()
  browsers.destroyAll()
}

function createWindow(): void {
  // On macOS the app outlives its window, so a reopen starts a fresh session.
  shuttingDown = false
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 900,
    minHeight: 500,
    show: false,
    backgroundColor: '#14161a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  browsers.attach(mainWindow)
  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // The renderer is where nearly all of this app lives, and a crash there is
  // otherwise invisible: the window just sits blank with an empty main log.
  mainWindow.webContents.on(
    'console-message',
    (_e, level: number, message: string, line: number, sourceId: string) => {
      if (level >= 2) console.error(`[renderer] ${message}  (${sourceId}:${line})`)
    }
  )
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer gone]', JSON.stringify(details))
  })
  mainWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error(`[preload] ${preloadPath}: ${error.message}`)
  })

  if (process.env['RIPPON_DEBUG_SELECT']) {
    setTimeout(async () => {
      const wc = mainWindow?.webContents
      if (!wc) return
      const rect = await wc.executeJavaScript(`(() => {
        const el = document.querySelector('.pane-slot:not([style*="display: none"]) .terminal-host')
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height }
      })()`)
      if (!rect) {
        console.log('[select] no visible terminal host found')
        return
      }
      const x0 = Math.round(rect.x + 12)
      const y0 = Math.round(rect.y + 30)

      // What is actually under the pointer where the drag begins?
      const hit = await wc.executeJavaScript(`(() => {
        const el = document.elementFromPoint(${x0}, ${y0})
        if (!el) return 'nothing'
        const path = []
        for (let e = el; e && path.length < 5; e = e.parentElement) {
          path.push(e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).split(' ').join('.') : ''))
        }
        return path.join(' < ')
      })()`)
      console.log(`[select] drag from (${x0},${y0}) over ${JSON.stringify(rect)}`)
      console.log(`[select] element at point: ${hit}`)
      const opts = await wc.executeJavaScript(`(() => {
        const m = window.__rippon_terminals
        if (!m) return 'no map'
        const t = [...m.values()][0]
        return JSON.stringify({
          macOptionClickForcesSelection: t.options.macOptionClickForcesSelection,
          rightClickSelectsWord: t.options.rightClickSelectsWord
        })
      })()`)
      console.log(`[select] live options: ${opts}`)

      await wc.executeJavaScript(`(() => {
        window.__selProbe = { down: 0, move: 0, up: 0 }
        document.addEventListener('mousedown', () => window.__selProbe.down++, true)
        document.addEventListener('mousemove', () => window.__selProbe.move++, true)
        document.addEventListener('mouseup', () => window.__selProbe.up++, true)
      })()`)

      const dragWith = async (modifiers: string[]): Promise<void> => {
        const mods = modifiers as Parameters<typeof wc.sendInputEvent>[0]['modifiers']
        wc.sendInputEvent({ type: 'mouseDown', x: x0, y: y0, button: 'left', clickCount: 1, modifiers: mods })
        for (let i = 1; i <= 10; i++) {
          wc.sendInputEvent({
            type: 'mouseMove',
            x: Math.round(x0 + (rect.w - 30) * (i / 10)),
            y: Math.round(y0 + 40 * (i / 10)),
            button: 'left',
            modifiers: mods
          })
          await new Promise((r) => setTimeout(r, 40))
        }
        wc.sendInputEvent({
          type: 'mouseUp',
          x: Math.round(x0 + rect.w - 30),
          y: Math.round(y0 + 40),
          button: 'left',
          clickCount: 1,
          modifiers: mods
        })
        await new Promise((r) => setTimeout(r, 500))
      }

      const report = async (label: string): Promise<void> => {
        const out = await wc.executeJavaScript(`(() => {
          const m = window.__rippon_terminals
          if (!m) return 'no map'
          return JSON.stringify([...m.entries()].map(([id, t]) => ({
            id,
            text: t.getSelection().slice(0, 30),
            range: t.getSelectionPosition() || null
          })).filter((r) => r.text || r.range))
        })()`)
        console.log(`[select] ${label}: ${out}`)
      }

      await dragWith([])
      await report('plain drag')
      await dragWith(['alt'])
      await report('option drag')
      await dragWith(['shift'])
      await report('shift drag ')
    }, 16000)
  }

  if (process.env['RIPPON_DEBUG_MAXIMIZE']) {
    setTimeout(() => {
      console.log('[debug] maximize')
      mainWindow?.maximize()
    }, 18000)
    setTimeout(() => {
      console.log('[debug] unmaximize')
      mainWindow?.unmaximize()
    }, 28000)
    setTimeout(() => {
      console.log('[debug] maximize again')
      mainWindow?.maximize()
    }, 36000)
  }

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('close', beginShutdown)
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/**
 * Strip "Electron" and our app name out of the UA. Several SSO providers
 * reject unknown embedded browsers outright.
 */
function configureBrowserSession(): void {
  const s = session.fromPartition(BROWSER_PARTITION)
  const ua = s
    .getUserAgent()
    .replace(/ Electron\/[\d.]+/, '')
    .replace(new RegExp(` ${app.getName()}\\/[\\d.]+`, 'i'), '')
  s.setUserAgent(ua)
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const tabItems: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) => ({
    label: `Tab ${i + 1}`,
    accelerator: `CmdOrCtrl+${i + 1}`,
    visible: false,
    click: () => send('menu:select-tab-index', i)
  }))

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            role: 'appMenu' as const,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              {
                label: 'Settings…',
                accelerator: 'CmdOrCtrl+,',
                click: () => send('menu:settings')
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New tmux Session…',
          accelerator: 'CmdOrCtrl+T',
          click: () => send('menu:new-session')
        },
        {
          label: 'New View…',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => send('menu:new-view')
        },
        { label: 'Close Tab…', accelerator: 'CmdOrCtrl+W', click: () => send('menu:close-tab') },
        {
          label: 'Browse Remote Files…',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => send('menu:files')
        },
        {
          label: 'Refresh Session List',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: () => send('menu:refresh')
        },
        { type: 'separator' },
        ...(isMac
          ? []
          : [{ label: 'Settings…', accelerator: 'Ctrl+,', click: () => send('menu:settings') }]),
        {
          label: 'Choose Config File…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => void pickConfigFile()
        },
        { label: 'Reveal Config File', click: () => shell.showItemInFolder(configStore.filePath) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    /*
     * Spelled out rather than `role: 'editMenu'` so Find can live where macOS
     * expects it. The accelerators are what matter: a menu accelerator fires
     * whichever web contents holds focus, which is the only way ⌘F reaches us
     * while a native browser view has the keyboard.
     */
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => send('menu:find') },
        {
          label: 'Find Next',
          accelerator: 'CmdOrCtrl+G',
          click: () => send('menu:find-step', 1)
        },
        {
          label: 'Find Previous',
          accelerator: 'CmdOrCtrl+Shift+G',
          click: () => send('menu:find-step', -1)
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Focus Address Bar',
          accelerator: 'CmdOrCtrl+L',
          click: () => send('menu:focus-address')
        },
        {
          label: 'Focus Terminal',
          accelerator: 'CmdOrCtrl+J',
          click: () => send('menu:focus-terminal')
        },
        { type: 'separator' },
        {
          label: 'Reload Browser Pane',
          accelerator: 'CmdOrCtrl+R',
          click: () => send('menu:reload-browser')
        },
        {
          label: 'Reattach Session',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => send('menu:reconnect-ssh')
        },
        { type: 'separator' },
        {
          label: 'Zoom In (this view)',
          accelerator: 'CmdOrCtrl+Plus',
          click: () => send('menu:zoom', 1)
        },
        {
          label: 'Zoom Out (this view)',
          accelerator: 'CmdOrCtrl+-',
          click: () => send('menu:zoom', -1)
        },
        {
          label: 'Actual Size',
          accelerator: 'CmdOrCtrl+0',
          click: () => send('menu:zoom', 0)
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Tabs',
      submenu: [
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => send('menu:cycle-tab', 1) },
        {
          label: 'Previous Tab',
          accelerator: 'Ctrl+Shift+Tab',
          click: () => send('menu:cycle-tab', -1)
        },
        { type: 'separator' },
        {
          label: 'Next View',
          accelerator: 'CmdOrCtrl+Alt+Right',
          click: () => send('menu:cycle-view', 1)
        },
        {
          label: 'Previous View',
          accelerator: 'CmdOrCtrl+Alt+Left',
          click: () => send('menu:cycle-view', -1)
        },
        { type: 'separator' },
        ...tabItems
      ]
    },
    { role: 'windowMenu' }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function pickConfigFile(): Promise<void> {
  if (!mainWindow) return
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose or create a Rippon config file',
    defaultPath: configStore.filePath,
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile', 'createDirectory', 'promptToCreate']
  })
  if (result.canceled || !result.filePaths[0]) return

  ptys.killAll()
  tunnels.stop()
  await configStore.setPath(result.filePaths[0])
  // A different file means a different host and profile: hand the renderer the
  // local half and let its connect loop fetch the presentation half.
  profileLoaded = false
  send('config:changed', ...changedArgs(localPayload()))
}

/** Wrap a remote call so the renderer always gets {ok} or {error} instead of a rejection. */
async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

interface ConfigPayload {
  config: RipponConfig
  path: string
  profiles: string[]
  error: string | null
  /** True only when `config`'s presentation half really came off the host. */
  loaded: boolean
}

/**
 * Whether the profile currently in play was read from the host.
 *
 * Views, tiles and bookmarks live in a profile on the remote box, so before the
 * first successful read there is no layout — only a placeholder. Writing that
 * placeholder back would erase the real profile, so this gates every profile
 * write, and the renderer keeps its layout UI locked until it sees it true. It
 * stays true for the rest of the run once set: from then on the in-memory
 * profile *is* the host's, so a connection that drops later is safe to save
 * through. Only a change of host, profile or config file clears it.
 */
let profileLoaded = false

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The host everything below acts on. Always present — see `activeHost`. */
function host(): HostEntry {
  return activeHost(configStore.current)
}

/** Persist a change to the active host entry, leaving the others alone. */
async function saveHost(patch: Partial<HostEntry>): Promise<void> {
  const local = configStore.current
  const id = host().id
  await configStore.save({
    ...local,
    hosts: local.hosts.map((h) => (h.id === id ? { ...h, ...patch } : h))
  })
}

/**
 * The local half alone — instant, no network, nothing that can touch the host.
 * The presentation fields are placeholders and `loaded: false` says so.
 */
function localPayload(): ConfigPayload {
  const local = configStore.current
  return {
    config: mergeConfig(local, defaultProfile()),
    path: configStore.filePath,
    profiles: [activeHost(local).activeProfile],
    error: null,
    loaded: false
  }
}

/** Arguments for the `config:changed` push, in the order the preload unpacks them. */
function changedArgs(payload: ConfigPayload): [RipponConfig, string, string[], boolean] {
  return [payload.config, payload.path, payload.profiles, payload.loaded]
}

/**
 * Fetch the active profile from the host, running the one-time migration of a
 * pre-profiles file if one is pending. Safe to call repeatedly — this is what
 * the renderer's reconnect loop retries — and it reports failure rather than
 * inventing a layout, so a host that is merely slow to come up loses nothing.
 */
async function connect(): Promise<ConfigPayload> {
  const local: LocalConfig = configStore.current
  const ssh = activeHost(local)
  if (!hostConfigured(ssh)) return localPayload()

  const pending = configStore.pendingLegacyProfile
  let profile: Profile
  try {
    const remote = await readProfile(ssh, ssh.activeProfile)
    if (remote) {
      profile = remote
    } else {
      // No file on the host: seed it — from the pending legacy layout if this is
      // a migration, otherwise an empty default so the profile exists to list.
      profile = pending ?? defaultProfile()
      await writeProfile(ssh, ssh.activeProfile, profile)
    }
    if (pending) {
      // Migration landed: shrink the local file so it never re-migrates.
      configStore.clearPendingLegacy()
      await configStore.save(local)
    }
  } catch (err) {
    profileLoaded = false
    return { ...localPayload(), error: message(err) }
  }

  let profiles: string[] = []
  try {
    profiles = await listProfiles(ssh)
  } catch {
    // Listing is a nicety; a failure here should not block the layout.
  }
  if (!profiles.includes(ssh.activeProfile)) {
    profiles = [...profiles, ssh.activeProfile].sort((a, b) => a.localeCompare(b))
  }

  profileLoaded = true
  return {
    config: mergeConfig(local, profile),
    path: configStore.filePath,
    profiles,
    error: null,
    loaded: true
  }
}

function registerIpc(): void {
  // Boot: the local file only, so the window can paint the host it is about to
  // reach instead of sitting blank behind a 20-second ssh timeout.
  ipcMain.handle('config:get', async () => {
    await configStore.load()
    profileLoaded = false
    return localPayload()
  })
  // Fetch the profile from the host — first attempt and every reconnect retry.
  ipcMain.handle('config:connect', () => connect())
  ipcMain.handle('config:save', async (_e, cfg: RipponConfig) => {
    const { local, profile } = splitConfig(cfg)
    await configStore.save(local)
    const target = activeHost(local)
    if (!hostConfigured(target)) return
    // Belt and braces behind the renderer's lock: a profile we never read is a
    // placeholder, and writing it would wipe the real one on the host.
    if (!profileLoaded) return
    try {
      await writeProfile(target, target.activeProfile, profile)
    } catch (err) {
      send('app:error', `Could not save profile "${target.activeProfile}": ${message(err)}`)
    }
  })
  /*
   * Persist only the connection half — used when the host list changes, where
   * pushing the current layout onto whatever profile the new host holds would
   * clobber it. The profile lock drops, so the renderer refetches.
   */
  ipcMain.handle('config:save-hosts', async (_e, hosts: HostEntry[], activeHostId: string) => {
    profileLoaded = false
    ptys.killAll()
    tunnels.stop()
    await configStore.save({ ...configStore.current, hosts, activeHostId })
  })
  ipcMain.handle('config:choose-path', async () => pickConfigFile())

  /**
   * Switch hosts. Same shape as `profile:use`, and for the same reason: the
   * layout belongs to the host, so until the new one hands its profile over
   * there is nothing to draw, and a failure has to put the old one back.
   */
  ipcMain.handle('host:use', (_e, id: string) =>
    attempt(async () => {
      const previous = configStore.current
      if (!previous.hosts.some((h) => h.id === id)) throw new Error('No such host.')
      const wasLoaded = profileLoaded
      // The panes and forwards belong to the host we are leaving.
      ptys.killAll()
      tunnels.stop()
      await configStore.save({ ...previous, activeHostId: id })
      profileLoaded = false
      const payload = await connect()
      if (!payload.loaded) {
        await configStore.save(previous)
        profileLoaded = wasLoaded
        throw new Error(payload.error ?? 'Could not load a profile from that host.')
      }
      return { config: payload.config, profiles: payload.profiles }
    })
  )

  // Switch the active profile: persist the choice locally, load it from the host.
  ipcMain.handle('profile:use', (_e, name: string) =>
    attempt(async () => {
      const previous = configStore.current
      const wasLoaded = profileLoaded
      await saveHost({ activeProfile: name })
      profileLoaded = false
      const payload = await connect()
      if (!payload.loaded) {
        // Stay on the profile we can actually read. The renderer still holds
        // that one, so its provenance — and its right to be saved — is intact.
        await configStore.save(previous)
        profileLoaded = wasLoaded
        throw new Error(payload.error ?? `Could not load profile "${name}" from the host.`)
      }
      return { config: payload.config, profiles: payload.profiles }
    })
  )
  ipcMain.handle('profile:list', () => attempt(() => listProfiles(host())))
  ipcMain.handle('profile:create', (_e, name: string) =>
    attempt(async () => {
      await createProfile(host(), name)
      return listProfiles(host())
    })
  )
  ipcMain.handle('profile:rename', (_e, from: string, to: string) =>
    attempt(async () => {
      const ssh = host()
      await renameProfile(ssh, from, to)
      let activeProfile = host().activeProfile
      if (activeProfile === from) {
        activeProfile = to
        await saveHost({ activeProfile })
      }
      return { profiles: await listProfiles(ssh), activeProfile }
    })
  )
  ipcMain.handle('profile:delete', (_e, name: string) =>
    attempt(async () => {
      if (name === host().activeProfile) {
        throw new Error('Cannot delete the active profile. Switch to another first.')
      }
      await deleteProfile(host(), name)
      return listProfiles(host())
    })
  )

  ipcMain.handle('tmux:list', (_e, ssh: HostConfig) =>
    attempt<SessionInfo[]>(() => listSessions(ssh))
  )
  ipcMain.handle('tmux:create', (_e, ssh: HostConfig, name: string) =>
    attempt(() => createSession(ssh, name))
  )
  ipcMain.handle('tmux:kill', (_e, ssh: HostConfig, name: string) =>
    attempt(() => killSession(ssh, name))
  )
  ipcMain.handle('tmux:rename', (_e, ssh: HostConfig, from: string, to: string) =>
    attempt(() => renameSession(ssh, from, to))
  )

  ipcMain.handle(
    'pty:attach',
    (_e, id: string, ssh: HostConfig, sessionName: string, cols: number, rows: number) =>
      ptys.attach(id, ssh, sessionName, cols, rows)
  )
  ipcMain.handle('pty:write', (_e, id: string, data: string) => ptys.write(id, data))
  ipcMain.handle('pty:resize', (_e, id: string, cols: number, rows: number) =>
    ptys.resize(id, cols, rows)
  )
  ipcMain.handle('pty:kill', (_e, id: string) => ptys.kill(id))

  ipcMain.handle('tunnel:sync', (_e, ssh: HostConfig) => tunnels.sync(ssh))
  ipcMain.handle('tunnel:status', () => tunnels.status())
  ipcMain.handle('tmux:mouse', () => attempt(() => getMouseMode(host())))
  ipcMain.handle('tmux:set-mouse', (_e, on: boolean) =>
    attempt(() => setMouseMode(host(), on))
  )

  // What the toolbar chip does: tear the forwards down and put them back up.
  ipcMain.handle('tunnel:restart', () => tunnels.restart())
  ipcMain.handle('tunnel:verbose', () => tunnels.isVerbose())
  ipcMain.handle('tunnel:set-verbose', (_e, verbose: boolean) => tunnels.setVerbose(verbose))

  ipcMain.handle('activity:get', () => activity.all())
  ipcMain.handle('activity:clear', () => activity.clear())

  ipcMain.handle('files:list', (_e, path: string) =>
    attempt(() => listDir(host(), path))
  )
  ipcMain.handle('files:preview', (_e, path: string) =>
    attempt(() => previewFile(host(), path))
  )
  /*
   * Ask where to put it before fetching a byte. The save dialog is also the
   * consent: nothing on the host is written to this machine without the user
   * naming the destination first.
   */
  ipcMain.handle('files:download', (_e, path: string, size: number) =>
    attempt(async () => {
      const name = path.slice(path.lastIndexOf('/') + 1) || 'download'
      const result = await dialog.showSaveDialog({
        defaultPath: app.getPath('downloads') + '/' + name,
        buttonLabel: 'Download'
      })
      if (result.canceled || !result.filePath) return { saved: false as const }
      const to = result.filePath
      const bytes = await downloadFile(host(), path, to, (done) =>
        send('files:progress', path, done, size)
      )
      return { saved: true as const, path: to, bytes }
    })
  )
  ipcMain.handle('files:reveal', (_e, path: string) => shell.showItemInFolder(path))

  ipcMain.handle('browser:ensure', (_e, id: string, url: string) => browsers.ensure(id, url))
  ipcMain.handle('browser:destroy', (_e, id: string) => browsers.destroy(id))
  ipcMain.handle(
    'browser:bounds',
    (_e, id: string, bounds: Rectangle, visible: boolean, zoom: number) =>
      browsers.setBounds(id, bounds, visible, zoom)
  )
  ipcMain.handle('browser:navigate', (_e, id: string, url: string) => browsers.navigate(id, url))
  ipcMain.handle('browser:zoom', (_e, id: string, factor: number) => browsers.setZoom(id, factor))
  ipcMain.handle('browser:back', (_e, id: string) => browsers.goBack(id))
  ipcMain.handle('browser:forward', (_e, id: string) => browsers.goForward(id))
  ipcMain.handle('browser:reload', (_e, id: string) => browsers.reload(id))
  ipcMain.handle('browser:stop', (_e, id: string) => browsers.stop(id))
  ipcMain.handle('browser:focus', (_e, id: string) => browsers.focus(id))
  ipcMain.handle('browser:find', (_e, id: string, query: string, forward: boolean) =>
    browsers.find(id, query, forward)
  )
  ipcMain.handle('browser:find-stop', (_e, id: string) => browsers.stopFind(id))

  // Keyboard focus lives in whichever web contents has it; a native browser view
  // holds it until we hand it back, or ⌘L would type into the page.
  ipcMain.handle('window:focus-page', () => mainWindow?.webContents.focus())

  browsers.on('state', (id: string, state: BrowserState) => send('browser:state', id, state))
  browsers.on('found', (id: string, matches: FindMatches) => send('browser:found', id, matches))
  browsers.on('focus', (id: string) => send('browser:focused', id))

  ipcMain.handle('clipboard:write', (_e, text: string) => clipboard.writeText(text))
  ipcMain.handle('clipboard:read', () => clipboard.readText())

  ipcMain.handle('shell:open-external', (_e, url: string) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })

  ptys.on('data', (id: string, data: string) => send('pty:data', id, data))
  ptys.on('exit', (id: string, code: number) => send('pty:exit', id, code))

  tunnels.on('status', (status: TunnelStatus) => send('tunnel:status', status))

  // The log is append-mostly, so the renderer gets each entry as it lands and
  // upserts by seq — a collapsed repeat re-sends the same entry with a new count.
  activity.on('entry', (entry: ActivityEntry) => send('activity:entry', entry))
  activity.on('cleared', () => send('activity:cleared'))

  // The file changed under us — a sync, or a hand edit. It carries the host and
  // the profile name, so the presentation half has to be fetched again.
  configStore.on('external-change', (_local: LocalConfig) => {
    profileLoaded = false
    send('config:changed', ...changedArgs(localPayload()))
  })
  configStore.on('error', (text: string) => send('app:error', text))
}

app.whenReady().then(() => {
  configureBrowserSession()
  registerIpc()
  buildMenu()
  createWindow()
  health.start()

  /*
   * Coming back to the app is when a stale connection surfaces and when it is
   * least welcome, so each of these checks immediately instead of waiting out
   * the interval. Waking from sleep is the likeliest wedge of all: the laptop
   * returns on a different network with its old TCP connections still nominally
   * established.
   */
  app.on('browser-window-focus', () => health.wake())
  powerMonitor.on('unlock-screen', () => {
    screenLocked = false
    health.wake()
  })
  powerMonitor.on('resume', () => {
    screenLocked = false
    health.wake()
  })
  powerMonitor.on('lock-screen', () => {
    screenLocked = true
  })
  powerMonitor.on('suspend', () => {
    screenLocked = true
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  health.stop()
  beginShutdown()
  configStore.dispose()
})
