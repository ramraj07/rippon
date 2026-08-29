import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { activity } from './activity'
import type { RemoteEntry, RemoteListing, RemotePreview } from '../shared/types'

/**
 * Running the same commands on this machine instead of over ssh.
 *
 * A local host is the same workspace with the network hop removed: tmux still
 * owns the sessions, profiles are still JSON files under `~/.rippon/profiles`,
 * and the tab strip is still `tmux list-sessions`. Only the transport changes.
 *
 * Two things do not carry over, and both are handled here rather than left to
 * fail confusingly:
 *
 * - **PATH.** A GUI app launched from Finder inherits a bare
 *   `/usr/bin:/bin:/usr/sbin:/sbin`, so a Homebrew tmux at `/opt/homebrew/bin`
 *   is simply not there. The remote case never hits this because the far side
 *   runs a login shell for us. Here we have to ask for one — once, at first use.
 * - **coreutils.** files.ts speaks GNU (`find -printf`, `stat -c`), which a Mac
 *   does not have. Rather than maintain a second dialect of shell, the local
 *   file browser reads the filesystem directly through node.
 */

/** Biggest slice of a file we will read to show. Matches the remote path. */
const PREVIEW_BYTES = 256 * 1024
const MAX_ENTRIES = 5000
/** A login shell can be slow (nvm, conda); generous, but not unbounded. */
const PATH_TIMEOUT_MS = 5000
/** Matches the ssh side, so a wedged local command is not treated differently. */
const TIMEOUT_MS = 20000

/**
 * PATH as an interactive terminal would see it, resolved once and reused.
 *
 * Cached as the promise, not the result, so a burst of calls at startup — the
 * session poll, the profile read, the first attach — shares one login shell
 * rather than each paying for its own.
 */
let pathPromise: Promise<string> | null = null

function loginShell(): string {
  return process.env['SHELL'] || '/bin/zsh'
}

async function resolvePath(): Promise<string> {
  const shell = loginShell()
  try {
    const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
      execFile(
        shell,
        ['-l', '-c', 'printf %s "$PATH"'],
        { timeout: PATH_TIMEOUT_MS },
        (err, stdout) => (err ? reject(err) : resolve({ stdout }))
      )
    })
    const value = stdout.trim()
    if (!value) throw new Error('login shell reported an empty PATH')
    activity.add('ssh', 'info', 'local PATH resolved from a login shell', { detail: value })
    return value
  } catch (err) {
    /*
     * Not fatal on its own — the fallback below still finds a tmux installed in
     * either of the two places anyone puts one — but it is worth a line, because
     * the symptom it causes ("tmux: command not found" from an app that works
     * fine in Terminal) gives no hint that PATH is the reason.
     */
    const fallback = [
      process.env['PATH'] ?? '',
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin'
    ]
      .filter(Boolean)
      .join(':')
    activity.add('ssh', 'warn', `could not read PATH from ${shell}; using a fallback`, {
      detail: `${err instanceof Error ? err.message : String(err)}\n\nfalling back to: ${fallback}`
    })
    return fallback
  }
}

export function localPath(): Promise<string> {
  if (!pathPromise) pathPromise = resolvePath()
  return pathPromise
}

/** The environment local children run in: ours, with a usable PATH. */
export async function localEnv(): Promise<NodeJS.ProcessEnv> {
  return { ...process.env, PATH: await localPath() }
}

export interface LocalRunOptions {
  stdin?: string
  maxBuffer?: number
}

/**
 * Run a shell command here, with the same contract `runOnce` gives the ssh path:
 * resolve with stdout, or reject with stdout/stderr attached for `describe`.
 *
 * `sh -c` rather than the login shell: the commands are plain POSIX and already
 * built to be run by a remote `sh`, and re-sourcing someone's zshrc on every
 * five-second session poll would be both slow and a source of stray output.
 */
export async function runLocal(
  command: string,
  opts: LocalRunOptions = {}
): Promise<string> {
  const env = await localEnv()
  return new Promise((resolve, reject) => {
    const child = execFile(
      '/bin/sh',
      ['-c', command],
      {
        cwd: os.homedir(),
        env,
        timeout: TIMEOUT_MS,
        maxBuffer: opts.maxBuffer ?? 1024 * 1024
      },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stdout, stderr }))
        else resolve(stdout)
      }
    )
    if (opts.stdin !== undefined) {
      // The command can exit before reading stdin (an "exists" guard does), which
      // closes the pipe — the callback reports the real failure, so swallow EPIPE.
      child.stdin?.on('error', () => {})
      child.stdin?.end(opts.stdin)
    }
  })
}

