import { EventEmitter } from 'node:events'
import os from 'node:os'
import * as pty from 'node-pty'
import type { SshConfig } from '../shared/types'

/**
 * We shell out to the system `ssh` binary rather than speaking SSH ourselves,
 * so ~/.ssh/config aliases, ProxyJump, agent forwarding and interactive MFA
 * prompts all behave exactly as they do in a normal terminal.
 */

export interface StartOptions {
  ssh: SshConfig
  cols: number
  rows: number
}

export function buildSshArgs(ssh: SshConfig): string[] {
  const args = ['-tt', ...(ssh.args ?? []), ssh.host]
  if (ssh.command && ssh.command.trim()) args.push(ssh.command)
  return args
}

export class PtyManager extends EventEmitter {
  private sessions = new Map<string, pty.IPty>()

  isRunning(id: string): boolean {
    return this.sessions.has(id)
  }

  start(id: string, opts: StartOptions): void {
    this.kill(id)

    const proc = pty.spawn('ssh', buildSshArgs(opts.ssh), {
      name: 'xterm-256color',
      cols: Math.max(opts.cols, 2),
      rows: Math.max(opts.rows, 2),
      cwd: os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<
        string,
        string
      >
    })

    this.sessions.set(id, proc)
    proc.onData((data) => this.emit('data', id, data))
    proc.onExit(({ exitCode, signal }) => {
      this.sessions.delete(id)
      this.emit('exit', id, exitCode, signal)
    })
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const proc = this.sessions.get(id)
    if (!proc) return
    try {
      proc.resize(Math.max(cols, 2), Math.max(rows, 2))
    } catch {
      // The process can exit between our check and the resize; harmless.
    }
  }

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
