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

## Building an app

```bash
npm run dist        # → release/Rippon-<version>-arm64.dmg and .zip
npm run dist:dir    # unpacked release/mac-arm64/Rippon.app, for a quick check
```

Targets Apple Silicon. `node-pty` is native, so it is unpacked from the asar
archive; everything else is bundled.

The build is **ad-hoc signed, not notarized** — a Developer ID needs a paid
account. On this machine it just opens. On another Mac, Gatekeeper refuses it
once with "unidentified developer"; either right-click → Open, allow it under
System Settings → Privacy & Security, or clear the quarantine flag after
copying:

```bash
xattr -dr com.apple.quarantine /Applications/Rippon.app
```

The ad-hoc signature is what keeps that dialog recoverable. `identity: null`
alone leaves the bundle carrying Electron's own signature, which seals none of
our files — and macOS refuses a *broken* signature far more harshly than a
missing one, with "Rippon is damaged and can't be opened" and no way past it in
the UI. `scripts/adhoc-sign.js` re-signs the bundle from `afterPack` and fails
the build if verification does not pass.

Packaged and dev runs share one profile (`~/Library/Application Support/rippon`),
so a browser login done in either applies to both.

## Tabs = tmux sessions

| Action | What happens remotely |
|---|---|
| **+ → New session…** | `tmux new-session -d -s <name>` |
| **Double-click a tab** | `tmux rename-session` |
| **× on a tab** | asks first — see below |
| Opening a tab | `ssh -tt host tmux -u new-session -A -s <name>` |
| Every 5s, on window focus, and on reconnect | `tmux list-sessions` |

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

Config is split in two, along the line between *connecting* and *what you see*.

**The local file** — `~/.rippon/config.json`, per-machine, relocatable with `⌘⇧O`. Just enough to
open the connection, plus which profile to load:

```jsonc
{
  "version": 5,
  "ssh": {
    "host": "ubuntu@10.223.234.74",
    "args": ["-i", "/Users/you/rv-prototype-key.pem"],
    "newSessionCommand": "claude",  // optional, runs inside each session you create
    "tunnels": [                     // optional local forwards (ssh -L)
      { "localPort": 8080, "remoteHost": "localhost", "remotePort": 3000 }
    ]
  },
  "activeProfile": "default"
}
```

**Profiles** — `~/.rippon/profiles/<name>.json` in the SSH user's home *on the remote host*. Each
holds the presentation: views, tab/tile layout, per-session browser URL and split ratio, bookmarks,
`detachHidden`. This lives next to the tmux sessions it decorates, so your layout follows the box
you work on rather than the laptop you sit at — no synced folder to set up. The SSH login is the
boundary: anyone who can get a shell as that user is trusted with these, so they are stored plainly
in that user's home.

```jsonc
// ~/.rippon/profiles/default.json, on the host
{
  "version": 5,
  "detachHidden": false,
  "views": [ /* … */ ],
  "activeViewId": "view-main",
  "sessions": {                       // keyed by tmux session name — decoration only
    "auth-refactor": { "url": "https://github.com/org/repo/pull/42", "splitRatio": 0.5 }
  },
  "bookmarks": [ /* … */ ]
}
```

Switch, create, rename or delete profiles from the **`<name> ▾`** chip in the title bar. Different
people (or the same person, different tasks) sharing one SSH login just pick different profiles.

Because the presentation is remote, **startup waits on the connection** — there is no local copy to
fall back on. The local file is read first and needs no network, so the window opens straight away
showing the host and profile it is about to load; until that profile actually arrives there is no
workspace, so you get a connect screen instead of an empty one, and nothing that edits a profile is
reachable. That is deliberate: a layout the app invented must never be offered for editing, because
saving it would overwrite the real profile on the host.

Retrying is automatic — 1s, 2s, 4s … capped at 30s, with the countdown and the ssh error on screen —
and one attempt runs at a time, so a host that hangs cannot pile up a queue of them. Window focus,
the network coming back, `⌘⇧L` and **Retry now** all jump the queue. Nothing needs a restart: the
moment the host answers, the profile loads and the workspace appears.

Once it is up, losing the connection is only a strip along the top: the panes and their scrollback
stay, and saving keeps working, because from that point the profile in memory *is* the host's.

Profile reads/writes ride the same multiplexed connection as everything else (writes are atomic:
temp file then rename), and the local file is watched by polling so a Drive/Dropbox sync that swaps
the inode is still picked up live.

An older single-file config (v1–v4, everything local) is migrated automatically the first time it
connects: the presentation is lifted up to a `default` profile on the host, and the local file
shrinks to the shape above. Nothing is written remotely until that first successful connection, so a
failed or offline migration never loses your layout.

## Port forwards

The settings modal has a **Port forwards** section for local forwarding (`ssh -L`): a port on the
remote host, republished on `localhost` here. A dev server bound to the box's own `:3000` becomes
`localhost:8080` on your machine — open it in a browser pane like any other URL.

Each row is `local port → remote host : remote port`; the remote host is almost always `localhost`
(resolved on the box), so the whole tunnel means "reach *that* port over the SSH connection". Local
ports must be unique. A `⇄` chip in the title bar shows the live state — green when connected, red
with the ssh error when a port is already in use or the host is unreachable.

The forwards are held by one background `ssh -N` that rides the same multiplexed connection as the
tabs, so they cost no extra auth prompt and come up as soon as a host is set. Like the host itself,
they live in the local file (they are part of *connecting*, not a profile).

## SSH

Rippon spawns your system `ssh` binary, so `~/.ssh/config` aliases, `ProxyJump`, agent forwarding,
Yubikey/1Password agents and interactive MFA all work as they do in a normal terminal. No
credentials are stored by the app.

All invocations share one multiplexed connection (`ControlMaster=auto`, socket under `~/.rippon/`,
`ControlPersist=120`), so the frequent list/create/kill calls and the port-forward connection cost
no handshake and no second round of auth prompts.

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
| `⌘⇧L` | refresh session list now (also retries a down host immediately) |
| `⌘L` | focus the address bar |
| `⌘J` | focus the terminal |
| `⌘F` | find in the pane you were last in — page text, or terminal scrollback |
| `⌘G` / `⌘⇧G` | next / previous match |
| `⌘R` | reload the browser pane |
| `⌘⇧R` | reattach the session |
| `⌘,` | SSH settings |
| `⌘⇧O` | choose the config file |

## Layout

```
src/
  main/       Electron main — window, menus, local config store, remote profile
              store, tmux-over-ssh, PTY manager, port-forward manager
  preload/    contextBridge API surface (window.rippon)
  renderer/   React UI — tab strip, terminal pane, browser pane, dialogs
  shared/     config types + normalization + local/profile split, both sides
```
