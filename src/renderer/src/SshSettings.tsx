import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import type { SshConfig } from '@shared/types'

interface Props {
  ssh: SshConfig
  detachHidden: boolean
  configPath: string
  onSave(ssh: SshConfig, detachHidden: boolean): void
  onClose(): void
  onChoosePath(): void
}

export default function SshSettings({
  ssh,
  detachHidden,
  configPath,
  onSave,
  onClose,
  onChoosePath
}: Props): JSX.Element {
  const [host, setHost] = useState(ssh.host)
  const [args, setArgs] = useState(ssh.args.join(' '))
  const [newSessionCommand, setNewSessionCommand] = useState(ssh.newSessionCommand ?? '')
  const [detach, setDetach] = useState(detachHidden)
  const firstRef = useRef<HTMLInputElement>(null)

  useEffect(() => firstRef.current?.focus(), [])

  function submit(e: FormEvent): void {
    e.preventDefault()
    onSave(
      {
        host: host.trim(),
        args: args.trim() ? args.trim().split(/\s+/) : [],
        newSessionCommand: newSessionCommand.trim() || undefined
      },
      detach
    )
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Settings</h2>
        <p className="modal-note">
          One host for the whole app. Tabs mirror the tmux sessions running on it.
        </p>

        <label>
          Host
          <input
            ref={firstRef}
            value={host}
            placeholder="agent-box  or  ubuntu@10.0.0.5"
            spellCheck={false}
            onChange={(e) => setHost(e.target.value)}
          />
          <small>Any alias from your ~/.ssh/config works, including ProxyJump entries.</small>
        </label>

        <label>
          Extra ssh flags
          <input
            value={args}
            placeholder="-i /Users/you/key.pem -o ServerAliveInterval=30"
            spellCheck={false}
            onChange={(e) => setArgs(e.target.value)}
          />
          <small>Split on spaces, so paths must not contain any. Use absolute paths.</small>
        </label>

        <label>
          Command for new sessions
          <input
            value={newSessionCommand}
            placeholder="(optional) e.g. claude"
            spellCheck={false}
            onChange={(e) => setNewSessionCommand(e.target.value)}
          />
          <small>Runs inside each session you create from here. Blank = plain shell.</small>
        </label>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={detach}
            onChange={(e) => setDetach(e.target.checked)}
          />
          Detach background sessions
        </label>
        <small className="checkbox-note">
          Frees one ssh channel and the local scrollback per hidden tab, at the cost of a redraw
          when you switch back. tmux keeps the session and its own scrollback either way.
        </small>

        <label>
          Config file
          <button type="button" className="path-btn" onClick={onChoosePath}>
            {configPath.replace(/^\/Users\/[^/]+/, '~')}
          </button>
          <small>Point this at a synced folder to carry your layout across machines.</small>
        </label>

        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Save
          </button>
        </div>
      </form>
    </div>
  )
}
