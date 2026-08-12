import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import {
  MAX_COLUMNS,
  sessionNameError,
  VIEW_TYPE_LABELS,
  ZOOM_STEPS,
  type ViewType
} from '@shared/types'

interface NameDialogProps {
  title: string
  confirmLabel: string
  initial?: string
  taken: string[]
  /** What kind of name this is — defaults to a tmux session. */
  label?: string
  placeholder?: string
  validate?: (name: string) => string | null
  takenMessage?: string
  onSubmit(name: string): void
  onClose(): void
}

/** Used for new/rename of sessions and profiles — same name rules, different noun. */
export function NameDialog({
  title,
  confirmLabel,
  initial = '',
  taken,
  label = 'Session name',
  placeholder = 'auth-refactor',
  validate = sessionNameError,
  takenMessage = 'A session with that name already exists.',
  onSubmit,
  onClose
}: NameDialogProps): JSX.Element {
  const [name, setName] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const error =
    validate(name) ?? (name !== initial && taken.includes(name) ? takenMessage : null)

  function submit(e: FormEvent): void {
    e.preventDefault()
    if (error) return
    onSubmit(name.trim())
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal modal-narrow" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{title}</h2>
        <label>
          {label}
          <input
            ref={inputRef}
            value={name}
            placeholder={placeholder}
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && onClose()}
          />
          {name ? <small className={error ? 'error-text' : ''}>{error ?? ' '}</small> : null}
        </label>
        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!!error}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  )
}

interface TextDialogProps {
  title: string
  label: string
  confirmLabel: string
  initial?: string
  onSubmit(value: string): void
  onClose(): void
}

/** Plain single-field prompt, for names with no rules to enforce. */
export function TextDialog({
  title,
  label,
  confirmLabel,
  initial = '',
  onSubmit,
  onClose
}: TextDialogProps): JSX.Element {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal modal-narrow"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          if (value.trim()) onSubmit(value.trim())
        }}
      >
        <h2>{title}</h2>
        <label>
          {label}
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && onClose()}
          />
        </label>
        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!value.trim()}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  )
}

interface ViewDialogProps {
  title: string
  confirmLabel: string
  initialName?: string
  initialType?: ViewType
  initialZoom?: number
  onSubmit(name: string, type: ViewType, zoom: number): void
  onClose(): void
}

export function ViewDialog({
  title,
  confirmLabel,
  initialName = '',
  initialType = 'tabs-vertical',
  initialZoom = 1,
  onSubmit,
  onClose
}: ViewDialogProps): JSX.Element {
  const [name, setName] = useState(initialName)
  const [type, setType] = useState<ViewType>(initialType)
  const [zoom, setZoom] = useState(initialZoom)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  function submit(e: FormEvent): void {
    e.preventDefault()
    if (!name.trim()) return
    onSubmit(name.trim(), type, zoom)
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal modal-narrow" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{title}</h2>
        <label>
          Name
          <input
            ref={inputRef}
            value={name}
            placeholder="Review"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && onClose()}
          />
        </label>
        <label>
          Layout
          <div className="radio-row">
            {(Object.keys(VIEW_TYPE_LABELS) as ViewType[]).map((t) => (
              <button
                key={t}
                type="button"
                className={`radio-btn ${type === t ? 'radio-active' : ''}`}
                onClick={() => setType(t)}
              >
                {VIEW_TYPE_LABELS[t]}
              </button>
            ))}
          </div>
        </label>
        <label>
          Browser zoom
          <div className="radio-row">
            {ZOOM_STEPS.map((z) => (
              <button
                key={z}
                type="button"
                className={`radio-btn ${Math.abs(zoom - z) < 0.005 ? 'radio-active' : ''}`}
                onClick={() => setZoom(z)}
              >
                {Math.round(z * 100)}%
              </button>
            ))}
          </div>
          <small>
            Applies to every browser pane in this view. Chromium keeps zoom per site, so panes
            showing the same site cannot differ. ⌘+ / ⌘− / ⌘0 adjust the active view.
          </small>
        </label>

        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!name.trim()}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  )
}

