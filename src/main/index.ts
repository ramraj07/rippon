import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  type MenuItemConstructorOptions,
  type Rectangle
} from 'electron'
import path from 'node:path'
import { BROWSER_PARTITION, BrowserViews } from './browser'
import { ConfigStore } from './config'
import {
  createProfile,
  deleteProfile,
  listProfiles,
  readProfile,
  renameProfile,
  writeProfile
} from './profiles'
import { PtyManager } from './pty'
import { createSession, killSession, listSessions, renameSession } from './tmux'
import { TunnelManager } from './tunnel'
import {
  defaultProfile,
  mergeConfig,
  splitConfig,
  type LocalConfig,
  type Profile,
  type RipponConfig,
  type SessionInfo,
  type SshConfig,
  type TunnelStatus
} from '../shared/types'
import type { BrowserState } from '../shared/types'

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
    { role: 'editMenu' },
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
  const { config, profiles, error } = await buildConfigResponse()
  send('config:changed', config, configStore.filePath, profiles)
  if (error) send('app:error', error)
}

/** Wrap a remote call so the renderer always gets {ok} or {error} instead of a rejection. */
async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Load the active profile from the host, running the one-time migration of a
 * pre-profiles file if one is pending. A profiles-model app cannot paint layout
 * without the connection, so a failure here yields defaults plus an error the UI
 * surfaces — the pending migration is kept so a later reload can complete it.
 */
async function resolveProfile(local: LocalConfig): Promise<{ profile: Profile; error: string | null }> {
  const ssh = local.ssh
  const pending = configStore.pendingLegacyProfile
  if (!ssh.host) {
    // Nothing remote to load yet; show the old layout if we have one to migrate.
    return { profile: pending ?? defaultProfile(), error: null }
  }
  try {
    let profile = await readProfile(ssh, local.activeProfile)
    if (!profile) {
      // No file on the host: seed it — from the pending legacy layout if this is
      // a migration, otherwise an empty default so the profile exists to list.
      profile = pending ?? defaultProfile()
      await writeProfile(ssh, local.activeProfile, profile)
    }
    if (pending) {
      // Migration landed: shrink the local file so it never re-migrates.
      configStore.clearPendingLegacy()
      await configStore.save(local)
    }
    return { profile, error: null }
  } catch (err) {
    return { profile: defaultProfile(), error: err instanceof Error ? err.message : String(err) }
  }
}

/** The full payload the renderer needs: merged config, path, profile list, error. */
async function buildConfigResponse(): Promise<{
  config: RipponConfig
  path: string
  profiles: string[]
  error: string | null
}> {
  const local = configStore.current
  const { profile, error } = await resolveProfile(local)
  let profiles: string[] = []
  if (local.ssh.host && !error) {
    try {
      profiles = await listProfiles(local.ssh)
    } catch {
      // Listing is a nicety; a failure here should not block the layout.
    }
  }
  if (!profiles.includes(local.activeProfile)) {
    profiles = [...profiles, local.activeProfile].sort((a, b) => a.localeCompare(b))
  }
  return { config: mergeConfig(local, profile), path: configStore.filePath, profiles, error }
}

