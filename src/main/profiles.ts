import { remote } from './tmux'
import { defaultProfile, normalizeProfile, PROFILE_NAME_RE, type Profile, type HostConfig } from '../shared/types'

/**
 * Profiles live on the host, under `~/.rippon/profiles/<name>.json` in the SSH
 * user's home — or your own, for a local host. Same multiplexed connection as
 * tmux/tunnels, so reads and writes cost no extra handshake. Names are validated
 * to the tmux-safe subset before they ever reach a shell, so it is safe to
 * interpolate them into the command — the JSON payload only ever travels over
 * stdin, never inline.
 *
 * Every command here is plain POSIX, which is what lets the same module serve a
 * local host: `sh` on a Mac runs these exactly as a Linux host's does. That is
 * not true of files.ts, which speaks GNU coreutils and takes a separate path.
 */

const REMOTE_DIR = '~/.rippon/profiles'

function assertName(name: string): void {
  if (!PROFILE_NAME_RE.test(name)) throw new Error(`Invalid profile name: ${name}`)
}

function remotePath(name: string): string {
  return `${REMOTE_DIR}/${name}.json`
}

/*
 * Everything here goes through tmux.ts's `remote`, which owns the ssh options,
 * the timeout, and the one retry that recovers a wedged multiplexing master.
 * This module used to run its own execFile with its own error formatting, and
 * that formatting only ever looked at stderr — so a hang, which is killed
 * silently and leaves stderr empty, surfaced as a bare "Command failed: ssh …"
 * with no hint that it had timed out or why.
 */

/** Run a remote command and return its stdout. */
function sshRead(ssh: HostConfig, command: string, label: string): Promise<string> {
  return remote(ssh, command, { maxBuffer: 4 * 1024 * 1024, source: 'profile', label })
}

/** Run a remote command, ignoring stdout. */
async function sshRun(ssh: HostConfig, command: string, label: string): Promise<void> {
  await remote(ssh, command, { source: 'profile', label })
}

/** Run a remote command with `text` piped to its stdin. */
async function sshWrite(
  ssh: HostConfig,
  command: string,
  text: string,
  label: string
): Promise<void> {
  await remote(ssh, command, { stdin: text, source: 'profile', label })
}

export async function listProfiles(ssh: HostConfig): Promise<string[]> {
  const stdout = await sshRead(ssh, `ls -1 ${REMOTE_DIR} 2>/dev/null || true`, 'list profiles')
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .filter((n) => PROFILE_NAME_RE.test(n))
    .sort((a, b) => a.localeCompare(b))
}

/** Printed instead of the file when there is no file. Not valid JSON, by design. */
const MISSING = '__rippon_no_profile__'

/**
 * Read one profile, or null if the host has no file for it yet.
 *
 * The remote side reports "no such profile" as a sentinel on stdout rather than
 * by failing, so it stays distinguishable from a file that exists and could not
 * be read. That distinction matters twice over: a `cat` that failed on
 * permissions used to look identical to a first run, and the caller's response
 * to a first run is to seed the profile — which would have written over the
 * unreadable one. It also keeps the activity log honest, since the old version
 * logged every first run as an error.
 */
export async function readProfile(ssh: HostConfig, name: string): Promise<Profile | null> {
  assertName(name)
  const file = remotePath(name)
  const stdout = await sshRead(
    ssh,
    `if [ -e ${file} ]; then cat ${file}; else echo ${MISSING}; fi`,
    `read ${name}.json`
  )
  if (stdout.trim() === MISSING) return null
  if (!stdout.trim()) return null
  try {
    return normalizeProfile(JSON.parse(stdout))
  } catch {
    throw new Error(`Profile "${name}" on the host is not valid JSON.`)
  }
}

/** Atomically write a profile (temp file then rename), creating the dir. */
export async function writeProfile(ssh: HostConfig, name: string, profile: Profile): Promise<void> {
  assertName(name)
  const text = JSON.stringify(profile, null, 2) + '\n'
  const tmp = `${REMOTE_DIR}/.${name}.${process.pid}.tmp`
  await sshWrite(
    ssh,
    `mkdir -p ${REMOTE_DIR} && cat > ${tmp} && mv ${tmp} ${remotePath(name)}`,
    text,
    `write ${name}.json`
  )
}

/** Create a fresh profile from the defaults, refusing to clobber an existing one. */
export async function createProfile(ssh: HostConfig, name: string): Promise<void> {
  assertName(name)
  const text = JSON.stringify(defaultProfile(), null, 2) + '\n'
  const tmp = `${REMOTE_DIR}/.${name}.${process.pid}.tmp`
  await sshWrite(
    ssh,
    `mkdir -p ${REMOTE_DIR} && if [ -e ${remotePath(name)} ]; then echo "profile already exists" >&2; exit 1; fi && cat > ${tmp} && mv ${tmp} ${remotePath(name)}`,
    text,
    `create ${name}.json`
  )
}

export async function renameProfile(ssh: HostConfig, from: string, to: string): Promise<void> {
  assertName(from)
  assertName(to)
  if (from === to) return
  await sshRun(
    ssh,
    `if [ -e ${remotePath(to)} ]; then echo "profile already exists" >&2; exit 1; fi; mv ${remotePath(from)} ${remotePath(to)}`,
    `rename ${from}.json → ${to}.json`
  )
}

export async function deleteProfile(ssh: HostConfig, name: string): Promise<void> {
  assertName(name)
  await sshRun(ssh, `rm -f ${remotePath(name)}`, `delete ${name}.json`)
}
