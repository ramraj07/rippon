import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { SESSION_NAME_RE, type SessionInfo, type SshConfig } from '../shared/types'

const exec = promisify(execFile)

const LIST_FORMAT = '#{session_name}\t#{session_created}\t#{session_attached}\t#{session_windows}'
const CONTROL_DIR = path.join(os.homedir(), '.rippon')

/**
 * Every ssh invocation shares one multiplexed connection. The interactive tmux
 * attach usually opens it, so the frequent list/create/kill calls cost no
 * handshake and, more importantly, no second round of auth prompts.
 */
export function controlArgs(): string[] {
  fs.mkdirSync(CONTROL_DIR, { recursive: true })
  return [
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${path.join(CONTROL_DIR, 'cm-%C')}`,
    '-o',
    'ControlPersist=120'
  ]
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
  const stderr = (e.stderr ?? '').trim()
  const stdout = (e.stdout ?? '').trim()
  const body = stderr || stdout || (e.message ?? String(err)).trim()

  // "exit 1" alone explains nothing; ENOENT means ssh itself is missing, and a
  // signal here is almost always our own 20s timeout.
  const how = e.signal
    ? `killed by ${e.signal}${e.signal === 'SIGTERM' ? ' — timed out after 20s' : ''}`
    : typeof e.code === 'string'
      ? e.code === 'ENOENT'
        ? 'ENOENT — no ssh binary on PATH'
        : e.code
      : typeof e.code === 'number'
        ? `exit ${e.code}`
        : 'failed'

  return `${body}\n\nran: ${command}\n(${how})`.slice(0, 4000)
}

async function remote(ssh: SshConfig, command: string): Promise<string> {
  if (!ssh.host) throw new Error('No SSH host configured.')
  try {
    const { stdout } = await exec('ssh', [...controlArgs(), ...ssh.args, ssh.host, command], {
      timeout: 20000,
      maxBuffer: 1024 * 1024
    })
    return stdout
  } catch (err) {
    throw new Error(describe(err, command))
  }
}

export async function listSessions(ssh: SshConfig): Promise<SessionInfo[]> {
  let stdout: string
  try {
    stdout = await remote(ssh, `tmux list-sessions -F '${LIST_FORMAT}'`)
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
  await remote(ssh, `tmux new-session -d -s ${name}${command ? ` ${command}` : ''}`)
}

export async function killSession(ssh: SshConfig, name: string): Promise<void> {
  assertName(name)
  try {
    await remote(ssh, `tmux kill-session -t ${name}`)
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
  await remote(ssh, `tmux rename-session -t ${from} ${to}`)
}
