# Rippon Privacy Policy

_Last updated: [DATE]_

Rippon is an SSH client for iPhone and iPad that shows the tmux sessions running on servers you
choose. This policy explains what happens to your information when you use it.

**The short version: Rippon doesn't collect anything. There is no Rippon account, no Rippon server,
no analytics and no advertising. The app talks only to the servers and web sites you point it at.**

## Information that stays on your device

- **Hosts you add:** names, addresses, user names, ports and port forwards, stored in the app's
  private storage.
- **SSH keys and passwords:** stored in the iOS Keychain with "this device only" protection. They
  are not synced to iCloud and are never sent anywhere except to the server you are signing in
  to, as part of the SSH sign-in.
- **Trusted host keys and app settings**, such as the keyboard bar layout and text size.
- **Web data** from the in-app browser, such as cookies and cached pages, kept in the app's
  private storage like any browser.

Deleting the app deletes this information. iOS may include some of it (but not Keychain items
marked "this device only") in your own device backups.

## Information stored on your servers

To share a workspace with the Rippon desktop app, Rippon saves a small settings file on each
server you connect to, in `~/.rippon/profiles/` in your home directory. It holds your session
layout, the page each session's browser was showing, and your bookmarks. It is stored on your
server only, and you can delete it at any time.

## Information sent over the network

- **To your servers:** Rippon connects directly to the SSH servers you add. Everything you type
  and everything the server sends back travels inside the encrypted SSH connection.
- **To web sites:** pages you open in the in-app browser are loaded directly from those sites,
  which can see your IP address and set cookies, as they would in Safari. Their own privacy
  policies apply.

Nothing is sent to the developer of Rippon.

## What we don't do

We don't collect personal information, usage statistics or crash logs. We don't use advertising
or analytics services, and we don't track you across apps or web sites. We don't sell or share
any data, because we don't have any.

If you choose to share crash reports with app developers in iOS Settings, Apple may pass crash
reports to us. They contain technical information about the crash, not your data, and are used
only to fix bugs.

## Children

Rippon is a tool for software developers and is not directed at children.

## Changes

If this policy changes, the new version will be posted at this address with a new date. If Rippon
ever starts collecting data, this policy and the App Store privacy label will say so before that
version is released.

## Contact

Questions about this policy: [CONTACT EMAIL], or open an issue at
https://github.com/ramraj07/rippon/issues.

[DEVELOPER NAME]
