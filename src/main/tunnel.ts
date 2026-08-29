import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import { activity } from './activity'
import { controlArgs } from './tmux'
import { tunnelLabel, type HostConfig, type Tunnel, type TunnelStatus } from '../shared/types'

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
  private last: HostConfig | null = null

  status(): TunnelStatus {
    return this.current
  }

  isVerbose(): boolean {
    return this.verbose
  }

  /** Whether a forwarder ought to be up: an ssh host, and something to forward. */
  wants(): boolean {
    if (!this.last || this.last.kind === 'local') return false
    return !!this.last.host && (this.last.tunnels ?? []).length > 0
  }

  /**
   * Whether the forwards are actually carrying traffic, judged by the local
   * listeners rather than by whether our child process is alive.
   *
   * The distinction is the whole point. `ssh -N` against an existing master
   * installs the forwards *on the master* and then has nothing left to hold, so
   * it exits 0 immediately and the forwards outlive it — a dead child says
   * nothing about whether the ports work. Judging by the process instead had the
   * health monitor declaring healthy forwards dead and restarting them in a loop,
   * where each restart raced its own master for ports it already held.
   */
  async listening(): Promise<boolean> {
    const ports = (this.last?.tunnels ?? []).map((t) => t.localPort)
    if (!ports.length) return false
    const held = await Promise.all(ports.map(portTaken))
    // Any listener is enough to mean "not down". A forward that lost a single
    // port has already said so on stderr, and restarting the lot to chase it
    // would take down the ones that work.
    return held.some(Boolean)
  }

  /**
   * Bring the forwards back on the config they were last synced with — the
   * health monitor's repair, and what the toolbar chip does when clicked.
   */
  restart(): void {
    if (this.last) this.sync(this.last)
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
  sync(ssh: HostConfig): void {
    this.stop()
    this.last = ssh

    const tunnels = ssh.tunnels ?? []
    // A local host has nothing to forward *from*: its ports are already this
    // machine's. The config normalizer drops its tunnels, so this is belt and
    // braces for a config edited by hand.
    if (ssh.kind === 'local' || !ssh.host || tunnels.length === 0) {
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
      if (!code && !error) {
        /*
         * Exiting 0 with nothing to say is success, not death: the forwards were
         * handed to the shared connection, which holds them from here on. Saying
         * "exited" for this read as a failure in the log, and reporting it as
         * not running made the chip go dark over forwards that were working.
         */
        activity.add('tunnel', 'info', 'forwards handed to the shared connection')
        this.update({ running: true, forwards, error: null })
        return
      }
      activity.add('tunnel', 'error', `forwarder exited (code ${code ?? 0})`, {
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

/**
 * Whether something already holds a local port.
 *
 * Asked by trying to bind it: EADDRINUSE means taken, which is the answer we
 * want. Connecting to it would be worse than useless — it would open a channel
 * through to the remote host and count against the server's session limit, which
 * is the very resource this app runs short of.
 */
function portTaken(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'EADDRINUSE'))
    probe.once('listening', () => probe.close(() => resolve(false)))
    probe.listen(port, '127.0.0.1')
  })
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