/**
 * What to spawn in a PTY to attach to a local session.
 *
 * Through the login shell, unlike `runLocal`: this *is* the user's terminal, so
 * it should start in the environment their terminal would — and `tmux` has to be
 * findable by name for the `-c` command to work at all.
 */
export function attachCommand(session: string): { file: string; args: string[] } {
  return { file: loginShell(), args: ['-l', '-c', `tmux -u new-session -A -s ${session}`] }
}

// ---------- the file browser, without a shell ----------

/** Resolve what the user typed the way `cd` would: `~`, `..`, relative to home. */
export function expandLocal(input: string): string {
  const p = input.trim()
  if (!p || p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return path.resolve(os.homedir(), p)
}

export async function localListDir(input: string): Promise<RemoteListing> {
  const dir = expandLocal(input)
  // realpath so the browser navigates by an absolute, symlink-free path from
  // here on, exactly as `cd … && pwd -P` gives us on the remote side.
  const resolved = await fsp.realpath(dir)
  const names = await fsp.readdir(resolved)

  const all: RemoteEntry[] = []
  for (const name of names) {
    const full = path.join(resolved, name)
    let self: fs.Stats
    try {
      self = await fsp.lstat(full)
    } catch {
      // Raced with a delete, or unreadable. A file browser that refuses to list a
      // whole directory over one bad entry is worse than one that skips it.
      continue
    }
    let isDir = self.isDirectory()
    if (self.isSymbolicLink()) {
      // A symlink to a directory opens like one, so it is the target that decides.
      try {
        isDir = (await fsp.stat(full)).isDirectory()
      } catch {
        isDir = false
      }
    }
    all.push({
      name,
      type: self.isSymbolicLink()
        ? 'link'
        : self.isDirectory()
          ? 'dir'
          : self.isFile()
            ? 'file'
            : 'other',
      isDir,
      size: self.size,
      mtime: Math.floor(self.mtimeMs / 1000)
    })
  }

  all.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })

  activity.add('ssh', 'ok', `list ${input || '~'} → ${all.length} item${all.length === 1 ? '' : 's'}`)
  return {
    path: resolved,
    entries: all.slice(0, MAX_ENTRIES),
    truncated: all.length > MAX_ENTRIES
  }
}

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon'
}

function imageType(p: string): string | null {
  const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase()
  return IMAGE_TYPES[ext] ?? null
}

export async function localPreview(input: string): Promise<RemotePreview> {
  const file = expandLocal(input)
  const { size } = await fsp.stat(file)

  const handle = await fsp.open(file, 'r')
  let bytes: Buffer
  try {
    const buf = Buffer.alloc(Math.min(size, PREVIEW_BYTES))
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    bytes = buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
  const truncated = size > bytes.length

  const mime = imageType(input)
  if (mime && !truncated) {
    return {
      path: input,
      size,
      truncated: false,
      kind: 'image',
      content: `data:${mime};base64,${bytes.toString('base64')}`
    }
  }
  // Same test as the remote path: a NUL near the front means "not text".
  if (bytes.subarray(0, 8000).includes(0)) {
    return { path: input, size, truncated, kind: 'binary', content: '' }
  }
  return { path: input, size, truncated, kind: 'text', content: bytes.toString('utf8') }
}

/**
 * Copy a local file to wherever the save dialog pointed.
 *
 * Kept as a "download" so the dialog behaves identically on both kinds of host.
 * Streamed rather than `fs.copyFile` only so the progress bar has something to
 * report; a same-disk copy of a large file is otherwise indistinguishable from
 * a hang.
 */
export function localDownload(
  input: string,
  localPathTarget: string,
  onProgress: (bytes: number) => void
): Promise<number> {
  const source = expandLocal(input)
  return new Promise((resolve, reject) => {
    const read = fs.createReadStream(source)
    const out = fs.createWriteStream(localPathTarget)
    let bytes = 0
    let settled = false

    const fail = (message: string): void => {
      if (settled) return
      settled = true
      read.destroy()
      out.destroy()
      // A half-written file reads as a successful copy until something opens it.
      fs.rm(localPathTarget, { force: true }, () => reject(new Error(message)))
    }

    read.on('data', (chunk) => {
      bytes += chunk.length
      onProgress(bytes)
    })
    read.on('error', (err) => fail(err.message))
    out.on('error', (err) => fail(err.message))
    read.pipe(out)
    out.on('finish', () => {
      if (settled) return
      settled = true
      activity.add('ssh', 'ok', `copy ${input}`, {
        detail: `${bytes} bytes → ${localPathTarget}`
      })
      resolve(bytes)
    })
  })
}
