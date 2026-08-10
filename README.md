# Rippon

Tabbed workspace for driving remote coding agents. Every tab is a **split pane**:

- **Left** — an SSH session to a machine where an agent is running (real `ssh` in a PTY, rendered with xterm.js).
- **Right** — a browser view with an address bar, for the PRs the agent opens.

Click any link the agent prints in the terminal and it loads in that tab's browser pane
instead of your system browser. Plain URLs and OSC 8 hyperlinks both work.

## Running it

```bash
npm install     # also rebuilds node-pty against Electron
npm run dev     # dev, with HMR on the renderer
npm run build && npm start   # production bundle
```

## Tabs and config

The whole workspace — tabs, hosts, remote commands, browser URLs, split positions — lives in a
single JSON file:

```
~/.rippon/config.json      # default
```

Point it somewhere synced (`⌘⇧O`, or click the path in the top-right) to carry your tabs
across machines:

```
~/Library/CloudStorage/GoogleDrive-you@corp.com/My Drive/rippon/config.json
```

The file is watched by polling, so when Drive syncs a newer copy in, the app picks it up live.
Writes are atomic (write-then-rename), so a partial file is never synced or read. Hand-editing
the file is a supported workflow.

```jsonc
{
  "version": 1,
  "activeTabId": "tab-a1b2c3",
  "tabs": [
    {
      "id": "tab-a1b2c3",
      "title": "auth-refactor",
      "ssh": {
        "host": "agent-box",              // any ~/.ssh/config alias, or user@host
        "command": "tmux new -A -s agent", // blank = login shell
        "args": ["-o", "ServerAliveInterval=30"],
        "autoConnect": false               // true = connect at launch, not on first view
      },
      "browser": { "url": "https://github.com/org/repo/pull/42" },
      "splitRatio": 0.5
    }
  ]
}
```

`splitRatio` and `browser.url` are written back as you drag the divider and browse, so a tab
reopens exactly where you left it.

### SSH

Rippon spawns your system `ssh` binary, so `~/.ssh/config` aliases, `ProxyJump`, agent
forwarding, Yubikey/1Password agents and interactive MFA prompts all work exactly as they do in
a normal terminal. No credentials are stored by the app.

Sessions connect lazily the first time you open a tab (or at launch with `autoConnect`), and stay
alive in the background when you switch tabs. Pair it with `tmux new -A -s <name>` so the agent
survives a reconnect too.

### Cookies

All browser panes share one persistent session (`persist:rippon-browser`), so you log into GitHub
once and every tab is logged in. The session survives restarts. `window.open` popups (SSO flows)
get a real window on the same session; plain `target=_blank` links navigate the pane in place.

## Keyboard

| | |
|---|---|
| `⌘T` / `⌘W` | new tab / close tab |
| `⌘1`–`⌘9` | jump to tab |
| `⌃Tab` / `⌃⇧Tab` | cycle tabs |
| `⌘L` | focus the address bar |
| `⌘J` | focus the terminal |
| `⌘R` | reload the browser pane |
| `⌘⇧R` | reconnect SSH |
| `⌘⇧O` | choose the config file |

Double-click a tab (or its ⚙) to edit its host, command, and URL.

## Layout

```
src/
  main/       Electron main — window, menus, config store, PTY manager
  preload/    contextBridge API surface (window.rippon)
  renderer/   React UI — tab strip, terminal pane, browser pane
  shared/     config types + normalization, used by both sides
```
