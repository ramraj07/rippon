import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { activity } from './activity'
import { localDownload, localListDir, localPreview } from './local'
import { controlArgs, remote } from './tmux'
import type { RemoteEntry, RemoteListing, RemotePreview, HostConfig } from '../shared/types'

/**
 * Reading the remote filesystem over the same multiplexed connection as
 * everything else.
 *
 * Listing and preview go through `remote()`, so they inherit its timeout, its
 * recovery from a wedged master, and its activity logging. Download does not:
 * it needs raw bytes and no size ceiling, so it streams straight from an ssh
 * child into a file (see downloadFile).
 *
 * These commands assume GNU coreutils — `find -printf`, `stat -c`, `head -c` —
 * which is what a Linux host has. A BSD or macOS remote would need its own
 * spellings, and would fail loudly rather than silently misreport. A *local*
 * host is exactly that case, so it does not come through here at all: each
 * entry point hands off to local.ts, which reads the filesystem through node
 * rather than keeping a second dialect of shell in sync with this one.
 */

/** Biggest slice of a file we will pull back to show. */
const PREVIEW_BYTES = 256 * 1024
/** A directory past this many entries is cut off rather than shipped whole. */
const MAX_ENTRIES = 5000

const SEP = '__rippon_sep__'

/**
 * POSIX single-quote, so an arbitrary filename survives the remote shell intact.
 *
 * Everything here takes paths straight from the user, unlike profile and session
 * names which are validated against a strict pattern. Spaces, quotes, `$(…)`,
 * newlines — all of it has to arrive at the far side as literal characters, so
 * every path is wrapped and every embedded quote is broken out and escaped.
 */
