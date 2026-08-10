import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { RipponConfig, SessionInfo, SshConfig } from '../shared/types'

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

function on<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.off(channel, listener)
}

const api = {
  config: {
    get: (): Promise<{ config: RipponConfig; path: string }> => ipcRenderer.invoke('config:get'),
    save: (cfg: RipponConfig): Promise<void> => ipcRenderer.invoke('config:save', cfg),
    choosePath: (): Promise<void> => ipcRenderer.invoke('config:choose-path'),
    onChanged: (cb: (cfg: RipponConfig, path: string) => void) =>
      on<[RipponConfig, string]>('config:changed', cb)
  },
  tmux: {
    list: (ssh: SshConfig): Promise<Result<SessionInfo[]>> => ipcRenderer.invoke('tmux:list', ssh),
    create: (ssh: SshConfig, name: string): Promise<Result<void>> =>
      ipcRenderer.invoke('tmux:create', ssh, name),
    kill: (ssh: SshConfig, name: string): Promise<Result<void>> =>
      ipcRenderer.invoke('tmux:kill', ssh, name),
    rename: (ssh: SshConfig, from: string, to: string): Promise<Result<void>> =>
      ipcRenderer.invoke('tmux:rename', ssh, from, to)
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
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:open-external', url),
  onMenu: (cb: (action: string, payload?: unknown) => void): (() => void) => {
    const channels = [
      'menu:new-session',
      'menu:close-tab',
      'menu:refresh',
      'menu:settings',
      'menu:focus-address',
      'menu:focus-terminal',
      'menu:reload-browser',
      'menu:reconnect-ssh',
      'menu:cycle-tab',
      'menu:select-tab-index'
    ]
    const offs = channels.map((c) => on<[unknown]>(c, (payload) => cb(c, payload)))
    return () => offs.forEach((off) => off())
  },
  onError: (cb: (message: string) => void) => on<[string]>('app:error', cb)
}

contextBridge.exposeInMainWorld('rippon', api)

export type RipponApi = typeof api
