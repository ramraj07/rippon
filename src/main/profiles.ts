import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { controlArgs } from './tmux'
import { defaultProfile, normalizeProfile, PROFILE_NAME_RE, type Profile, type SshConfig } from '../shared/types'

/**
 * Profiles live on the remote host, under `~/.rippon/profiles/<name>.json` in
 * the SSH user's home. Same multiplexed connection as tmux/tunnels, so reads and
 * writes cost no extra handshake. Names are validated to the tmux-safe subset
 * before they ever reach a shell, so it is safe to interpolate them into the
 * remote command — the JSON payload only ever travels over stdin, never inline.
 */

const exec = promisify(execFile)
const REMOTE_DIR = '~/.rippon/profiles'

function assertName(name: string): void {
  if (!PROFILE_NAME_RE.test(name)) throw new Error(`Invalid profile name: ${name}`)
}

function remotePath(name: string): string {
  return `${REMOTE_DIR}/${name}.json`
}

function describe(err: unknown): string {
  const e = err as { stderr?: string; message?: string }
  const text = (e.stderr || e.message || String(err)).trim()
  return text.split('\n').filter(Boolean).slice(-3).join(' — ')
}

/** Run a remote command and return its stdout. */
async function sshRead(ssh: SshConfig, command: string): Promise<string> {
  if (!ssh.host) throw new Error('No SSH host configured.')
  const { stdout } = await exec('ssh', [...controlArgs(), ...ssh.args, ssh.host, command], {
    timeout: 20000,
    maxBuffer: 4 * 1024 * 1024
  })
  return stdout
}

/** Run a remote command, ignoring stdout; throws a described error on failure. */
async function sshRun(ssh: SshConfig, command: string): Promise<void> {
  try {
    await sshRead(ssh, command)
  } catch (err) {
    throw new Error(describe(err))
  }
}

/** Run a remote command with `text` piped to its stdin. */
function sshWrite(ssh: SshConfig, command: string, text: string): Promise<void> {
  if (!ssh.host) return Promise.reject(new Error('No SSH host configured.'))
  return new Promise((resolve, reject) => {
    const child = execFile(
      'ssh',
      [...controlArgs(), ...ssh.args, ssh.host, command],
      { timeout: 20000 },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(describe({ stderr, message: err.message })))
        else resolve()
      }
    )
    // A guard command (e.g. "exists" check) can exit before reading stdin,
    // closing the pipe — swallow the resulting EPIPE, the callback reports it.
    child.stdin?.on('error', () => {})
    child.stdin?.end(text)
  })
}

export async function listProfiles(ssh: SshConfig): Promise<string[]> {
  const stdout = await sshRead(ssh, `ls -1 ${REMOTE_DIR} 2>/dev/null || true`)
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .filter((n) => PROFILE_NAME_RE.test(n))
    .sort((a, b) => a.localeCompare(b))
}

/** Read one profile, or null if the host has no file for it yet. */
export async function readProfile(ssh: SshConfig, name: string): Promise<Profile | null> {
  assertName(name)
  let stdout: string
  try {
    stdout = await sshRead(ssh, `cat ${remotePath(name)}`)
  } catch (err) {
    const text = describe(err)
    if (/no such file|not found|cannot open/i.test(text)) return null
    throw new Error(text)
  }
  if (!stdout.trim()) return null
  try {
    return normalizeProfile(JSON.parse(stdout))
  } catch {
    throw new Error(`Profile "${name}" on the host is not valid JSON.`)
  }
}

/** Atomically write a profile (temp file then rename), creating the dir. */
export async function writeProfile(ssh: SshConfig, name: string, profile: Profile): Promise<void> {
  assertName(name)
  const text = JSON.stringify(profile, null, 2) + '\n'
  const tmp = `${REMOTE_DIR}/.${name}.${process.pid}.tmp`
  await sshWrite(ssh, `mkdir -p ${REMOTE_DIR} && cat > ${tmp} && mv ${tmp} ${remotePath(name)}`, text)
}

/** Create a fresh profile from the defaults, refusing to clobber an existing one. */
export async function createProfile(ssh: SshConfig, name: string): Promise<void> {
  assertName(name)
  const text = JSON.stringify(defaultProfile(), null, 2) + '\n'
  const tmp = `${REMOTE_DIR}/.${name}.${process.pid}.tmp`
  await sshWrite(
    ssh,
    `mkdir -p ${REMOTE_DIR} && if [ -e ${remotePath(name)} ]; then echo "profile already exists" >&2; exit 1; fi && cat > ${tmp} && mv ${tmp} ${remotePath(name)}`,
    text
  )
}

export async function renameProfile(ssh: SshConfig, from: string, to: string): Promise<void> {
  assertName(from)
  assertName(to)
  if (from === to) return
  await sshRun(
    ssh,
    `if [ -e ${remotePath(to)} ]; then echo "profile already exists" >&2; exit 1; fi; mv ${remotePath(from)} ${remotePath(to)}`
  )
}

export async function deleteProfile(ssh: SshConfig, name: string): Promise<void> {
  assertName(name)
  await sshRun(ssh, `rm -f ${remotePath(name)}`)
}
