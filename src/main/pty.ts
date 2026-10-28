import { EventEmitter } from 'node:events'
import os from 'node:os'
import * as pty from 'node-pty'
import { activity } from './activity'
import { localEnv } from './local'
import { attachSpec } from './tmux'
import type { HostConfig } from '../shared/types'

/**
 * We shell out to the system `ssh` binary rather than speaking SSH ourselves,
 * so ~/.ssh/config aliases, ProxyJump, agent forwarding and interactive MFA
 * prompts all behave exactly as they do in a normal terminal. A local host
 * skips ssh and runs tmux through a login shell, which is the same idea one hop
 * closer: whatever the user's terminal would do, we do.
 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\r/g, '')
}

export class PtyManager extends EventEmitter {
  private sessions = new Map<string, pty.IPty>()
  private lastLogged = new Map<string, string>()

  isRunning(id: string): boolean {
    return this.sessions.has(id)
  }

  /**
   * Async only because a local attach needs the login shell's PATH, which is
   * resolved once and cached — every call after the first settles immediately.
   * A second attach for the same id while the first is still resolving would
   * leave an orphan, so the kill happens on both sides of the await.
   */
  async attach(
    id: string,
    ssh: HostConfig,
    session: string,
    cols: number,
    rows: number
  ): Promise<void> {
    this.kill(id)

    let proc: pty.IPty
    try {
      const { file, args } = attachSpec(ssh, session)
      const env = ssh.kind === 'local' ? await localEnv() : process.env
      this.kill(id)

      proc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: Math.max(cols, 2),
        rows: Math.max(rows, 2),
        cwd: os.homedir(),
        env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>
      })
    } catch (err) {
      // Otherwise this vanishes into a voided promise and the pane just sits there.
      const message = err instanceof Error ? err.message : String(err)
      activity.add('pane', 'error', `attach ${session} failed`, { detail: message })
      throw new Error(message)
    }

    this.sessions.set(id, proc)
    activity.add('pane', 'info', `attach ${session}`)
    /*
     * The last output, kept so a client that dies on its own can say why in the
     * log — ssh explains a failure on the tty and nowhere else.
     */
    let tail = ''
    proc.onData((data) => {
      tail = (tail + data).slice(-2000)
      // A killed client can still flush a last chunk after its replacement has
      // started; that belongs to nobody now.
      if (this.sessions.get(id) === proc) this.emit('data', id, data)
    })
    proc.onExit(({ exitCode, signal }) => {
      /*
       * kill() takes the entry out before the exit lands, so a reattach can
       * already have put a new client under this id. Reporting the old one's
       * exit then would drop the new client from the map and tell the pane it
       * detached — which reset the screen tmux had just drawn, and left a blank
       * tab wired to nothing.
       */
      const current = this.sessions.get(id)
      if (current && current !== proc) return
      this.sessions.delete(id)
      // A pane the user closed exits 0 through kill() below; a non-zero code
      // here is ssh, the shell or tmux giving up on its own — worth a line.
      const detail = exitCode ? stripAnsi(tail).trim().split('\n').slice(-15).join('\n') : undefined
      activity.add(
        'pane',
        exitCode ? 'warn' : 'info',
        `${session} detached (code ${exitCode}${signal ? `, signal ${signal}` : ''})`,
        { detail }
      )
      this.emit('exit', id, exitCode)
    })
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const proc = this.sessions.get(id)
    if (!proc) {
      if (process.env['RIPPON_TRACE']) console.log(`[pty] ${id}: resize with no session`)
      return
    }
    if (process.env['RIPPON_TRACE']) {
      const key = `${cols}x${rows}`
      if (key !== this.lastLogged.get(id)) {
        this.lastLogged.set(id, key)
        console.log(`[pty] ${id} resize ${key}`)
      }
    }
    try {
      proc.resize(Math.max(cols, 2), Math.max(rows, 2))
    } catch {
      // The process can exit between our check and the resize; harmless.
    }
  }

  /** Kills the client only — the tmux session keeps running on the host. */
  kill(id: string): void {
    const proc = this.sessions.get(id)
    if (!proc) return
    this.sessions.delete(id)
    try {
      proc.kill()
    } catch {
      // already gone
    }
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }
}
