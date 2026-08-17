import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { activity } from './activity'
import { SESSION_NAME_RE, type ActivitySource, type SessionInfo, type SshConfig } from '../shared/types'

const exec = promisify(execFile)

const LIST_FORMAT = '#{session_name}\t#{session_created}\t#{session_attached}\t#{session_windows}'
const CONTROL_DIR = path.join(os.homedir(), '.rippon')

/** How long any one non-interactive ssh call gets before we give up on it. */
const TIMEOUT_MS = 20000

/*
 * Keepalive is not a nicety here, it is what stops the multiplexed connection
 * from taking the whole app down with it.
 *
 * When the path to the host disappears mid-connection — a VPN re-route, a sleep,
 * a Wi-Fi change — the TCP socket is left half-open. The kernel happily reports
 * it ESTABLISHED for another two hours, so a master with no keepalive never
 * notices and never exits. It keeps answering on its control socket, and every
 * new ssh with ControlMaster=auto joins it and blocks forever behind a
 * connection that will never carry another byte. The give-away is that a plain
 * `ssh host` still works instantly: with no ControlPath it never touches the
 * wedged master. `ssh -O check` is no help either — it asks the local process,
 * not the network, so it cheerfully reports "Master running".
 *
 * ServerAlive turns that from a hang into a clean exit after ~45s, which the
 * next call is free to replace with a fresh connection.
 */
const KEEPALIVE_ARGS = [
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=3',
  // A host that is simply unreachable should say so long before TIMEOUT_MS, so
  // the failure arrives as ssh's own message rather than our timeout killing it.
  '-o',
  'ConnectTimeout=10'
]

/**
 * Every ssh invocation shares one multiplexed connection. The interactive tmux
 * attach usually opens it, so the frequent list/create/kill calls cost no
 * handshake and, more importantly, no second round of auth prompts.
 */
