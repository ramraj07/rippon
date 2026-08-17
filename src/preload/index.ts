import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ActivityEntry,
  BrowserState,
  RemoteListing,
  RemotePreview,
  FindMatches,
  RipponConfig,
  SessionInfo,
  SshConfig,
  TunnelStatus
} from '../shared/types'

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }
export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

function on<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.off(channel, listener)
}

interface ConfigPayload {
  config: RipponConfig
  path: string
  /** Profile names available on the host. */
  profiles: string[]
  /** Non-null when the active profile could not be loaded (host unreachable, etc). */
  error: string | null
  /**
   * Whether `config`'s presentation half came off the host. False means the
   * layout fields are placeholders: show nothing editable, and save nothing.
   */
  loaded: boolean
}

const api = {
  config: {
    /** The local file only — no network, so this always returns promptly. */
    get: (): Promise<ConfigPayload> => ipcRenderer.invoke('config:get'),
    /** Fetch the profile from the host. Also the reconnect retry. */
    connect: (): Promise<ConfigPayload> => ipcRenderer.invoke('config:connect'),
    save: (cfg: RipponConfig): Promise<void> => ipcRenderer.invoke('config:save', cfg),
    saveLocal: (ssh: SshConfig, activeProfile: string): Promise<void> =>
      ipcRenderer.invoke('config:save-local', ssh, activeProfile),
    choosePath: (): Promise<void> => ipcRenderer.invoke('config:choose-path'),
    onChanged: (
      cb: (cfg: RipponConfig, path: string, profiles: string[], loaded: boolean) => void
    ) => on<[RipponConfig, string, string[], boolean]>('config:changed', cb)
  },
  profile: {
    use: (name: string): Promise<Result<{ config: RipponConfig; profiles: string[] }>> =>
      ipcRenderer.invoke('profile:use', name),
    list: (): Promise<Result<string[]>> => ipcRenderer.invoke('profile:list'),
    create: (name: string): Promise<Result<string[]>> => ipcRenderer.invoke('profile:create', name),
    rename: (from: string, to: string): Promise<Result<{ profiles: string[]; activeProfile: string }>> =>
      ipcRenderer.invoke('profile:rename', from, to),
    delete: (name: string): Promise<Result<string[]>> => ipcRenderer.invoke('profile:delete', name)
  },
  tmux: {
    list: (ssh: SshConfig): Promise<Result<SessionInfo[]>> => ipcRenderer.invoke('tmux:list', ssh),
    create: (ssh: SshConfig, name: string): Promise<Result<void>> =>
      ipcRenderer.invoke('tmux:create', ssh, name),
    kill: (ssh: SshConfig, name: string): Promise<Result<void>> =>
      ipcRenderer.invoke('tmux:kill', ssh, name),
    rename: (ssh: SshConfig, from: string, to: string): Promise<Result<void>> =>
      ipcRenderer.invoke('tmux:rename', ssh, from, to),
    /** Server-wide mouse mode; null when no tmux server is running yet. */
    mouseMode: (): Promise<Result<boolean | null>> => ipcRenderer.invoke('tmux:mouse'),
    setMouseMode: (on: boolean): Promise<Result<void>> => ipcRenderer.invoke('tmux:set-mouse', on)
  },
  pty: {
    attach: (id: string, ssh: SshConfig, session: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke('pty:attach', id, ssh, session, cols, rows),
    write: (id: string, data: string): Promise<void> => ipcRenderer.invoke('pty:write', id, data),
    resize: (id: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke('pty:resize', id, cols, rows),
    kill: (id: string): Promise<void> => ipcRenderer.invoke('pty:kill', id),
    onData: (cb: (id: string, data: string) => void) => on<[string, string]>('pty:data', cb),
    onExit: (cb: (id: string, code: number) => void) => on<[string, number]>('pty:exit', cb)
  },
  tunnel: {
    sync: (ssh: SshConfig): Promise<void> => ipcRenderer.invoke('tunnel:sync', ssh),
    status: (): Promise<TunnelStatus> => ipcRenderer.invoke('tunnel:status'),
    /** Tear the forwards down and bring them straight back up. */
    restart: (): Promise<void> => ipcRenderer.invoke('tunnel:restart'),
    onStatus: (cb: (status: TunnelStatus) => void) => on<[TunnelStatus]>('tunnel:status', cb),
    /** Whether the forwarder is running with -v. Session-only, not persisted. */
    verbose: (): Promise<boolean> => ipcRenderer.invoke('tunnel:verbose'),
    /** Restarts the forwarder, so the forwards blink. */
    setVerbose: (verbose: boolean): Promise<void> =>
      ipcRenderer.invoke('tunnel:set-verbose', verbose)
  },
  files: {
    list: (path: string): Promise<Result<RemoteListing>> => ipcRenderer.invoke('files:list', path),
    preview: (path: string): Promise<Result<RemotePreview>> =>
      ipcRenderer.invoke('files:preview', path),
    /** Prompts for a destination first; `saved: false` means the user cancelled. */
    download: (
      path: string,
      size: number
    ): Promise<Result<{ saved: boolean; path?: string; bytes?: number }>> =>
      ipcRenderer.invoke('files:download', path, size),
    reveal: (path: string): Promise<void> => ipcRenderer.invoke('files:reveal', path),
    onProgress: (cb: (path: string, done: number, total: number) => void) =>
      on<[string, number, number]>('files:progress', cb)
  },
  activity: {
    get: (): Promise<ActivityEntry[]> => ipcRenderer.invoke('activity:get'),
    clear: (): Promise<void> => ipcRenderer.invoke('activity:clear'),
    /** Fires per entry; a collapsed repeat re-sends the same seq with a new count. */
    onEntry: (cb: (entry: ActivityEntry) => void) => on<[ActivityEntry]>('activity:entry', cb),
    onCleared: (cb: () => void) => on<[]>('activity:cleared', cb)
  },
  browser: {
    ensure: (id: string, url: string): Promise<void> =>
      ipcRenderer.invoke('browser:ensure', id, url),
    destroy: (id: string): Promise<void> => ipcRenderer.invoke('browser:destroy', id),
    setBounds: (id: string, bounds: Bounds, visible: boolean, zoom: number): Promise<void> =>
      ipcRenderer.invoke('browser:bounds', id, bounds, visible, zoom),
    navigate: (id: string, url: string): Promise<void> =>
      ipcRenderer.invoke('browser:navigate', id, url),
    setZoom: (id: string, factor: number): Promise<void> =>
      ipcRenderer.invoke('browser:zoom', id, factor),
    back: (id: string): Promise<void> => ipcRenderer.invoke('browser:back', id),
    forward: (id: string): Promise<void> => ipcRenderer.invoke('browser:forward', id),
    reload: (id: string): Promise<void> => ipcRenderer.invoke('browser:reload', id),
    stop: (id: string): Promise<void> => ipcRenderer.invoke('browser:stop', id),
    focus: (id: string): Promise<void> => ipcRenderer.invoke('browser:focus', id),
    find: (id: string, query: string, forward: boolean): Promise<void> =>
      ipcRenderer.invoke('browser:find', id, query, forward),
    findStop: (id: string): Promise<void> => ipcRenderer.invoke('browser:find-stop', id),
    onFound: (cb: (id: string, matches: FindMatches) => void) =>
      on<[string, FindMatches]>('browser:found', cb),
    /** The view took keyboard focus. Nothing in the renderer can observe this. */
    onFocused: (cb: (id: string) => void) => on<[string]>('browser:focused', cb),
    onState: (cb: (id: string, state: BrowserState) => void) =>
      on<[string, BrowserState]>('browser:state', cb)
  },
  clipboard: {
    write: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
    read: (): Promise<string> => ipcRenderer.invoke('clipboard:read')
  },
  focusPage: (): Promise<void> => ipcRenderer.invoke('window:focus-page'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:open-external', url),
  onMenu: (cb: (action: string, payload?: unknown) => void): (() => void) => {
    const channels = [
      'menu:new-session',
      'menu:new-view',
      'menu:cycle-view',
      'menu:close-tab',
      'menu:refresh',
      'menu:zoom',
      'menu:settings',
      'menu:focus-address',
      'menu:focus-terminal',
      'menu:reload-browser',
      'menu:reconnect-ssh',
      'menu:cycle-tab',
      'menu:select-tab-index',
      'menu:files',
      'menu:find',
      'menu:find-step'
    ]
    const offs = channels.map((c) => on<[unknown]>(c, (payload) => cb(c, payload)))
    return () => offs.forEach((off) => off())
  },
  onError: (cb: (message: string) => void) => on<[string]>('app:error', cb)
}

contextBridge.exposeInMainWorld('rippon', api)

export type RipponApi = typeof api
