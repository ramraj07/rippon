# App Store listing

Everything that goes on the App Store product page, in the order App Store Connect asks for it.
Character limits are Apple's; the counts in brackets were checked with
`python3 ios/AppStore/check_lengths.py`.

Items marked **[YOU]** are yours to decide or supply. Everything else is ready to paste.

> The copy describes the app as it is once PR #9 is merged (session previews, the tmux menu, the
> editable key bar and tap-to-open links). Ship that first, or drop those lines.

---

## App information (App Store Connect → App Information)

### Name (30 max)

```
Rippon: tmux over SSH
```

[21] **[YOU]** App names are unique across the store. "Rippon" alone may be free, but if it is
taken, this longer name usually is not. Alternatives: `Rippon – Agent Terminal` [23],
`Rippon for tmux` [15]. The name under the icon on the home screen stays "Rippon" either way
(`CFBundleDisplayName`).

### Subtitle (30 max)

```
Watch your coding agents work
```

[29] Alternatives: `Drive coding agents over SSH` [28], `tmux sessions in your pocket` [28].

### Category

- **Primary:** Developer Tools
- **Secondary:** Utilities

### Content rights

"Does your app contain, show, or access third-party content?" → **No.** The app shows the user's
own servers and web pages the user opens; it ships no third-party content.

### Age rating

See [age-rating.md](age-rating.md). Result: **16+** (the in-app browser counts as unrestricted
web access).

---

## Pricing and availability

**[YOU]** Price (Free is the obvious start: there are no accounts or servers to pay for) and
countries. If you include **France**, read [export-compliance.md](export-compliance.md) first:
it needs one extra document.

---

## Version page (App Store Connect → iOS App → version)

### Promotional text (170 max, can be changed any time without a review)

```
Your agents keep working in tmux on your own machine. Rippon puts every session in your pocket: check in, answer a prompt and open the PR it just made, from your phone.
```

### Description (4000 max)

```
Rippon is a phone-sized window onto the tmux sessions running on your own machines. Start a coding agent at your desk, walk away, and keep an eye on it from your iPhone: read what it's doing, answer its questions, and open the pull request it just opened, without a laptop.

ONE HOST, EVERY SESSION
Connect to a Mac, Linux box or cloud VM over SSH and Rippon lists every tmux session on it, with a live preview of each screen. A session an agent starts shows up within seconds; one that ends disappears. Pull to refresh, swipe to hide a session or kill it, long-press to rename, tap + to start a new one.

A REAL TERMINAL
Each session opens full screen in a fast, full-colour terminal.
• Drag to scroll back through tmux history, and flick to keep going.
• Press and hold to select text, drag to stretch the selection, and copy.
• A key bar for Esc, Ctrl, Tab and the arrows. Rearrange it, add PgUp/PgDn/Home/End and symbols, or add your own snippets that type a command for you.
• A tmux menu for new, next and previous windows, splits, zoom, copy mode, rename and detach, whatever your prefix key is.
• Hardware keyboard support, with shortcuts for a new session and reattaching.

A BROWSER FOR EVERY SESSION
Links printed in the terminal are underlined; tap one and it opens in that session's own browser, not Safari. Flip between Terminal and Browser to read the PR, the docs or the preview your agent just mentioned. Each session remembers its page, and bookmarks can belong to one session or all of them.

PORT FORWARDING
Forward a port from the host and its dev server opens in the in-app browser at localhost, so you can try the app your agent is building.

FILES
Browse the host's files, preview text and images, and save a file to your phone through the share sheet.

SHARED WITH THE DESKTOP APP
Rippon keeps its layout, per-session pages and bookmarks in a small profile on the host itself, so the iPhone app and the Rippon desktop app show the same workspace.

YOUR KEYS STAY ON YOUR PHONE
• Generate an ed25519 key on the phone, or import an OpenSSH or PEM key (ed25519, ECDSA and RSA, passphrases included). An AWS .pem file works as it is.
• Or sign in with a password.
• Keys and passwords are kept in the iOS Keychain on this device only, never synced and never sent anywhere except to your own server to sign in.
• Host keys are trusted on first use and checked every time after, like known_hosts.

NO ACCOUNT, NO TRACKING
Rippon talks only to the servers you add. There is no sign-up, no analytics, no ads and no Rippon server in the middle.

WHAT YOU NEED
A machine you can reach over SSH, with tmux installed. Rippon connects directly, so the host needs to be reachable from your phone: on the same network, on a public address, or through a VPN such as Tailscale or WireGuard.
```

### Keywords (100 max, comma-separated, no spaces after commas)

```
ssh,terminal,shell,remote,server,console,linux,vps,devops,ai,agent,port,forward,sftp,code,mosh,cli
```

[98] Apple already indexes the name and subtitle, so "tmux", "Rippon", "coding" and "agents" are
left out here to save room. Don't add other companies' product names (Claude, Codex, Cursor,
Termius): guideline 2.3.7 forbids trademarked terms in keywords.

**[YOU]** Drop `mosh` if you'd rather not attract people looking for Mosh support, which Rippon
doesn't have; `git` or `vim` [3 each] fit in its place.

### What's New

Apple doesn't show this for the first version. For the first update, a template:

```
• [The headline change, in one line]
• Fixes and polish.
```

### Support URL (required)

```
https://github.com/ramraj07/rippon/issues
```

The repo is public, so GitHub Issues works today. **[YOU]** If you'd rather not expose GitHub,
make a one-page site (see Marketing URL) with a contact email.

### Marketing URL (optional)

**[YOU]** Leave empty, or use `https://github.com/ramraj07/rippon`. A nicer option is GitHub
Pages for the repo (Settings → Pages), which can also host the privacy policy.

### Privacy policy URL (required)

The policy is drafted in [privacy-policy.md](privacy-policy.md). It needs a stable public URL.
Fastest option, works as soon as this PR is merged:

```
https://github.com/ramraj07/rippon/blob/main/ios/AppStore/privacy-policy.md
```

**[YOU]** Fill in the contact email in the policy first.

### Copyright

```
2026 [YOUR NAME OR COMPANY]
```

**[YOU]** The legal name on your Apple Developer account (the "seller" shown on the store).

### Version number

`project.yml` says `MARKETING_VERSION: 0.1.0`. **[YOU]** Bump it to `1.0.0` for the first public
release (and give each upload a new `CURRENT_PROJECT_VERSION`).

### Screenshots

See [screenshots.md](screenshots.md).

### App Review information

See [app-review.md](app-review.md). It needs a test host that **you** run.
