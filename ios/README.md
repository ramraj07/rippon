# Rippon for iPhone

A native SwiftUI version of Rippon. It drives the same tmux sessions on the same hosts, and it reads
and writes the same profiles (`~/.rippon/profiles/<name>.json` on the host), so the layout, the
per-session pages and the bookmarks are shared with the desktop app.

## Building it

You need a Mac with Xcode 16 or newer, and [XcodeGen](https://github.com/yonaskolb/XcodeGen):

```bash
brew install xcodegen
cd ios
xcodegen generate
open Rippon.xcodeproj
```

To run it on your phone, put your signing team in `ios/Local.xcconfig` once. The file is
git-ignored, and it survives `xcodegen generate`, unlike a team picked in Xcode:

```bash
echo 'DEVELOPMENT_TEAM = <your team id>' > Local.xcconfig
```

Your team ID is shown in Xcode → Settings → Accounts, or at developer.apple.com → Membership. Then
choose your iPhone as the run destination and press ⌘R. **Pull before you build**: Xcode builds
whatever is in this folder. Settings → This build in the app shows the commit it was built from.

`project.yml` is the source of truth. The generated `Rippon.xcodeproj` is not checked in, so
regenerate it after pulling. The `iOS` GitHub workflow builds the app for the simulator on every
change under `ios/`.

## What it does

| Desktop | iPhone |
|---|---|
| Tab strip that mirrors `tmux list-sessions` | Session list that mirrors it: polled every 5s, on pull to refresh, and when the app comes back to the foreground |
| **+ → New session…**, rename, close tab / kill session | **+**, long-press to rename, swipe to **Hide** (it keeps running) or **Kill**. Hidden sessions are listed at the bottom |
| Terminal pane (xterm.js over `ssh -tt`) | Full-screen SwiftTerm terminal over the in-app SSH connection, with a key bar for Esc, Ctrl, Tab and the arrows |
| Browser pane beside the terminal | A **Terminal / Browser** switch per session. Tapped links open in that session's browser, and its URL is saved to the profile |
| Session and global bookmarks | The bookmark menu in the browser toolbar |
| Host switcher and host settings | Host menu at the top left |
| Profiles chip | Profile menu: switch, create, rename or delete |
| Port forwards (`ssh -L`) | Served on the phone's `localhost` while the app is open |
| File browser | **⋯ → Browse files**: text and image previews, and download to the share sheet |
| `⇱` mouse-mode chip | **⋯ → Turn tmux mouse on/off** |
| SSH activity | **⋯ → SSH activity** |
| Scroll wheel / trackpad in the terminal | One-finger drag scrolls tmux's history (flick to keep going). Typing jumps back to the bottom |
| Selecting text | Press and hold (the word under your finger is picked), keep holding and drag to stretch it, let go for Copy. Drag either end to adjust it; tap anywhere to clear |
| Clickable links | Web links on screen are underlined in blue (long ones that wrap included); tap one and it opens in that session's browser |
| tmux prefix keys | The green **tmux** key on the keyboard bar: new/next/previous/pick window, rename, splits, next pane, zoom, copy mode, detach, close. Runs tmux commands directly, so any prefix works |
| Keyboard bar | Settings → Keyboard bar: reorder or remove keys, add PgUp/PgDn/Home/End/symbols, and add snippets (keys that type text, optionally pressing Return) |
| Terminal text size | **⋯ → Text size** in a session, or Settings |

### Different on iPhone

- **SSH is built in** ([Citadel](https://github.com/orlandos-nl/Citadel), on SwiftNIO SSH) rather
  than your system `ssh`. That means no `~/.ssh/config` aliases, no agent, no ProxyJump and no
  1Password, so enter the real host name, user and port. Authenticate with a key, either generated
  on the phone (copy its public half into the host's `~/.ssh/authorized_keys`) or imported, or
  with a password. Keys and passwords are kept in the Keychain on this device only.
- **Keys you can import**: OpenSSH files (`BEGIN OPENSSH PRIVATE KEY`) and PEM files —
  `BEGIN RSA PRIVATE KEY`, `BEGIN EC PRIVATE KEY`, `BEGIN PRIVATE KEY` and `BEGIN ENCRYPTED
  PRIVATE KEY` — so an AWS `.pem` works as it is. ed25519, ECDSA (P-256/384/521) and RSA keys
  are all supported. RSA keys sign with `rsa-sha2-256`, as OpenSSH 8.8 and later require;
  Citadel's own RSA support signs with SHA-1 `ssh-rsa`, which those servers refuse, so Rippon
  does its own RSA signing. Passphrases work for PEM files (legacy OpenSSL `Proc-Type` encryption
  and PKCS#8 PBES2) and for OpenSSH ed25519 keys. A passphrase-protected *OpenSSH-format* RSA or
  ECDSA key can't be imported yet; remove the passphrase on a computer first (`ssh-keygen -p`).
- **Host keys** are trusted on first use, like `known_hosts`. A changed key is refused, and you can
  forget the saved key from the host's settings.
- **Background.** iOS suspends apps, so connections and forwards do not live on in the background.
  When you come back, Rippon checks the connection, replaces it if it went stale, reattaches the
  session on screen and restarts the forwards. tmux keeps everything running in the meantime, as
  it does when you close the desktop app.
- **One session on screen at a time.** A session holds an SSH channel only while it is open, which
  keeps well under sshd's default `MaxSessions` of 10.
- **Views.** The phone has no tiled or multiple-tab-row layouts. It uses the profile's active tab
  view (or its first one) for the hidden list, and it leaves every other view, tile, split ratio
  and zoom in the profile exactly as the desktop wrote them.
- **Saving.** Every change the phone makes re-reads the profile from the host and applies only that
  change before writing, so it does not undo edits the desktop made in the meantime. The desktop
  still saves its own in-memory copy, though, so a change made on the phone can be overwritten by
  the desktop's next save until the desktop reloads the profile.

### Not on iPhone

- **Local hosts** ("This Mac"): an iPhone has no tmux to drive.
- **Most keyboard shortcuts.** With a hardware keyboard you get ⌘T (new session), ⌘R (reload the
  page) and ⌘⇧R (reattach).
- **Find in page or scrollback**, **per-view zoom** and **detach background sessions** (the phone
  always detaches sessions that are off screen).

## Layout

```
ios/
  project.yml            XcodeGen spec — packages, Info.plist, settings
  Rippon/
    App/                 entry point; Workspace (connection, retries, profile, sessions)
    Model/               hosts, profile (raw JSON, round-tripped), bookmarks, activity log
    SSH/                 connection, tmux, profiles, files, port forwards, keys, host keys
    Terminal/            SwiftTerm view + PTY channel per session
    Browser/             WKWebView per session
    Views/               SwiftUI screens
```
