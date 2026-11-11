# Screenshots

## Sizes App Store Connect needs

| Device | Required? | Pixels (portrait) | Simulator to use |
|---|---|---|---|
| iPhone 6.3" (Dynamic Island) | **Yes, at least 1** | 1206 × 2622 (or 1179 × 2556) | iPhone 17 Pro or newer |
| iPhone 6.9" | Optional, recommended (shown on Pro Max and Plus) | 1320 × 2868 | iPhone 17 Pro Max or newer |
| iPad 13" | **Yes, because the app runs on iPad** (`TARGETED_DEVICE_FAMILY: "1,2"`) | 2064 × 2752 | iPad Pro 13-inch (M5) |

Up to 10 per size; PNG or JPEG, no transparency. Smaller sizes are scaled from these.

**[YOU]** If you don't want to make iPad screenshots (or support iPad yet), set
`TARGETED_DEVICE_FAMILY: "1"` in `project.yml` before the first upload. You can't take iPad away
later: an update can't drop a device family that has shipped, so decide now.

## The set (6 shots)

Shoot against the review test host from [app-review.md](app-review.md), so every screen shows the
same tidy demo content and nothing from your real machines. Use dark mode for all of them; a
terminal app looks right in dark.

| # | Screen | How to get there | Caption (top of the frame) |
|---|---|---|---|
| 1 | **Session list with live previews** — 3–4 sessions (rename them `api-refactor`, `docs`, `tests`, `shell`), previews showing agent output | Home screen after connecting; start extra sessions with + | **Every tmux session, live.** |
| 2 | **Terminal** in `agent`, mid-task, with coloured output and the key bar visible above the keyboard | Tap a session, tap into the terminal | **A real terminal in your pocket.** |
| 3 | **Tap a link → browser** — a GitHub pull request page in the session's browser, Terminal/Browser switch visible | Tap the "Pull request ready" link the demo agent prints | **Links open right beside the session.** |
| 4 | **tmux menu** open from the green tmux key | Tap the tmux key on the key bar | **Windows, splits and copy mode, one tap away.** |
| 5 | **Port forward** — the demo page (or a nicer dev-server page) at `localhost:8000` in the browser | Add the forward in the host settings, open `http://localhost:8000` | **Try the app your agent is building.** |
| 6 | **Keys** — the SSH keys screen with an ed25519 key, or the new-host form | Manage hosts… → SSH keys | **Your keys stay in your Keychain.** |

Optional extras: the file browser with a code preview, the key bar editor in Settings, landscape
terminal.

For iPad, take 1, 2, 3 and 5 in landscape; there's more room for the terminal.

**[YOU]** The demo host's agent output is deliberately generic. For better shots, make session 2
show something real-looking, such as a short build log or a test run, rather than a real
agent's private work. Don't show real host names, IPs, user names or repos.

## Capturing

```bash
xcrun simctl boot "iPhone 17 Pro"
xcrun simctl ui booted appearance dark
xcrun simctl status_bar booted override --time 9:41 --batteryState charged --batteryLevel 100 \
  --cellularMode active --cellularBars 4 --wifiBars 3
# run Rippon from Xcode on that simulator, set up the screen, then:
xcrun simctl io booted screenshot ~/Desktop/rippon-01.png
```

Simulator screenshots come out at exactly the sizes above. Hide the keyboard for shots that don't
need it. Check there's no alpha channel before uploading:
`sips -g hasAlpha ~/Desktop/rippon-*.png` (should say `no`).

## Framing (optional but worth it)

Plain screenshots are allowed. Most top developer-tool listings put the caption above a device
frame on a solid background; use the icon's teal so the page matches the icon. Tools that do this
from the raw screenshots: Apple's Product Page templates in Figma/Sketch, or any "App Store
screenshot" generator. Keep the caption to one line, and the same font and size on every shot.

## App preview video (optional)

A 15–30 second screen recording (`xcrun simctl io booted recordVideo preview.mov`): session list
→ open `agent` → scroll → tap the PR link → browser. Up to 3 per size; they autoplay muted, so no
voice-over needed.
