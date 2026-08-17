import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { activity } from './activity'
import { controlArgs } from './tmux'
import { tunnelLabel, type SshConfig, type Tunnel, type TunnelStatus } from '../shared/types'

/**
 * Holds the app's local port forwards open with a single background `ssh -N`.
 *
 * It reuses the same multiplexed connection as the tmux attaches (controlArgs),
 * so it rides whatever master they already authenticated — no second password
 * or MFA prompt, which matters because this process has no TTY to answer one.
 * The forwards it requests are torn down when we kill it; only in the rare case
 * where it is the very first connection does ControlPersist keep them the usual
 * ~120s after exit.
 */
export class TunnelManager extends EventEmitter {
  private proc: ChildProcess | null = null
  private current: TunnelStatus = { running: false, forwards: [], error: null }
  private stderr = ''
  private verbose = false
  /** Kept so the verbose toggle can restart the forwarder as it stands. */
  private last: SshConfig | null = null

  status(): TunnelStatus {
    return this.current
  }

  isVerbose(): boolean {
    return this.verbose
  }

  /**
   * Restart the forwarder with or without `-v`.
   *
   * A quiet `ssh -N` says nothing at all until something breaks, which makes for
   * a log that is empty exactly when it is being consulted. `-v` narrates each
   * forward request and each connection, at the cost of a reconnect to apply —
   * hence a toggle rather than a default.
   */
  setVerbose(verbose: boolean): void {
    if (this.verbose === verbose) return
    this.verbose = verbose
    activity.add('tunnel', 'info', `verbose logging ${verbose ? 'on' : 'off'}`)
    if (this.last) this.sync(this.last)
  }

  /** Reconcile the live forwarder to `ssh.tunnels`. Safe to call on every change. */
  sync(ssh: SshConfig): void {
    this.stop()
    this.last = ssh

    const tunnels = ssh.tunnels ?? []
    if (!ssh.host || tunnels.length === 0) {
      this.update({ running: false, forwards: [], error: null })
      return
    }

    const forwards = tunnels.map(tunnelLabel)
    const args = [
      '-N', // no remote command; just hold the forwards
      ...(this.verbose ? ['-v'] : []),
      ...controlArgs(),
      ...ssh.args,
      ...tunnels.flatMap((t) => ['-L', forwardSpec(t)]),
      ssh.host
    ]

    this.stderr = ''
    activity.add('tunnel', 'info', `start ${forwards.join(', ')}`, {
      detail: `ssh ${args.join(' ')}`
    })
    // No stdin: ssh must not try to prompt us. Keys/agent/an existing master
    // are the only ways this connection can come up.
    const proc = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    this.proc = proc
    this.update({ running: true, forwards, error: null })

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      this.stderr = (this.stderr + text).slice(-4000)
      // Every line goes to the log, flagged by whether it names a real failure.
      // With -v most of them are narration, and the point of the log is that the
      // narration is there when the one line that matters needs context.
      for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (line) activity.add('tunnel', firstProblem(line) ? 'warn' : 'info', line)
      }
      // A forward can fail (port already bound) while the connection itself
      // stays up, so surface the problem without waiting for an exit.
      const problem = firstProblem(this.stderr)
      if (problem && this.proc === proc) this.update({ ...this.current, error: problem })
    })

    proc.on('exit', (code) => {
      if (this.proc !== proc) return // already superseded by a newer sync
      this.proc = null
      const error =
        this.current.error ?? (code ? describe(this.stderr) || `ssh exited (code ${code})` : null)
      activity.add('tunnel', code ? 'error' : 'info', `forwarder exited (code ${code ?? 0})`, {
        detail: error ?? undefined
      })
      this.update({ running: false, forwards, error })
    })

    proc.on('error', (err) => {
      if (this.proc !== proc) return
      this.proc = null
      activity.add('tunnel', 'error', 'forwarder could not start', { detail: err.message })
      this.update({ running: false, forwards, error: err.message })
    })
  }

  /** Tear the forwarder down. The forwards go with the process it was holding. */
  stop(): void {
    const proc = this.proc
    this.proc = null
    if (!proc) return
    activity.add('tunnel', 'info', 'stopping forwarder')
    try {
      proc.kill()
    } catch {
      // already gone
    }
  }

  private update(status: TunnelStatus): void {
    this.current = status
    this.emit('status', status)
  }
}

function forwardSpec(t: Tunnel): string {
  return `${t.localPort}:${t.remoteHost || 'localhost'}:${t.remotePort}`
}

/** ssh chatters on stderr; pull out the line that names an actual failure. */
function firstProblem(text: string): string | null {
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (
      /address already in use|cannot listen to port|could not request local forwarding|permission denied|could not resolve hostname|connection (refused|closed|timed out)|operation timed out|no route to host/i.test(
        line
      )
    ) {
      return line
    }
  }
  return null
}

/** Fall back to the tail of stderr when nothing matched a known pattern. */
function describe(text: string): string {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-2)
    .join(' — ')
}
