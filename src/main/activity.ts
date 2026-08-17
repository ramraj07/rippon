import { EventEmitter } from 'node:events'
import type { ActivityEntry, ActivityLevel, ActivitySource } from '../shared/types'

/**
 * The app's record of everything it asks ssh to do.
 *
 * A module-level singleton rather than something threaded through constructors,
 * because every layer writes to it — the tunnel forwarder, the tmux calls, the
 * profile reads, the pane attaches — and none of them should have to be handed a
 * logger to do so.
 *
 * It is deliberately in-memory and bounded. This is a diagnostic window into the
 * current run, not an audit trail: the failures it exists to explain (a wedged
 * master, a bind clash, a host that went away) are all visible within minutes of
 * happening, and writing a file would mean deciding where it lives, when it is
 * rotated, and what it is allowed to contain — a host, a username and a key path
 * are already more than belongs on disk without being asked for.
 */

const CAP = 1000

class ActivityLog extends EventEmitter {
  private entries: ActivityEntry[] = []
  private seq = 0

  add(
    source: ActivitySource,
    level: ActivityLevel,
    text: string,
    extra: { ms?: number; detail?: string } = {}
  ): ActivityEntry {
    const last = this.entries[this.entries.length - 1]
    /*
     * Collapse an identical repeat into the line above instead of appending.
     * The session poll fires every 5s, so a run of a few hours is otherwise
     * thousands of "list-sessions ok" lines with the one interesting event
     * somewhere in the middle. Errors are never collapsed — each one is its own
     * event, and the moment a second arrives is exactly what you want to see.
     */
    if (
      last &&
      last.source === source &&
      last.level === level &&
      last.text === text &&
      level !== 'error'
    ) {
      last.count = (last.count ?? 1) + 1
      last.at = Date.now()
      if (extra.ms !== undefined) last.ms = extra.ms
      this.emit('entry', last)
      return last
    }

    const entry: ActivityEntry = { seq: ++this.seq, at: Date.now(), source, level, text, ...extra }
    this.entries.push(entry)
    if (this.entries.length > CAP) this.entries.splice(0, this.entries.length - CAP)
    this.emit('entry', entry)
    return entry
  }

  all(): ActivityEntry[] {
    return this.entries
  }

  clear(): void {
    this.entries = []
    this.emit('cleared')
  }
}

export const activity = new ActivityLog()