function registerIpc(): void {
  ipcMain.handle('config:get', async () => {
    await configStore.load()
    return buildConfigResponse()
  })
  // Re-fetch the profile from the host (e.g. the retry after it was unreachable).
  ipcMain.handle('config:reload', () => buildConfigResponse())
  ipcMain.handle('config:save', async (_e, cfg: RipponConfig) => {
    const { local, profile } = splitConfig(cfg)
    await configStore.save(local)
    if (!local.ssh.host) return
    try {
      await writeProfile(local.ssh, local.activeProfile, profile)
    } catch (err) {
      send('app:error', `Could not save profile "${local.activeProfile}": ${err instanceof Error ? err.message : String(err)}`)
    }
  })
  // Persist only the connection half — used when the host changes, where pushing
  // the current layout onto the new host's profile would clobber it.
  ipcMain.handle('config:save-local', async (_e, ssh: SshConfig, activeProfile: string) => {
    await configStore.save({ ...configStore.current, ssh, activeProfile })
  })
  ipcMain.handle('config:choose-path', async () => pickConfigFile())

  // Switch the active profile: persist the choice locally, load it from the host.
  ipcMain.handle('profile:use', (_e, name: string) =>
    attempt(async () => {
      const local = { ...configStore.current, activeProfile: name }
      await configStore.save(local)
      const { profile, error } = await resolveProfile(local)
      if (error) throw new Error(error)
      const profiles = await listProfiles(local.ssh)
      if (!profiles.includes(name)) profiles.push(name)
      return { config: mergeConfig(local, profile), profiles: profiles.sort((a, b) => a.localeCompare(b)) }
    })
  )
  ipcMain.handle('profile:list', () => attempt(() => listProfiles(configStore.current.ssh)))
  ipcMain.handle('profile:create', (_e, name: string) =>
    attempt(async () => {
      await createProfile(configStore.current.ssh, name)
      return listProfiles(configStore.current.ssh)
    })
  )
  ipcMain.handle('profile:rename', (_e, from: string, to: string) =>
    attempt(async () => {
      const ssh = configStore.current.ssh
      await renameProfile(ssh, from, to)
      let activeProfile = configStore.current.activeProfile
      if (activeProfile === from) {
        activeProfile = to
        await configStore.save({ ...configStore.current, activeProfile })
      }
      return { profiles: await listProfiles(ssh), activeProfile }
    })
  )
  ipcMain.handle('profile:delete', (_e, name: string) =>
    attempt(async () => {
      if (name === configStore.current.activeProfile) {
        throw new Error('Cannot delete the active profile. Switch to another first.')
      }
      await deleteProfile(configStore.current.ssh, name)
      return listProfiles(configStore.current.ssh)
    })
  )

  ipcMain.handle('tmux:list', (_e, ssh: SshConfig) =>
    attempt<SessionInfo[]>(() => listSessions(ssh))
  )
  ipcMain.handle('tmux:create', (_e, ssh: SshConfig, name: string) =>
    attempt(() => createSession(ssh, name))
  )
  ipcMain.handle('tmux:kill', (_e, ssh: SshConfig, name: string) =>
    attempt(() => killSession(ssh, name))
  )
  ipcMain.handle('tmux:rename', (_e, ssh: SshConfig, from: string, to: string) =>
    attempt(() => renameSession(ssh, from, to))
  )

  ipcMain.handle(
    'pty:attach',
    (_e, id: string, ssh: SshConfig, sessionName: string, cols: number, rows: number) => {
      ptys.attach(id, ssh, sessionName, cols, rows)
    }
  )
  ipcMain.handle('pty:write', (_e, id: string, data: string) => ptys.write(id, data))
  ipcMain.handle('pty:resize', (_e, id: string, cols: number, rows: number) =>
    ptys.resize(id, cols, rows)
  )
  ipcMain.handle('pty:kill', (_e, id: string) => ptys.kill(id))

  ipcMain.handle('tunnel:sync', (_e, ssh: SshConfig) => tunnels.sync(ssh))
  ipcMain.handle('tunnel:status', () => tunnels.status())

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

  // Keyboard focus lives in whichever web contents has it; a native browser view
  // holds it until we hand it back, or ⌘L would type into the page.
  ipcMain.handle('window:focus-page', () => mainWindow?.webContents.focus())

  browsers.on('state', (id: string, state: BrowserState) => send('browser:state', id, state))

  ipcMain.handle('clipboard:write', (_e, text: string) => clipboard.writeText(text))
  ipcMain.handle('clipboard:read', () => clipboard.readText())

  ipcMain.handle('shell:open-external', (_e, url: string) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })

  ptys.on('data', (id: string, data: string) => send('pty:data', id, data))
  ptys.on('exit', (id: string, code: number) => send('pty:exit', id, code))

  tunnels.on('status', (status: TunnelStatus) => send('tunnel:status', status))

  configStore.on('external-change', async (_local: LocalConfig) => {
    const { config, profiles, error } = await buildConfigResponse()
    send('config:changed', config, configStore.filePath, profiles)
    if (error) send('app:error', error)
  })
  configStore.on('error', (message: string) => send('app:error', message))
}

app.whenReady().then(() => {
  configureBrowserSession()
  registerIpc()
  buildMenu()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  beginShutdown()
  configStore.dispose()
})