function q(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`
}

/**
 * Quote a path the user may have typed, keeping a leading `~` meaningful.
 *
 * Quoting is what stops a filename being read as shell syntax, but it stops `~`
 * being read as the home directory too — `cd '~'` looks for a directory actually
 * named "~". So the tilde is translated to "$HOME", itself double-quoted against
 * a home directory with a space in it, and only the remainder is quoted.
 */
function expand(path: string): string {
  const p = path.trim()
  if (!p || p === '~') return '"$HOME"'
  if (p.startsWith('~/')) return `"$HOME"/${q(p.slice(2))}`
  return q(p)
}

function parseEntries(text: string): RemoteEntry[] {
  const entries: RemoteEntry[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    // "%y%Y\t%s\t%T@\t%f": the type of the entry, the type it resolves to (so a
    // symlink to a directory can be walked into), size, mtime, then the name —
    // last, because it is the only field that can itself contain a tab.
    const parts = line.split('\t')
    if (parts.length < 4) continue
    const [types, size, mtime] = parts
    const name = parts.slice(3).join('\t')
    if (!name || name === '.' || name === '..') continue
    const self = types[0]
    const target = types[1] ?? self
    entries.push({
      name,
      type: self === 'l' ? 'link' : self === 'd' ? 'dir' : self === 'f' ? 'file' : 'other',
      /** Whether following it lands on a directory — what decides if it opens. */
      isDir: target === 'd',
      size: Number(size) || 0,
      mtime: Math.floor(Number(mtime) || 0)
    })
  }
  return entries.sort((a, b) => {
    // Directories first, then case-insensitive by name: the order people expect
    // from a file browser, and the order that makes navigating with the keyboard
    // predictable.
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

/** List one directory. `path` may be relative, `~`-rooted, or contain `..`. */
export async function listDir(ssh: HostConfig, path: string): Promise<RemoteListing> {
  if (ssh.kind === 'local') return localListDir(path)
  const target = path.trim() || '~'
  // `cd` first so the shell resolves ~, .. and symlinks for us, then report where
  // that actually landed — the browser navigates by absolute path from then on.
  const stdout = await remote(
    ssh,
    `cd ${expand(target)} && pwd -P && echo ${SEP} && find . -mindepth 1 -maxdepth 1 -printf '%y%Y\\t%s\\t%T@\\t%f\\n'`,
    {
      source: 'ssh',
      label: `list ${target}`,
      maxBuffer: 8 * 1024 * 1024,
      summarise: (out) => {
        const n = out.split(SEP)[1]?.split('\n').filter(Boolean).length ?? 0
        return `${n} item${n === 1 ? '' : 's'}`
      }
    }
  )

  const cut = stdout.indexOf(SEP)
  const resolved = (cut === -1 ? target : stdout.slice(0, cut)).trim()
  const all = parseEntries(cut === -1 ? '' : stdout.slice(cut + SEP.length))
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

function imageType(path: string): string | null {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return IMAGE_TYPES[ext] ?? null
}

/**
 * Fetch the head of a file to show.
 *
 * Base64 on the remote side rather than raw bytes, because everything between
 * here and there is a string: `remote()` decodes stdout as UTF-8, which would
 * quietly corrupt anything that is not text. Encoding first means the bytes
 * arrive intact and what they are gets decided here.
 */
export async function previewFile(ssh: HostConfig, path: string): Promise<RemotePreview> {
  if (ssh.kind === 'local') return localPreview(path)
  const stdout = await remote(
    ssh,
    `stat -c '%s' ${expand(path)} && echo ${SEP} && head -c ${PREVIEW_BYTES} ${expand(path)} | base64`,
    { source: 'ssh', label: `preview ${path}`, maxBuffer: 8 * 1024 * 1024 }
  )

  const cut = stdout.indexOf(SEP)
  const size = Number(stdout.slice(0, cut === -1 ? 0 : cut).trim()) || 0
  const bytes = Buffer.from(
    cut === -1 ? '' : stdout.slice(cut + SEP.length).replace(/\s+/g, ''),
    'base64'
  )
  const truncated = size > bytes.length

  const mime = imageType(path)
  if (mime && !truncated) {
    return { path, size, truncated: false, kind: 'image', content: `data:${mime};base64,${bytes.toString('base64')}` }
  }

  // A NUL byte anywhere near the front is the practical test for "not text".
  // Nothing else reliably separates a minified bundle from a binary blob.
  if (bytes.subarray(0, 8000).includes(0)) {
    return { path, size, truncated, kind: 'binary', content: '' }
  }
  return { path, size, truncated, kind: 'text', content: bytes.toString('utf8') }
}

/**
 * Stream a remote file to a local path.
 *
 * `cat` down an ssh pipe rather than scp: it reuses the app's own ssh args
 * verbatim, where scp would need them translated (its port flag is -P, not -p),
 * and it keeps the bytes on a raw pipe so nothing decodes them. Size is bounded
 * only by the disk. The shared master carries it, so there is no second auth
 * prompt — which is the constraint the rest of the app is built around too.
 */
export function downloadFile(
  ssh: HostConfig,
  path: string,
  localPath: string,
  onProgress: (bytes: number) => void
): Promise<number> {
  if (ssh.kind === 'local') return localDownload(path, localPath, onProgress)
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ssh',
      [...controlArgs(), ...ssh.args, ssh.host, `cat -- ${expand(path)}`],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )

    const out = fs.createWriteStream(localPath)
    let bytes = 0
    let stderr = ''
    let settled = false

    const fail = (message: string): void => {
      if (settled) return
      settled = true
      child.kill()
      out.destroy()
      // A partial file is worse than none: it looks like a successful download
      // right up until whatever reads it chokes.
      fs.rm(localPath, { force: true }, () => reject(new Error(message)))
    }

    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      onProgress(bytes)
    })
    child.stdout.pipe(out)
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000)
    })
    child.on('error', (err) => fail(err.message))
    out.on('error', (err) => fail(err.message))

    child.on('close', (code) => {
      if (settled) return
      if (code) {
        fail(stderr.trim() || `ssh exited (code ${code})`)
        return
      }
      out.end(() => {
        settled = true
        activity.add('ssh', 'ok', `download ${path}`, { detail: `${bytes} bytes → ${localPath}` })
        resolve(bytes)
      })
    })
  })
}
