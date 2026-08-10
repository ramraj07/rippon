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
function controlArgs(): string[] {
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

async function remote(ssh: SshConfig, command: string): Promise<string> {
  if (!ssh.host) throw new Error('No SSH host configured.')
  const { stdout } = await exec('ssh', [...controlArgs(), ...ssh.args, ssh.host, command], {
    timeout: 20000,
    maxBuffer: 1024 * 1024
  })
  return stdout
}

/** Turn ssh/tmux stderr into something worth putting in the UI. */
function describe(err: unknown): string {
  const e = err as { stderr?: string; message?: string }
  const text = (e.stderr || e.message || String(err)).trim()
  return text.split('\n').filter(Boolean).slice(-3).join(' — ')
}

export async function listSessions(ssh: SshConfig): Promise<SessionInfo[]> {
  let stdout: string
  try {
    stdout = await remote(ssh, `tmux list-sessions -F '${LIST_FORMAT}'`)
  } catch (err) {
    // tmux exits non-zero when no server is running yet — that is just "no sessions".
    const text = describe(err)
    if (/no server running|no sessions|error connecting to/i.test(text)) return []
    throw new Error(text)
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
  try {
    await remote(ssh, `tmux new-session -d -s ${name}${command ? ` ${command}` : ''}`)
  } catch (err) {
    throw new Error(describe(err))
  }
}

export async function killSession(ssh: SshConfig, name: string): Promise<void> {
  assertName(name)
  try {
    await remote(ssh, `tmux kill-session -t ${name}`)
  } catch (err) {
    const text = describe(err)
    // Already gone is the outcome we wanted anyway.
    if (/can't find session|no server running/i.test(text)) return
    throw new Error(text)
  }
}

export async function renameSession(ssh: SshConfig, from: string, to: string): Promise<void> {
  assertName(from)
  assertName(to)
  try {
    await remote(ssh, `tmux rename-session -t ${from} ${to}`)
  } catch (err) {
    throw new Error(describe(err))
  }
}
