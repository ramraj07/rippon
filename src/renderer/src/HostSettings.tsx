import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import ActivityLog from './ActivityLog'
import {
  DEFAULT_PROFILE,
  hostLabel,
  isPort,
  tunnelError,
  type HostEntry,
  type HostKind,
  type Tunnel,
  type TunnelStatus
} from '@shared/types'

interface Props {
  hosts: HostEntry[]
  activeHostId: string
  detachHidden: boolean
  configPath: string
  tunnelStatus: TunnelStatus | null
  /**
   * Whether the host's profile is in hand. Everything on this form is local
   * except "detach background sessions", which is a profile field — so while it
   * is false that one option is not ours to offer, let alone save.
   */
  profileLoaded: boolean
  onSave(hosts: HostEntry[], activeHostId: string, detachHidden: boolean): void
  onClose(): void
  onChoosePath(): void
}

/** Rows are edited as strings so a half-typed port does not fight the input. */
interface TunnelRow {
  localPort: string
  remoteHost: string
  remotePort: string
}

/**
 * One host mid-edit. Ports and flags live here as the text the user is typing,
 * and are only coerced into a HostEntry on save — an input that rewrites itself
 * between keystrokes is unusable.
 */
interface Draft {
  id: string
  name: string
  kind: HostKind
  host: string
  args: string
  newSessionCommand: string
  tunnels: TunnelRow[]
  /** Carried through untouched: the profile menu owns this, not this dialog. */
  activeProfile: string
}

function toRow(t: Tunnel): TunnelRow {
  return {
    localPort: String(t.localPort),
    remoteHost: t.remoteHost,
    remotePort: String(t.remotePort)
  }
}

function toDraft(h: HostEntry): Draft {
  return {
    id: h.id,
    name: h.name,
    kind: h.kind,
    host: h.host,
    args: h.args.join(' '),
    newSessionCommand: h.newSessionCommand ?? '',
    tunnels: h.tunnels.map(toRow),
    activeProfile: h.activeProfile
  }
}