export function controlArgs(): string[] {
  fs.mkdirSync(CONTROL_DIR, { recursive: true })
  return [
    ...KEEPALIVE_ARGS,
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${path.join(CONTROL_DIR, 'cm-%C')}`,
    '-o',
    'ControlPersist=120'
  ]
}

/**
 * The same connection settings with multiplexing off, for the one retry after a
 * hang: it cannot join — or re-wedge on — the master we just gave up on.
 */
function soloArgs(): string[] {
  return [...KEEPALIVE_ARGS, '-o', 'ControlPath=none']
}

/** Args for the interactive PTY connection that attaches to a session. */
export function attachArgs(ssh: SshConfig, session: string): string[] {
  assertName(session)
  return [
    '-tt',
    ...controlArgs(),
    ...ssh.args,
    ssh.host,
    `tmux -u new-session -A -s ${session}`
  ]
}

function assertName(name: string): void {
  if (!SESSION_NAME_RE.test(name)) throw new Error(`Invalid tmux session name: ${name}`)
}

/**
 * Everything ssh and tmux have to say about a failure, kept whole.
 *
 * These messages are the only diagnosis the user gets — an ssh failure explains
 * itself in stderr and nowhere else — so nothing here summarises. The earlier
 * version kept the last three lines joined onto one, which reliably threw away
 * the first line, the one that says what actually went wrong.
 */
function describe(err: unknown, command: string): string {
  const e = err as {
    stderr?: string
    stdout?: string
    code?: number | string
    signal?: string
    message?: string
  }
  // ssh writes CRLF when it has a tty in play; left in, every line renders with a
  // stray carriage return in the middle of the log.
  const clean = (s: string | undefined): string => (s ?? '').replace(/\r\n?/g, '\n').trim()
  const stderr = clean(e.stderr)
  const stdout = clean(e.stdout)
  const body = stderr || stdout || (e.message ?? String(err)).trim()

  // "exit 1" alone explains nothing; ENOENT means ssh itself is missing, and a
  // signal here is almost always our own timeout. That one needs spelling out:
  // a silent kill is exactly what a hang looks like, and since remote() already
  // retried on a connection of its own, reaching here means both attempts hung —
  // which points at the network or the host, not at the multiplexed connection.
  const how = e.signal
    ? `killed by ${e.signal}${
        e.signal === 'SIGTERM'
          ? ` — no response within ${TIMEOUT_MS / 1000}s, on the shared connection and on a fresh one`
          : ''
      }`
    : typeof e.code === 'string'
      ? e.code === 'ENOENT'
        ? 'ENOENT — no ssh binary on PATH'
        : e.code
      : typeof e.code === 'number'
        ? `exit ${e.code}`
        : 'failed'

  return `${body}\n\nran: ${command}\n(${how})`.slice(0, 4000)
}

export interface RemoteOptions {
  /** Piped to the remote command's stdin when present. */
  stdin?: string
  maxBuffer?: number
  /** Which part of the app this call belongs to, for the activity log. */
  source?: ActivitySource
  /** Short label for the log. Defaults to the command, trimmed. */
  label?: string
  /**
   * Turns stdout into a few words for the log — "7 sessions" rather than the
   * bare fact that the call returned. Only ever called on success.
   */
  summarise?: (stdout: string) => string
}

/**
 * Whether a failure looks like the wedged master described above rather than an
 * honest refusal.
 *
 * Our own timeout is the signature: ssh reports every real failure — auth, DNS,
 * refused, ConnectTimeout — promptly and on stderr. Being killed while silent
 * means it was waiting on something that was never going to answer.
 */
function wedged(err: unknown): boolean {
  const e = err as { killed?: boolean; signal?: string }
  return e.killed === true || e.signal === 'SIGTERM'
}

/** Ask the multiplexing master to exit. Best-effort: a failure here is fine. */
async function resetMaster(ssh: SshConfig): Promise<void> {
  try {
    await exec('ssh', [...controlArgs(), ...ssh.args, '-O', 'exit', ssh.host], { timeout: 5000 })
    activity.add('ssh', 'info', 'shared connection torn down (-O exit)')
  } catch (err) {
    // Either there was no master, or it is too far gone to answer its own
    // control socket. The retry does not go through it either way.
    activity.add('ssh', 'info', 'shared connection could not be torn down', {
      detail: err instanceof Error ? err.message : String(err)
    })
  }
}

function runOnce(
  ssh: SshConfig,
  command: string,
  args: string[],
  opts: RemoteOptions
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'ssh',
      [...args, ...ssh.args, ssh.host, command],
      { timeout: TIMEOUT_MS, maxBuffer: opts.maxBuffer ?? 1024 * 1024 },
      (err, stdout, stderr) => {
        // execFile hands stderr to the callback, not to the error, and describe()
        // needs it — it is the only place ssh ever explains itself.
        if (err) reject(Object.assign(err, { stdout, stderr }))
        else resolve(stdout)
      }
    )
    if (opts.stdin !== undefined) {
      // A guard command (e.g. an "exists" check) can exit before reading stdin,
      // closing the pipe — swallow the resulting EPIPE, the callback reports the
      // real failure.
      child.stdin?.on('error', () => {})
      child.stdin?.end(opts.stdin)
    }
  })
}

/**
 * Run a remote command: once over the shared connection and, only if that hung,
 * once more on a connection of its own.
 *
 * The retry is what turns a wedged master from a visible failure into a blip.
 * It is deliberately narrow — a host that is merely down answers quickly and is
 * reported as-is, so this never doubles the wait for the common case.
 */
export async function remote(
  ssh: SshConfig,
  command: string,
  opts: RemoteOptions = {}
): Promise<string> {
  if (!ssh.host) throw new Error('No SSH host configured.')
  const source = opts.source ?? 'ssh'
  const label = opts.label ?? command.replace(/\s+/g, ' ').slice(0, 60)
  const started = Date.now()
  const since = (): number => Date.now() - started

  const ok = (stdout: string, fresh: boolean): string => {
    const summary = opts.summarise?.(stdout)
    const suffix = fresh ? ' (on a fresh connection)' : ''
    activity.add(source, 'ok', `${label}${summary ? ` → ${summary}` : ''}${suffix}`, { ms: since() })
    return stdout
  }

  try {
    return ok(await runOnce(ssh, command, controlArgs(), opts), false)
  } catch (err) {
    if (!wedged(err)) {
      const text = describe(err, command)
      activity.add(source, 'error', label, { ms: since(), detail: text })
      throw new Error(text)
    }
    activity.add(source, 'warn', `${label} — no response in ${TIMEOUT_MS / 1000}s, retrying`, {
      ms: since()
    })
    await resetMaster(ssh)
    try {
      return ok(await runOnce(ssh, command, soloArgs(), opts), true)
    } catch (retry) {
      const text = describe(retry, command)
      activity.add(source, 'error', `${label} — failed on a fresh connection too`, {
        ms: since(),
        detail: text
      })
      throw new Error(text)
    }
  }
}

export async function listSessions(ssh: SshConfig): Promise<SessionInfo[]> {
  let stdout: string
  try {
    stdout = await remote(ssh, `tmux list-sessions -F '${LIST_FORMAT}'`, {
      source: 'tmux',
      label: 'list-sessions',
      summarise: (out) => {
        const n = out.split('\n').filter((l) => l.trim()).length
        return `${n} session${n === 1 ? '' : 's'}`
      }
    })
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    /*
     * tmux exits non-zero before its server has started, and that genuinely is
     * "no sessions yet". Nothing else is.
     *
     * A bare "error connecting to" used to match here too, which swallowed the
     * cases where the socket exists and refuses us — permission denied, a stale
     * socket, a server that died. Those came back as an empty list, so a host
     * with broken tmux looked exactly like a host with nothing running on it,
     * right until creating a session failed for no visible reason.
     */
    if (/no server running|no sessions exist/i.test(text)) return []
    if (/error connecting to .*no such file or directory/is.test(text)) return []
    throw err
  }

  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, created, attached, windows] = line.split('\t')
      return {
        name,
        created: Number(created) || 0,
        attached: attached === '1',
        windows: Number(windows) || 1
      }
    })
    .filter((s) => SESSION_NAME_RE.test(s.name))
    .sort((a, b) => a.created - b.created || a.name.localeCompare(b.name))
}

export async function createSession(ssh: SshConfig, name: string): Promise<void> {
  assertName(name)
  const command = ssh.newSessionCommand?.trim()
  await remote(ssh, `tmux new-session -d -s ${name}${command ? ` ${command}` : ''}`, {
    source: 'tmux',
    label: `new-session ${name}`
  })
}

export async function killSession(ssh: SshConfig, name: string): Promise<void> {
  assertName(name)
  try {
    await remote(ssh, `tmux kill-session -t ${name}`, {
      source: 'tmux',
      label: `kill-session ${name}`
    })
  } catch (err) {
    // Already gone is the outcome we wanted anyway.
    const text = err instanceof Error ? err.message : String(err)
    if (/can't find session|no server running/i.test(text)) return
    throw err
  }
}

export async function renameSession(ssh: SshConfig, from: string, to: string): Promise<void> {
  assertName(from)
  assertName(to)
  await remote(ssh, `tmux rename-session -t ${from} ${to}`, {
    source: 'tmux',
    label: `rename-session ${from} → ${to}`
  })
}
