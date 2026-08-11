import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import type { FindMatches } from '@shared/types'

export interface FindHandle {
  /** Focus and select the field, first replacing the query if a seed is given. */
  focus(seed?: string): void
}

interface Props {
  matches: FindMatches
  /** Fired on every keystroke: both panes search incrementally. */
  onQuery(query: string): void
  onStep(delta: 1 | -1): void
  onClose(): void
}

/**
 * Shared by both panes, and deliberately laid out in normal flow rather than
 * over the content: a browser pane's native view paints above the page, so a
 * bar floating over it would be invisible. In flow, the pane simply gets
 * shorter and the view follows.
 */
const FindBar = forwardRef<FindHandle, Props>(function FindBar(
  { matches, onQuery, onStep, onClose },
  ref
) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')

  // Read through a ref so seeding from focus() never fires a stale callback.
  const onQueryRef = useRef(onQuery)
  onQueryRef.current = onQuery

  useImperativeHandle(ref, () => ({
    focus: (seed) => {
      if (seed) {
        setQuery(seed)
        onQueryRef.current(seed)
      }
      // After the seed has rendered, or select() would take the old value.
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }))

  /*
   * The terminal stops tracking which match is current once there are too many
   * of them, reporting a count with no active index. Show what is known rather
   * than a misleading "0/900".
   */
  const status = !query
    ? ''
    : !matches.total
      ? 'no matches'
      : matches.active
        ? `${matches.active}/${matches.total}`
        : `${matches.total} matches`

  return (
    <div className="find-bar">
      <input
        ref={inputRef}
        className="find-input"
        value={query}
        spellCheck={false}
        placeholder="Find"
        onChange={(e) => {
          setQuery(e.target.value)
          onQuery(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onStep(e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
      <span className={`find-count ${query && !matches.total ? 'find-count-none' : ''}`}>
        {status}
      </span>
      <button
        className="icon-btn"
        title="Previous match (⇧⌘G)"
        disabled={!matches.total}
        onClick={() => onStep(-1)}
      >
        ‹
      </button>
      <button
        className="icon-btn"
        title="Next match (⌘G)"
        disabled={!matches.total}
        onClick={() => onStep(1)}
      >
        ›
      </button>
      <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
        ×
      </button>
    </div>
  )
})

export default FindBar
