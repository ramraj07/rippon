import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import { sessionNameError } from '@shared/types'

interface NameDialogProps {
  title: string
  confirmLabel: string
  initial?: string
  taken: string[]
  onSubmit(name: string): void
  onClose(): void
}

/** Used for both "new session" and "rename session". */
export function NameDialog({
  title,
  confirmLabel,
  initial = '',
  taken,
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
    sessionNameError(name) ??
    (name !== initial && taken.includes(name) ? 'A session with that name already exists.' : null)

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
          Session name
          <input
            ref={inputRef}
            value={name}
            placeholder="auth-refactor"
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

interface CloseDialogProps {
  name: string
  onHide(): void
  onKill(): void
  onClose(): void
}

export function CloseSessionDialog({ name, onHide, onKill, onClose }: CloseDialogProps): JSX.Element {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal modal-narrow" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Close “{name}”</h2>
        <p className="modal-note">
          Keeping it alive leaves the tmux session and everything running in it untouched — the tab
          reappears from the “+” menu. Killing it discards the session and its contents for good.
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
            Close tab only
          </button>
        </div>
      </div>
    </div>
  )
}
