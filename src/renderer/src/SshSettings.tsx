import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import ActivityLog from './ActivityLog'
import { isPort, tunnelError, type SshConfig, type Tunnel, type TunnelStatus } from '@shared/types'

interface Props {
  ssh: SshConfig
  detachHidden: boolean
  configPath: string
  tunnelStatus: TunnelStatus | null
  /**
   * Whether the host's profile is in hand. Everything on this form is local
   * except "detach background sessions", which is a profile field — so while it
   * is false that one option is not ours to offer, let alone save.
   */
  profileLoaded: boolean
  onSave(ssh: SshConfig, detachHidden: boolean): void
  onClose(): void
  onChoosePath(): void
}

/** Rows are edited as strings so a half-typed port does not fight the input. */
interface TunnelRow {
  localPort: string
  remoteHost: string
  remotePort: string
}

function toRow(t: Tunnel): TunnelRow {
  return { localPort: String(t.localPort), remoteHost: t.remoteHost, remotePort: String(t.remotePort) }
}

function rowError(row: TunnelRow): string | null {
  // A blank row is "not filled in yet", not an error — it is just dropped.
  if (!row.localPort && !row.remotePort && !row.remoteHost) return null
  return tunnelError({
    localPort: Number(row.localPort),
    remoteHost: row.remoteHost.trim(),
    remotePort: Number(row.remotePort)
  })
}

/** Keep only complete, valid rows, and one listener per local port. */
function collectTunnels(rows: TunnelRow[]): Tunnel[] {
  const out: Tunnel[] = []
  const seen = new Set<number>()
  for (const row of rows) {
    const localPort = Number(row.localPort)
    const remotePort = Number(row.remotePort)
    const remoteHost = row.remoteHost.trim() || 'localhost'
    if (!isPort(localPort) || !isPort(remotePort)) continue
    if (rowError(row) || seen.has(localPort)) continue
    seen.add(localPort)
    out.push({ localPort, remoteHost, remotePort })
  }
  return out
}

export default function SshSettings({
  ssh,
  detachHidden,
  configPath,
  tunnelStatus,
  profileLoaded,
  onSave,
  onClose,
  onChoosePath
}: Props): JSX.Element {
  const [host, setHost] = useState(ssh.host)
  const [args, setArgs] = useState(ssh.args.join(' '))
  const [newSessionCommand, setNewSessionCommand] = useState(ssh.newSessionCommand ?? '')
  const [detach, setDetach] = useState(detachHidden)
  const [rows, setRows] = useState<TunnelRow[]>(ssh.tunnels.map(toRow))
  const firstRef = useRef<HTMLInputElement>(null)

  useEffect(() => firstRef.current?.focus(), [])

  const dupLocalPorts = new Set(
    rows
      .map((r) => Number(r.localPort))
      .filter((p, i, all) => isPort(p) && all.indexOf(p) !== i)
  )

  function setRow(index: number, patch: Partial<TunnelRow>): void {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  function addRow(): void {
    setRows((prev) => [...prev, { localPort: '', remoteHost: 'localhost', remotePort: '' }])
  }

  function removeRow(index: number): void {
    setRows((prev) => prev.filter((_, i) => i !== index))
  }

  function submit(e: FormEvent): void {
    e.preventDefault()
    // Block only on rows that are filled in but wrong; blank rows are dropped.
    if (rows.some((r) => rowError(r)) || dupLocalPorts.size) return
    onSave(
      {
        host: host.trim(),
        args: args.trim() ? args.trim().split(/\s+/) : [],
        newSessionCommand: newSessionCommand.trim() || undefined,
        tunnels: collectTunnels(rows)
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

        <div className="tunnels">
          <div className="tunnels-head">
            <span>Port forwards</span>
            <TunnelBadge status={tunnelStatus} count={collectTunnels(rows).length} />
          </div>
          <small className="tunnels-note">
            Reach a port on {host.trim() || 'the remote host'} at <code>localhost</code> here. A dev
            server on the box at <code>:3000</code> → open <code>localhost:8080</code> in a browser
            pane. This is <code>ssh -L local:host:remote</code>.
          </small>

          {rows.length ? (
            <div className="tunnel-rows">
              <div className="tunnel-row tunnel-row-labels">
                <span>Local port</span>
                <span>Remote host</span>
                <span>Remote port</span>
                <span />
              </div>
              {rows.map((row, i) => {
                const err = rowError(row)
                const dup = isPort(Number(row.localPort)) && dupLocalPorts.has(Number(row.localPort))
                return (
                  <div key={i} className="tunnel-row">
                    <input
                      className={err || dup ? 'input-error' : ''}
                      value={row.localPort}
                      inputMode="numeric"
                      placeholder="8080"
                      spellCheck={false}
                      onChange={(e) => setRow(i, { localPort: e.target.value.replace(/[^\d]/g, '') })}
                    />
                    <input
                      className={err ? 'input-error' : ''}
                      value={row.remoteHost}
                      placeholder="localhost"
                      spellCheck={false}
                      onChange={(e) => setRow(i, { remoteHost: e.target.value })}
                    />
                    <input
                      className={err ? 'input-error' : ''}
                      value={row.remotePort}
                      inputMode="numeric"
                      placeholder="3000"
                      spellCheck={false}
                      onChange={(e) => setRow(i, { remotePort: e.target.value.replace(/[^\d]/g, '') })}
                    />
                    <button
                      type="button"
                      className="tunnel-remove"
                      title="Remove this forward"
                      onClick={() => removeRow(i)}
                    >
                      ×
                    </button>
                    {err || dup ? (
                      <span className="tunnel-error error-text">
                        {err ?? 'Another forward already uses this local port.'}
                      </span>
                    ) : null}
                  </div>
                )
              })}
            </div>
          ) : null}

          <button type="button" className="tunnel-add" onClick={addRow}>
            + Add forward
          </button>

          {tunnelStatus?.error ? (
            <small className="tunnel-status-error error-text">ssh: {tunnelStatus.error}</small>
          ) : tunnelStatus?.running && tunnelStatus.forwards.length ? (
            <small className="tunnel-status-ok">Active: {tunnelStatus.forwards.join(', ')}</small>
          ) : null}

          <ActivityLog />
        </div>

        {profileLoaded ? (
          <>
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
          </>
        ) : (
          <small className="checkbox-note">
            Session and layout options live in the profile on {host.trim() || 'the host'}, and appear
            once it is connected.
          </small>
        )}

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

function TunnelBadge({
  status,
  count
}: {
  status: TunnelStatus | null
  count: number
}): JSX.Element | null {
  if (count === 0) return null
  const state = status?.error ? 'error' : status?.running ? 'ok' : 'idle'
  const text = state === 'error' ? 'error' : state === 'ok' ? 'connected' : 'saved'
  return <span className={`tunnel-badge tunnel-badge-${state}`}>{text}</span>
}
