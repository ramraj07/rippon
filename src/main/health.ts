import { activity } from './activity'
import { probe, resetMaster, wedged } from './tmux'
import type { TunnelManager } from './tunnel'
import type { SshConfig } from '../shared/types'

/**
 * Watches the shared ssh connection and the port forwarder, and clears up after
 * them when they stop working.
 *
 * Two failures are worth catching here, and neither announces itself. A master
 * whose connection died goes on answering its control socket, so every later
 * call joins it and hangs — the app looks frozen while a plain `ssh host` from a
 * terminal works instantly. And the forwarder is a single background process
 * that is only ever started when the config changes, so once it exits — a bind
 * clash, a dropped connection, a host reboot — the forwards stay dead until
 * something else happens to restart it.
 *
 * It only runs while the app is in front of a user. Probing a backgrounded app
 * on a locked laptop wakes the connection for nobody's benefit, and tearing down
 * a master while nobody is watching is worse than useless — the panes it drops
 * would be reattached to a screen no one is looking at. Coming back to the app
 * is also the moment a hang is most likely and least welcome, so a probe runs
 * immediately on focus, unlock and resume rather than waiting for the interval.
 */

const INTERVAL_MS = 10_000
/**
 * Generous next to a normal round trip of ~200ms, and longer than the probe's
 * own 4s ConnectTimeout, so an unreachable host reports itself rather than being
 * killed here and mistaken for a hang.
 */
const PROBE_TIMEOUT_MS = 6_000
/** Consecutive hangs before the master is torn down. */
const STRIKES = 2
const TUNNEL_RETRY_MIN_MS = 10_000
const TUNNEL_RETRY_MAX_MS = 60_000

/**
 * ssh's own words when the server will not open another channel on the shared
 * connection. It prints one of these and then silently opens a connection of its
 * own instead, so the command still works — which is exactly why this needs
 * catching. Nothing fails; everything just gets five times slower.
 */
const SATURATED_RE =
  /session request failed|open failed: administratively prohibited|channel \d+: open failed/i

export class HealthMonitor {
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private strikes = 0
  /**
   * Set when a master has been torn down, so the next good probe can say so.
   * Without it the log ends on "clearing it out" and never confirms the repair
   * took — which is the one thing anyone reading it back wants to know.
   */
  private repaired = false
  private tunnelFailures = 0
  private nextTunnelTry = 0
  /** Whether the shared connection is currently refusing new channels. */
  private saturated = false

  constructor(
    private readonly ssh: () => SshConfig,
    private readonly tunnels: TunnelManager,
    /** Whether a user is actually there: window in front, screen unlocked. */
    private readonly active: () => boolean
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Check now — on focus, unlock or resume, where a stale connection surfaces. */
  wake(): void {
    void this.tick()
  }

  private async tick(): Promise<void> {
    // One at a time: a probe that is itself hanging must not stack up behind
    // another, which is the pile-up the forwarder used to suffer from.
    if (this.busy || !this.active()) return
    const ssh = this.ssh()
    if (!ssh.host) return

    this.busy = true
    try {
      await this.checkConnection(ssh)
      await this.checkForwarder()
    } finally {
      this.busy = false
    }
  }

  private async checkConnection(ssh: SshConfig): Promise<void> {
    try {
      const { ms, stderr } = await probe(ssh, PROBE_TIMEOUT_MS)
      if (this.strikes || this.repaired) {
        activity.add('ssh', 'ok', `connection responding again (${ms}ms)`)
      }
      this.strikes = 0
      this.repaired = false
      this.checkSaturation(stderr, ms)
    } catch (err) {
      /*
       * Only a silent kill counts. Everything else — refused, unreachable, auth,
       * DNS — is ssh answering promptly with a reason, which means the master is
       * not the problem and tearing it down would fix nothing. The renderer's
       * reconnect loop owns those.
       */
      if (!wedged(err)) {
        this.strikes = 0
        return
      }
      this.strikes++
      activity.add('ssh', 'warn', `health probe got no answer (${this.strikes}/${STRIKES})`)
      if (this.strikes < STRIKES) return

      this.strikes = 0
      this.repaired = true
      activity.add('ssh', 'warn', 'connection is hung — clearing it out')
      await resetMaster(ssh)
      /*
       * The forwarder's channel died with the master, so it has to come back on
       * a new one. Panes drop here too, which sounds violent but is not: their
       * channels were already on a connection carrying nothing, and reattaching
       * is what makes them live again. tmux kept the sessions throughout.
       */
      this.tunnels.restart()
    }
  }

  /**
   * Notice when the connection has stopped being shared.
   *
   * Reported on the transition only, in both directions: this runs every ten
   * seconds, and a line repeating forever is a line people stop reading. The
   * advice belongs here rather than in a doc comment because the log is where
   * someone will be looking when it happens.
   */
  private checkSaturation(stderr: string, ms: number): void {
    const refusing = SATURATED_RE.test(stderr)
    if (refusing === this.saturated) return
    this.saturated = refusing
    if (refusing) {
      activity.add(
        'ssh',
        'warn',
        `the host is refusing extra channels on the shared connection — every call now opens its own (${ms}ms, normally ~200ms)`,
        {
          detail: `${stderr.trim()}\n\nEach attached pane holds one channel, and sshd allows 10 by default.\nRaise MaxSessions in /etc/ssh/sshd_config on the host, or turn on\n"Detach background sessions" in Settings to free a channel per hidden pane.`
        }
      )
      return
    }
    activity.add('ssh', 'ok', `sharing one connection again (${ms}ms)`)
  }

  private async checkForwarder(): Promise<void> {
    // Liveness is the local listeners, not our child process: `ssh -N` hands the
    // forwards to the shared connection and exits, so a dead child is the normal
    // case rather than a fault.
    if (!this.tunnels.wants() || (await this.tunnels.listening())) {
      this.tunnelFailures = 0
      return
    }
    const now = Date.now()
    if (now < this.nextTunnelTry) return

    this.tunnelFailures++
    // Back off, because the commonest reason a forward will not come up is a
    // local port something else owns, and that does not resolve by retrying.
    const wait = Math.min(TUNNEL_RETRY_MAX_MS, TUNNEL_RETRY_MIN_MS * 2 ** (this.tunnelFailures - 1))
    this.nextTunnelTry = now + wait
    activity.add('tunnel', 'warn', `forwarder is down — restarting (attempt ${this.tunnelFailures})`)
    this.tunnels.restart()
  }
}
