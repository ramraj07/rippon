import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import type { ActivityEntry } from '@shared/types'

/**
 * Everything the app has asked ssh to do this run.
 *
 * Kept in the renderer as a mirror of the main-process log: the backlog arrives
 * once on mount and entries stream in after it, upserted by `seq` because a
 * repeated line comes back as the same entry with a higher count rather than as
 * a new row.
 */

function clock(at: number): string {
  const d = new Date(at)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}.${Math.floor(d.getMilliseconds() / 100)}`
}

function duration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function asText(entries: ActivityEntry[]): string {
  return entries
    .map((e) => {
      const bits = [clock(e.at), e.source.padEnd(7), e.level.padEnd(5), e.text]
      if (e.ms !== undefined) bits.push(`(${duration(e.ms)})`)
      if (e.count && e.count > 1) bits.push(`×${e.count}`)
      const head = bits.join(' ')
      return e.detail ? `${head}\n${e.detail.replace(/^/gm, '    ')}` : head
    })
    .join('\n')
}

export default function ActivityLog(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const [problemsOnly, setProblemsOnly] = useState(false)
  const [verbose, setVerbose] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)
  const pinned = useRef(true)

  // This panel lives inside the settings dialog, so it mounts and unmounts with
  // it. The backlog is fetched on mount for exactly that reason: the log worth
  // reading is the one from before the dialog was opened.
  useEffect(() => {
    void window.rippon.activity.get().then(setEntries)
    void window.rippon.tunnel.verbose().then(setVerbose)
    const offEntry = window.rippon.activity.onEntry((entry) => {
      setEntries((prev) => {
        const i = prev.findIndex((e) => e.seq === entry.seq)
        if (i === -1) return [...prev, entry].slice(-1000)
        const next = [...prev]
        next[i] = entry
        return next
      })
    })
    const offCleared = window.rippon.activity.onCleared(() => setEntries([]))
    return () => {
      offEntry()
      offCleared()
    }
  }, [])

  const shown = problemsOnly
    ? entries.filter((e) => e.level === 'warn' || e.level === 'error')
    : entries
  const problems = entries.filter((e) => e.level === 'warn' || e.level === 'error').length

  // Follow the tail only while the reader is already at it — scrolling up to read
  // something must not be undone by the next poll landing.
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el || !open || !pinned.current) return
    el.scrollTop = el.scrollHeight
  }, [shown.length, open])

  function onScroll(): void {
    const el = listRef.current
    if (!el) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(asText(shown))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  async function toggleVerbose(next: boolean): Promise<void> {
    setVerbose(next)
    await window.rippon.tunnel.setVerbose(next)
  }

  return (
    <div className="activity">
      <div className="activity-head">
        <button type="button" className="activity-toggle" onClick={() => setOpen(!open)}>
          <span className="activity-caret">{open ? '▾' : '▸'}</span> SSH activity
        </button>
        <span className="activity-count">
          {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
          {problems ? <span className="activity-problems"> · {problems} problem{problems === 1 ? '' : 's'}</span> : null}
        </span>
        {open ? (
          <div className="activity-actions">
            <label className="activity-check" title="Restart the forwarder with ssh -v">
              <input
                type="checkbox"
                checked={verbose}
                onChange={(e) => void toggleVerbose(e.target.checked)}
              />
              verbose
            </label>
            <label className="activity-check">
              <input
                type="checkbox"
                checked={problemsOnly}
                onChange={(e) => setProblemsOnly(e.target.checked)}
              />
              problems only
            </label>
            <button type="button" onClick={() => void copy()}>
              {copied ? 'copied' : 'copy'}
            </button>
            <button type="button" onClick={() => void window.rippon.activity.clear()}>
              clear
            </button>
          </div>
        ) : null}
      </div>

      {open ? (
        <div className="activity-list" ref={listRef} onScroll={onScroll}>
          {shown.length === 0 ? (
            <div className="activity-empty">
              {problemsOnly ? 'No problems logged.' : 'Nothing logged yet.'}
            </div>
          ) : (
            shown.map((e) => (
              <div
                key={e.seq}
                className={`activity-row activity-${e.level}${e.detail ? ' activity-has-detail' : ''}`}
                onClick={() => e.detail && setExpanded(expanded === e.seq ? null : e.seq)}
              >
                <span className="activity-time">{clock(e.at)}</span>
                <span className={`activity-source activity-source-${e.source}`}>{e.source}</span>
                <span className="activity-text">
                  {e.text}
                  {e.count && e.count > 1 ? <span className="activity-repeat">×{e.count}</span> : null}
                </span>
                <span className="activity-ms">{e.ms === undefined ? '' : duration(e.ms)}</span>
                {e.detail && expanded === e.seq ? (
                  <pre className="activity-detail">{e.detail}</pre>
                ) : null}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}