interface ColumnsDialogProps {
  count: number
  suggestion: number
  onSubmit(columns: number): void
  onClose(): void
}

/** Asked before filling a tiled view with every session. */
export function ColumnsDialog({
  count,
  suggestion,
  onSubmit,
  onClose
}: ColumnsDialogProps): JSX.Element {
  const [columns, setColumns] = useState(suggestion)
  const rows = Math.ceil(count / Math.max(columns, 1))

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal modal-narrow"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit(columns)
        }}
      >
        <h2>Tile all sessions</h2>
        <p className="modal-note">
          {count} session{count === 1 ? '' : 's'} in a {columns}×{rows} grid.
        </p>
        <label>
          Columns
          <div className="radio-row">
            {Array.from({ length: MAX_COLUMNS }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                className={`radio-btn ${columns === n ? 'radio-active' : ''}`}
                onClick={() => setColumns(n)}
              >
                {n}
                {n === suggestion ? ' ·' : ''}
              </button>
            ))}
          </div>
          <small>· marks the suggestion for this many sessions.</small>
        </label>
        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Fill grid
          </button>
        </div>
      </form>
    </div>
  )
}

export interface MenuItem {
  label: string
  onClick(): void
  checked?: boolean
  danger?: boolean
  disabled?: boolean
  separator?: boolean
}

interface ContextMenuProps {
  x: number
  y: number
  items: MenuItem[]
  onClose(): void
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): JSX.Element {
  return (
    <>
      <div
        className="menu-scrim"
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div className="ctx-menu" style={{ left: x, top: y }}>
        {items.map((item, i) => (
          <div key={`${item.label}-${i}`}>
            {item.separator ? <div className="ctx-sep" /> : null}
            <button
              className={item.danger ? 'ctx-danger' : ''}
              disabled={item.disabled}
              onClick={() => {
                onClose()
                item.onClick()
              }}
            >
              <span className="ctx-check">{item.checked ? '✓' : ''}</span>
              {item.label}
            </button>
          </div>
        ))}
      </div>
    </>
  )
}

interface CloseDialogProps {
  name: string
  tiled: boolean
  onHide(): void
  onKill(): void
  onClose(): void
}

export function CloseSessionDialog({
  name,
  tiled,
  onHide,
  onKill,
  onClose
}: CloseDialogProps): JSX.Element {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal modal-narrow" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Close “{name}”</h2>
        <p className="modal-note">
          Removing it from this view leaves the tmux session and everything running in it untouched,
          and other views still show it.{' '}
          {tiled ? 'The tile goes empty.' : 'It comes back from the “+” menu.'} Killing it discards
          the session and its contents for good, in every view.
        </p>
        <div className="modal-actions">
          <button type="button" className="danger" onClick={onKill}>
            Kill session
          </button>
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={onHide}>
            {tiled ? 'Clear tile' : 'Remove from view'}
          </button>
        </div>
      </div>
    </div>
  )
}

interface ErrorDialogProps {
  title: string
  detail: string
  onClose(): void
}

/**
 * Failures from something the user just clicked. Those get a dialog rather than
 * the error bar: the bar is a single clipped line shared with background poll
 * errors, so an ssh or tmux message — which is the whole diagnosis, and is
 * usually several lines — was unreadable exactly when it mattered most.
 */
export function ErrorDialog({ title, detail, onClose }: ErrorDialogProps): JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => closeRef.current?.focus(), [])

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <h2>{title}</h2>
        <pre className="error-detail">{detail}</pre>
        <div className="modal-actions">
          <button type="button" onClick={() => void window.rippon.clipboard.write(detail)}>
            Copy
          </button>
          <span className="spacer" />
          <button type="button" ref={closeRef} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
