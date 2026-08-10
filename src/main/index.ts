import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  type MenuItemConstructorOptions
} from 'electron'
import path from 'node:path'
import { ConfigStore } from './config'
import { PtyManager } from './pty'
import { createSession, killSession, listSessions, renameSession } from './tmux'
import type { RipponConfig, SessionInfo, SshConfig } from '../shared/types'

/** Every browser pane shares this session, so a GitHub login in one tab is a login in all of them. */
const BROWSER_PARTITION = 'persist:rippon-browser'

const configStore = new ConfigStore()
const ptys = new PtyManager()
let mainWindow: BrowserWindow | null = null

function send(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

function createWindow(): void {
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
      sandbox: false,
      webviewTag: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

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

function wireWebviewPopups(): void {
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return

    contents.setWindowOpenHandler(({ url, disposition }) => {
      // window.open with features (OAuth / SSO flows) genuinely needs its own
      // window; a plain target=_blank link should just navigate the pane.
      if (disposition === 'new-window') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 560,
            height: 760,
            autoHideMenuBar: true,
            webPreferences: { partition: BROWSER_PARTITION, contextIsolation: true }
          }
        }
      }
      if (/^https?:/i.test(url)) void contents.loadURL(url)
      return { action: 'deny' }
    })
  })
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
                label: 'SSH Settings…',
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
        { label: 'Close Tab…', accelerator: 'CmdOrCtrl+W', click: () => send('menu:close-tab') },
        {
          label: 'Refresh Session List',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: () => send('menu:refresh')
        },
        { type: 'separator' },
        ...(isMac
          ? []
          : [{ label: 'SSH Settings…', accelerator: 'Ctrl+,', click: () => send('menu:settings') }]),
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
  const cfg = await configStore.setPath(result.filePaths[0])
  send('config:changed', cfg, configStore.filePath)
}

/** Wrap a remote call so the renderer always gets {ok} or {error} instead of a rejection. */
async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function registerIpc(): void {
  ipcMain.handle('config:get', async () => ({
    config: await configStore.load(),
    path: configStore.filePath
  }))
  ipcMain.handle('config:save', async (_e, cfg: RipponConfig) => configStore.save(cfg))
  ipcMain.handle('config:choose-path', async () => pickConfigFile())

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

  ipcMain.handle('shell:open-external', (_e, url: string) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })

  ptys.on('data', (id: string, data: string) => send('pty:data', id, data))
  ptys.on('exit', (id: string, code: number) => send('pty:exit', id, code))

  configStore.on('external-change', (cfg: RipponConfig) =>
    send('config:changed', cfg, configStore.filePath)
  )
  configStore.on('error', (message: string) => send('app:error', message))
}

app.whenReady().then(() => {
  configureBrowserSession()
  wireWebviewPopups()
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
  ptys.killAll()
  configStore.dispose()
})