function fromDraft(d: Draft): HostEntry {
  const local = d.kind === 'local'
  return {
    id: d.id,
    name: d.name.trim(),
    kind: d.kind,
    // A local host has no ssh to configure, so nothing that only makes sense
    // over one is carried: a destination, flags, or forwards to this machine.
    host: local ? '' : d.host.trim(),
    args: local || !d.args.trim() ? [] : d.args.trim().split(/\s+/),
    newSessionCommand: d.newSessionCommand.trim() || undefined,
    tunnels: local ? [] : collectTunnels(d.tunnels),
    activeProfile: d.activeProfile
  }
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

function makeHostId(): string {
  return `host-${Math.random().toString(36).slice(2, 9)}`
}

/** What the list calls a draft, including one with no name and no target yet. */
function draftLabel(d: Draft): string {
  return hostLabel({ ...d, args: [], tunnels: [] })
}

/**
 * Hosts, and the settings that belong to whichever one is selected.
 *
 * Selecting a host here *is* switching to it — there is no separate "make
 * active" control, because a dialog that let you edit one host while pointed at
 * another would need to explain which one Save applied to. The selection is
 * handed back as `activeHostId`, and the caller decides whether that means a
 * reconnect.
 */
export default function HostSettings({
  hosts,
  activeHostId,
  detachHidden,
  configPath,
  tunnelStatus,
  profileLoaded,
  onSave,
  onClose,
  onChoosePath
}: Props): JSX.Element {
  const [drafts, setDrafts] = useState<Draft[]>(() => hosts.map(toDraft))
  const [selectedId, setSelectedId] = useState(activeHostId)
  const [detach, setDetach] = useState(detachHidden)
  const firstRef = useRef<HTMLInputElement>(null)

  useEffect(() => firstRef.current?.focus(), [])

  const selected = drafts.find((d) => d.id === selectedId) ?? drafts[0]
  const local = selected.kind === 'local'

  const dupLocalPorts = new Set(
    selected.tunnels
      .map((r) => Number(r.localPort))
      .filter((p, i, all) => isPort(p) && all.indexOf(p) !== i)
  )
  // Only the selected host is on screen, so this is the only one whose blank
  // destination the user can currently see and fix.
  const hostMissing = !local && !selected.host.trim()

  function patch(update: Partial<Draft>): void {
    setDrafts((prev) => prev.map((d) => (d.id === selected.id ? { ...d, ...update } : d)))
  }

  function setRow(index: number, update: Partial<TunnelRow>): void {
    patch({
      tunnels: selected.tunnels.map((r, i) => (i === index ? { ...r, ...update } : r))
    })
  }

  function addRow(): void {
    patch({ tunnels: [...selected.tunnels, { localPort: '', remoteHost: 'localhost', remotePort: '' }] })
  }

  function removeRow(index: number): void {
    patch({ tunnels: selected.tunnels.filter((_, i) => i !== index) })
  }

  function addHost(kind: HostKind): void {
    const id = makeHostId()
    setDrafts((prev) => [
      ...prev,
      {
        id,
        name: '',
        kind,
        host: '',
        args: '',
        newSessionCommand: '',
        tunnels: [],
        activeProfile: DEFAULT_PROFILE
      }
    ])
    setSelectedId(id)
    // The name field is the first thing on the form for a host that has none.
    window.requestAnimationFrame(() => firstRef.current?.focus())
  }

  function removeHost(id: string): void {
    // There is always a host: an empty list leaves the app with nothing to point
    // at and this dialog with nothing to edit.
    if (drafts.length < 2) return
    const next = drafts.filter((d) => d.id !== id)
    setDrafts(next)
    if (selectedId === id) setSelectedId(next[0].id)
  }

  function submit(e: FormEvent): void {
    e.preventDefault()
    // Block only on rows that are filled in but wrong; blank rows are dropped.
    if (hostMissing || dupLocalPorts.size) return
    if (selected.tunnels.some((r) => rowError(r))) return
    onSave(drafts.map(fromDraft), selected.id, detach)
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal modal-wide" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Settings</h2>
        <p className="modal-note">
          One host at a time. Tabs mirror the tmux sessions running on it, and your views and
          bookmarks are stored there too — so each host keeps its own.
        </p>

        <div className="host-list">
          {drafts.map((d) => (
            <div
              key={d.id}
              className={`host-row ${d.id === selected.id ? 'host-row-active' : ''}`}
            >
              <button type="button" className="host-pick" onClick={() => setSelectedId(d.id)}>
                <span className="host-pick-kind">{d.kind === 'local' ? '⌂' : '⇢'}</span>
                <span className="host-pick-name">{draftLabel(d)}</span>
                {d.id === activeHostId ? <span className="host-pick-current">current</span> : null}
              </button>
              {drafts.length > 1 ? (
                <button
                  type="button"
                  className="host-remove"
                  title={`Remove ${draftLabel(d)}`}
                  onClick={() => removeHost(d.id)}
                >
                  ×
                </button>
              ) : null}
            </div>
          ))}
          <div className="host-add">
            <button type="button" onClick={() => addHost('ssh')}>
              + SSH host
            </button>
            <button type="button" onClick={() => addHost('local')}>
              + This Mac
            </button>
          </div>
        </div>

        <label>
          Name
          <input
            ref={firstRef}
            value={selected.name}
            placeholder={local ? 'Local' : selected.host.trim() || 'agent-box'}
            spellCheck={false}
            onChange={(e) => patch({ name: e.target.value })}
          />
          <small>What the switcher shows. Blank falls back to the SSH destination.</small>
        </label>

        {local ? (
          <p className="modal-note host-local-note">
            Sessions run on this Mac, with no SSH in the way — tabs are your own
            <code> tmux list-sessions</code>, and profiles are files under <code>~/.rippon</code>.
            tmux is found through your login shell, so whatever <code>$PATH</code> your terminal
            has, this has.
          </p>
        ) : (
          <>
            <label>
              Host
              <input
                className={hostMissing ? 'input-error' : ''}
                value={selected.host}
                placeholder="agent-box  or  ubuntu@10.0.0.5"
                spellCheck={false}
                onChange={(e) => patch({ host: e.target.value })}
              />
              {hostMissing ? (
                <small className="error-text">An SSH host needs somewhere to connect to.</small>
              ) : (
                <small>
                  Any alias from your ~/.ssh/config works, including ProxyJump entries.
                </small>
              )}
            </label>

            <label>
              Extra ssh flags
              <input
                value={selected.args}
                placeholder="-i /Users/you/key.pem -o ServerAliveInterval=30"
                spellCheck={false}
                onChange={(e) => patch({ args: e.target.value })}
              />
              <small>Split on spaces, so paths must not contain any. Use absolute paths.</small>
            </label>
          </>
        )}

        <label>
          Command for new sessions
          <input
            value={selected.newSessionCommand}
            placeholder="(optional) e.g. claude"
            spellCheck={false}
            onChange={(e) => patch({ newSessionCommand: e.target.value })}
          />
          <small>Runs inside each session you create from here. Blank = plain shell.</small>
        </label>

        {local ? null : (
          <div className="tunnels">
            <div className="tunnels-head">
              <span>Port forwards</span>
              <TunnelBadge
                status={selected.id === activeHostId ? tunnelStatus : null}
                count={collectTunnels(selected.tunnels).length}
              />
            </div>
            <small className="tunnels-note">
              Reach a port on {selected.host.trim() || 'the remote host'} at <code>localhost</code>{' '}
              here. A dev server on the box at <code>:3000</code> → open <code>localhost:8080</code>{' '}
              in a browser pane. This is <code>ssh -L local:host:remote</code>.
            </small>

            {selected.tunnels.length ? (
              <div className="tunnel-rows">
                <div className="tunnel-row tunnel-row-labels">
                  <span>Local port</span>
                  <span>Remote host</span>
                  <span>Remote port</span>
                  <span />
                </div>
                {selected.tunnels.map((row, i) => {
                  const err = rowError(row)
                  const dup =
                    isPort(Number(row.localPort)) && dupLocalPorts.has(Number(row.localPort))
                  return (
                    <div key={i} className="tunnel-row">
                      <input
                        className={err || dup ? 'input-error' : ''}
                        value={row.localPort}
                        inputMode="numeric"
                        placeholder="8080"
                        spellCheck={false}
                        onChange={(e) =>
                          setRow(i, { localPort: e.target.value.replace(/[^\d]/g, '') })
                        }
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
                        onChange={(e) =>
                          setRow(i, { remotePort: e.target.value.replace(/[^\d]/g, '') })
                        }
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

            {selected.id === activeHostId && tunnelStatus?.error ? (
              <small className="tunnel-status-error error-text">ssh: {tunnelStatus.error}</small>
            ) : selected.id === activeHostId &&
              tunnelStatus?.running &&
              tunnelStatus.forwards.length ? (
              <small className="tunnel-status-ok">Active: {tunnelStatus.forwards.join(', ')}</small>
            ) : null}
          </div>
        )}

        <ActivityLog />

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
            Session and layout options live in the profile on {draftLabel(selected)}, and appear
            once it is connected.
          </small>
        )}

        <label>
          Config file
          <button type="button" className="path-btn" onClick={onChoosePath}>
            {configPath.replace(/^\/Users\/[^/]+/, '~')}
          </button>
          <small>Point this at a synced folder to carry your hosts across machines.</small>
        </label>

        <div className="modal-actions">
          {selected.id === activeHostId ? (
            <span className="spacer" />
          ) : (
            <>
              <small className="switch-note">
                Saving switches to <strong>{draftLabel(selected)}</strong>.
              </small>
              <span className="spacer" />
            </>
          )}
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
