# App Review information

> **[YOU] This is the one thing that blocks submission.** Rippon does nothing until it reaches an
> SSH server with tmux, and App Review rejects apps it can't try (guideline 2.1, "App
> Completeness"). You need to run a test server that the reviewer can sign in to, and keep it up
> until the app is approved.

## 1. Set up the test server (about 10 minutes)

1. Create the smallest VM your cloud offers (any provider; ~$5/month, and you can delete it after
   review) with **Ubuntu 24.04**, a **public IPv4 address**, and **port 22 open** to the internet.
   Reviewers are not on your network, so a Tailscale-only or home machine won't work.
2. Copy [`demo-host-setup.sh`](demo-host-setup.sh) to it and run:

   ```bash
   sudo REVIEW_PASSWORD='<a long random password>' bash demo-host-setup.sh
   ```

   It creates a user `appreview` that can sign in with that password (and only that user), starts
   two tmux sessions (`agent`, which prints fake agent progress with links, and `shell`, an
   ordinary prompt), and serves a small web page on the server's `localhost:8000` for the port
   forwarding demo. Tested on Ubuntu 24.04.
3. On your own phone, add the host in Rippon with those details and check that you see both
   sessions. That is exactly what the reviewer will do.

Don't use a real machine of yours: the reviewer gets a shell on it.

## 2. App Store Connect → App Review Information

**Sign-in required:** Yes.

- **User name:** `appreview`
- **Password:** **[YOU]** the password you chose above

Apple's two fields are for the SSH user and password; the host goes in the notes.

**Contact information:** **[YOU]** first name, last name, phone number, email. Apple calls this
number if something doesn't work, so answer it during review.

**Notes** (paste, then fill in the host):

```
Rippon is an SSH client for tmux. It shows the tmux sessions running on a server the user owns, so it needs a server to connect to. We run a test server for review:

  Host: [YOUR SERVER IP]
  Port: 22
  User: appreview
  Password: (in the Sign-In Information fields)

To try it:
1. Open Rippon and tap "Add host".
2. Enter the host, user and port above. Under Authentication choose "Password" and enter the password. Tap Save.
3. The session list shows two tmux sessions, "agent" and "shell", with live previews. Tap "agent".
4. The terminal shows simulated progress from a coding agent. Drag to scroll back, press and hold to select text. Links in the output are underlined; tap one to open it in the session's built-in browser, and use the Terminal / Browser switch at the top to go back.
5. Open "shell" to type commands. The key bar above the keyboard has Esc, Ctrl, Tab, arrows and a "tmux" menu.
6. Port forwarding: from the host menu (top left) choose "Manage hosts…", open the host, and under Port forwards add local 8000 to localhost : 8000. Then in any session's browser, go to http://localhost:8000 to see a page served by the test server.
7. "+" in the session list starts a new tmux session; swipe a session to hide or kill it.

The app has no accounts, no in-app purchases and no server of its own: it connects only to the SSH servers the user enters. Keys and passwords are stored in the iOS Keychain on the device.
```

**Attachment (optional):** a screen recording of steps 1–6 on your phone helps if the server is
unreachable from Apple's network for some reason. **[YOU]** worth recording once the server is up.

## 3. Things a reviewer might raise, and the answer

| Concern | Answer |
|---|---|
| **2.5.2 — downloading or running code** | Rippon runs nothing on the phone; commands run on the user's own server over SSH. SSH and terminal apps (Termius, Blink Shell, Prompt) are long-established on the store. |
| **4.2 — minimum functionality** | Native SwiftUI app with an SSH client, terminal emulator, browser, file browser and port forwarding; not a wrapped website. |
| **Local network permission prompt** | Shown the first time a host on your Wi-Fi is reached; the purpose string explains it's for SSH. |
| **"Can't reach the host"** | Means the server is down or port 22 is blocked from Apple's network. Keep the VM running, and check it from a phone on cellular data before submitting. |
| **Web content / 16+** | The in-app browser opens any web page, which is why the age rating is 16+ (see [age-rating.md](age-rating.md)). |

## 4. After approval

Delete the VM (or at least run `sudo deluser --remove-home appreview` and delete
`/etc/ssh/sshd_config.d/00-appreview.conf`). Make a fresh one, with a new password, for the next
update's review.
