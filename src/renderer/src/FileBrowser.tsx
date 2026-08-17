import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { RemoteEntry, RemoteListing, RemotePreview } from '@shared/types'

/**
 * Browsing the host's filesystem.
 *
 * A dialog rather than a tab, because a tab in this app *is* a tmux session —
 * the session poll is what decides which tabs exist, so anything not backed by a
 * session has nowhere to live. As a dialog it needs no profile schema, no view
 * changes, and nothing in the tab machinery has to learn a second kind of thing.
 *
 * Read-only on purpose. It lists, previews and downloads; it does not rename,
 * delete or upload. Everything destructive is one keystroke away in the terminal
 * next door, where it is deliberate and leaves a shell history.
 */

interface Props {
  host: string
  onClose(): void
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = bytes / 1024
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`
}

function humanDate(epochSeconds: number): string {
  if (!epochSeconds) return ''
  const d = new Date(epochSeconds * 1000)
  const now = Date.now()
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  const month = d.toLocaleString(undefined, { month: 'short' })
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return sameYear ? `${month} ${d.getDate()} ${time}` : `${month} ${d.getDate()} ${d.getFullYear()}`
}

/** The parent of an absolute path, or the path itself when already at the root. */
function parentOf(path: string): string {
  const cut = path.lastIndexOf('/')
  if (cut <= 0) return '/'
  return path.slice(0, cut)
}

function join(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}

export default function FileBrowser({ host, onClose }: Props): JSX.Element {
  const [listing, setListing] = useState<RemoteListing | null>(null)
  const [typed, setTyped] = useState('~')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<RemoteEntry | null>(null)
  const [preview, setPreview] = useState<RemotePreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [saved, setSaved] = useState<{ path: string; bytes: number } | null>(null)
  const pathInput = useRef<HTMLInputElement | null>(null)

  const go = useCallback(async (path: string) => {
    setLoading(true)
    setError(null)
    setSelected(null)
    setPreview(null)
    setPreviewError(null)
    const result = await window.rippon.files.list(path)
    setLoading(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setListing(result.value)
    setTyped(result.value.path)
  }, [])

  useEffect(() => {
    void go('~')
  }, [go])

  useEffect(() => window.rippon.files.onProgress((_p, done, total) => setProgress({ done, total })), [])

  // Esc closes, and only when nothing inside has claimed it — the path box is the
  // one place where Esc means "put back what was there", not "close the dialog".
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (document.activeElement === pathInput.current && listing) {
        setTyped(listing.path)
        pathInput.current?.blur()
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, listing])

  async function open(entry: RemoteEntry): Promise<void> {
    if (!listing) return
    const full = join(listing.path, entry.name)
    if (entry.isDir) {
      await go(full)
      return
    }
    setSelected(entry)
    setPreview(null)
    setPreviewError(null)
    setSaved(null)
    setPreviewing(true)
    const result = await window.rippon.files.preview(full)
    setPreviewing(false)
    if (!result.ok) setPreviewError(result.error)
    else setPreview(result.value)
  }

  async function download(): Promise<void> {
    if (!listing || !selected) return
    setSaved(null)
    setProgress({ done: 0, total: selected.size })
    const result = await window.rippon.files.download(join(listing.path, selected.name), selected.size)
    setProgress(null)
    if (!result.ok) {
      setPreviewError(result.error)
      return
    }
    if (result.value.saved && result.value.path) {
      setSaved({ path: result.value.path, bytes: result.value.bytes ?? 0 })
    }
  }

  const atRoot = listing?.path === '/'

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal files-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="files-head">
          <h2>Files on {host || 'the host'}</h2>
          <button type="button" className="files-close" onClick={onClose} title="Close (Esc)">
            ×
          </button>
        </div>

        <div className="files-path">
          <button
            type="button"
            className="files-up"
            disabled={!listing || atRoot}
            title="Up one directory"
            onClick={() => listing && void go(parentOf(listing.path))}
          >
            ↑
          </button>
          <input
            ref={pathInput}
            value={typed}
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void go(typed)
            }}
          />
          <button type="button" onClick={() => void go(typed)}>
            Go
          </button>
        </div>

        {error ? <div className="files-error error-text">{error}</div> : null}

        <div className="files-body">
          <div className="files-list">
            {loading ? (
              <div className="files-empty">Listing…</div>
            ) : !listing || listing.entries.length === 0 ? (
              <div className="files-empty">{error ? '' : 'Empty directory.'}</div>
            ) : (
              listing.entries.map((e) => (
                <button
                  type="button"
                  key={e.name}
                  className={`files-row${selected?.name === e.name ? ' files-row-selected' : ''}`}
                  onClick={() => void open(e)}
                >
                  <span className={`files-icon files-icon-${e.isDir ? 'dir' : e.type}`}>
                    {e.isDir ? '▸' : e.type === 'link' ? '↗' : '·'}
                  </span>
                  <span className="files-name">{e.name}</span>
                  <span className="files-size">{e.isDir ? '' : humanSize(e.size)}</span>
                  <span className="files-date">{humanDate(e.mtime)}</span>
                </button>
              ))
            )}
            {listing?.truncated ? (
              <div className="files-empty">
                Only the first 5000 entries are shown — narrow the path to see the rest.
              </div>
            ) : null}
          </div>

          <div className="files-preview">
            {!selected ? (
              <div className="files-empty">Select a file to preview it.</div>
            ) : (
              <>
                <div className="files-preview-head">
                  <span className="files-preview-name" title={selected.name}>
                    {selected.name}
                  </span>
                  <span className="files-preview-size">{humanSize(selected.size)}</span>
                  <button
                    type="button"
                    disabled={progress !== null}
                    onClick={() => void download()}
                  >
                    {progress ? 'Downloading…' : 'Download'}
                  </button>
                </div>

                {progress ? (
                  <div className="files-progress">
                    <div
                      className="files-progress-bar"
                      style={{
                        width: progress.total
                          ? `${Math.min(100, (progress.done / progress.total) * 100)}%`
                          : '100%'
                      }}
                    />
                    <span>
                      {humanSize(progress.done)}
                      {progress.total ? ` / ${humanSize(progress.total)}` : ''}
                    </span>
                  </div>
                ) : null}

                {saved ? (
                  <div className="files-saved">
                    Saved {humanSize(saved.bytes)} to <code>{saved.path}</code>{' '}
                    <button type="button" onClick={() => void window.rippon.files.reveal(saved.path)}>
                      Reveal
                    </button>
                  </div>
                ) : null}

                {previewError ? <div className="files-error error-text">{previewError}</div> : null}

                {previewing ? (
                  <div className="files-empty">Reading…</div>
                ) : preview?.kind === 'image' ? (
                  <div className="files-image">
                    <img src={preview.content} alt={selected.name} />
                  </div>
                ) : preview?.kind === 'binary' ? (
                  <div className="files-empty">
                    Binary file — nothing readable to show. Download it to open it locally.
                  </div>
                ) : preview?.kind === 'text' ? (
                  <>
                    {preview.truncated ? (
                      <div className="files-truncated">
                        Showing the first 256 KB of {humanSize(preview.size)}.
                      </div>
                    ) : null}
                    <pre className="files-text">{preview.content}</pre>
                  </>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
