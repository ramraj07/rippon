import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import type { TabConfig } from '@shared/types'

interface Props {
  tab: TabConfig
  onSave(tab: TabConfig): void
  onClose(): void
  onDelete(): void
}

export default function TabSettings({ tab, onSave, onClose, onDelete }: Props): JSX.Element {
  const [title, setTitle] = useState(tab.title)
  const [host, setHost] = useState(tab.ssh.host)
  const [command, setCommand] = useState(tab.ssh.command ?? '')
  const [args, setArgs] = useState((tab.ssh.args ?? []).join(' '))
  const [url, setUrl] = useState(tab.browser.url)
  const [autoConnect, setAutoConnect] = useState(tab.ssh.autoConnect ?? false)
  const firstRef = useRef<HTMLInputElement>(null)

  useEffect(() => firstRef.current?.focus(), [])

  function submit(e: FormEvent): void {
    e.preventDefault()
    onSave({
      ...tab,
      title: title.trim() || host.trim() || 'Tab',
      ssh: {
        host: host.trim(),
        command: command.trim(),
        args: args.trim() ? args.trim().split(/\s+/) : [],
        autoConnect
      },
      browser: { url: url.trim() || 'about:blank' }
    })
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Tab settings</h2>

        <label>
          Title
          <input ref={firstRef} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>

        <label>
          SSH host
          <input
            value={host}
            placeholder="agent-box  or  user@10.0.0.5"
            spellCheck={false}
            onChange={(e) => setHost(e.target.value)}
          />
          <small>Any alias from your ~/.ssh/config works, including ProxyJump entries.</small>
        </label>

        <label>
          Remote command
          <input
            value={command}
            placeholder="tmux new -A -s agent"
            spellCheck={false}
            onChange={(e) => setCommand(e.target.value)}
          />
          <small>Leave blank for a plain login shell.</small>
        </label>

        <label>
          Extra ssh flags
          <input
            value={args}
            placeholder="-p 2222 -o ServerAliveInterval=30"
            spellCheck={false}
            onChange={(e) => setArgs(e.target.value)}
          />
        </label>

        <label>
          Browser URL
          <input value={url} spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
        </label>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={autoConnect}
            onChange={(e) => setAutoConnect(e.target.checked)}
          />
          Connect on launch (otherwise connects when the tab is first opened)
        </label>

        <div className="modal-actions">
          <button type="button" className="danger" onClick={onDelete}>
            Delete tab
          </button>
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
