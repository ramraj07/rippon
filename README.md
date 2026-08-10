# Rippon

Tabbed workspace for driving remote coding agents.

**One SSH host for the whole app. Tabs are the tmux sessions running on it.** The tab strip is a
live view of `tmux list-sessions` — a session an agent spawns on the box shows up as a tab within
seconds, and a session killed elsewhere takes its tab with it.

Each tab is a split pane:

- **Left** — an attached tmux session (real `ssh` in a PTY, rendered with xterm.js).
- **Right** — a browser view with an address bar, for the PRs that session's agent opens.

Click any link the agent prints and it loads in that tab's browser pane instead of your system
browser. Plain URLs and OSC 8 hyperlinks both work.

## Running it

```bash
npm install     # also rebuilds node-pty against Electron
npm run dev     # dev, with HMR on the renderer
npm run build && npm start   # production bundle
```

First launch opens SSH settings. Fill in the host and any flags, and the tab strip populates.

## Tabs = tmux sessions

| Action | What happens remotely |
|---|---|
| **+ → New session…** | `tmux new-session -d -s <name>` |
| **Double-click a tab** | `tmux rename-session` |
| **× on a tab** | asks first — see below |
| Opening a tab | `ssh -tt host tmux -u new-session -A -s <name>` |
| Every 5s, and on window focus | `tmux list-sessions` |

Closing a tab asks whether to kill the session:

- **Close tab only** — detaches and hides the tab. The session and everything running in it keep
  going; the tab is one click away again under **+**.
- **Kill session** — `tmux kill-session`. The session and its contents are gone.

Because the strip mirrors tmux, a hidden session is the only way to have a running session with no
tab. That hidden list is per-machine-config, so another machine opening the same config still sees
every session as a tab.

Session names are restricted to `[A-Za-z0-9_-]` — tmux forbids `.` and `:`, and anything needing
shell quoting would have to survive a trip through `ssh`.

## Config

Everything lives in one JSON file, default `~/.rippon/config.json`, relocatable with `⌘⇧O` or from
the settings modal. Point it at a synced folder to carry your layout across machines:

```jsonc
{
  "version": 2,
  "ssh": {
    "host": "ubuntu@10.223.234.74",
    "args": ["-i", "/Users/you/rv-prototype-key.pem"],
    "newSessionCommand": "claude"   // optional, runs inside each session you create
  },
  "activeSession": "auth-refactor",
  "hidden": ["scratch"],            // running, but no tab
  "sessions": {
    "auth-refactor": {
      "url": "https://github.com/org/repo/pull/42",
      "splitRatio": 0.5
    }
  }
}
```

`sessions` is keyed by tmux session name and holds only local decoration — the browser URL and
split position, written back as you browse and drag. The session list itself is never stored; it
always comes from the host. The file is watched by polling, so a Drive/Dropbox sync that swaps the
inode is still picked up live, and writes are atomic (write-then-rename).

## SSH

Rippon spawns your system `ssh` binary, so `~/.ssh/config` aliases, `ProxyJump`, agent forwarding,
Yubikey/1Password agents and interactive MFA all work as they do in a normal terminal. No
credentials are stored by the app.

All invocations share one multiplexed connection (`ControlMaster=auto`, socket under `~/.rippon/`,
`ControlPersist=120`), so the frequent list/create/kill calls cost no handshake and no second round
of auth prompts.

One caveat: those control calls have no TTY. If the host key is unknown or your key needs an
interactive passphrase with no agent loaded, they fail with the ssh error shown in the app's error
bar. `ssh` to the host once from a terminal and it sorts itself out.

Extra flags are split on spaces, so key paths must be absolute and free of spaces.

## Keyboard

| | |
|---|---|
| `⌘T` | new tmux session |
| `⌘W` | close tab (asks about killing) |
| `⌘1`–`⌘9` | jump to tab |
| `⌃Tab` / `⌃⇧Tab` | cycle tabs |
| `⌘⇧L` | refresh session list now |
| `⌘L` | focus the address bar |
| `⌘J` | focus the terminal |
| `⌘R` | reload the browser pane |
| `⌘⇧R` | reattach the session |
| `⌘,` | SSH settings |
| `⌘⇧O` | choose the config file |

## Layout

```
src/
  main/       Electron main — window, menus, config store, tmux-over-ssh, PTY manager
  preload/    contextBridge API surface (window.rippon)
  renderer/   React UI — tab strip, terminal pane, browser pane, dialogs
  shared/     config types + normalization, used by both sides
```
