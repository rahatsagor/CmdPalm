# Security

CmdPalm lets another device type and click on your Mac, so the bar for who may
connect is high. This page describes how that works and how to report a
problem.

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/rahatsagor/CmdPalm/security/advisories/new)
rather than in a public issue. Include the CmdPalm version, what an attacker
needs (same network, a paired device, physical access), and steps to
reproduce. You should hear back within a week.

Only the latest release receives fixes.

## How devices are trusted

- **Pairing.** A device can pair in three ways:
  - the single-use code in the QR code (144 bits of randomness),
  - the six-digit PIN shown on the Mac,
  - approval on the Mac, which shows a prompt you have to accept.

  PIN and approval can each be turned off in **Settings → Phone Setup**. The
  code and PIN change every 10 minutes and after each pairing that uses
  either of them. The PIN also changes after each lockout.
- **Guessing.** The PIN only works while the Mac shows it in the CmdPalm menu
  or settings, and for three minutes after, so nobody can try PINs while you
  aren't pairing. After 5 wrong PINs an address is locked out, starting at
  30 seconds and doubling up to 15 minutes. IPv6 addresses are counted per
  /64 network, so one device can't dodge the lockout by switching addresses.
  Wrong PINs are forgotten after an hour without any, so occasional typos
  don't add up to longer lockouts. After 20 wrong PINs within a minute, from
  any mix of addresses, pairing by PIN or approval pauses for everyone until
  the minute has passed. The QR code is too long to guess, so it keeps
  working during a lockout.
- **Approval requests.** Each address (or IPv6 /64 network) can wait on one
  request at a time. After 3 requests in a row are declined or left
  unanswered, that address has to wait before asking again, from 30 seconds
  up to 15 minutes. Device names and models are shown without invisible
  formatting characters, so a request can't disguise itself, and pressing
  Return never approves one.
- **Remembered devices** receive a random token. The Mac stores only a SHA-256
  hash of it, together with the device ID, in
  `~/Library/Application Support/CmdPalm`. Removing a device in
  **Settings → Devices** revokes its token, deletes the phone settings kept
  for it and disconnects it immediately.
- **Other websites** can't drive CmdPalm from a browser on your network: the
  server rejects WebSocket connections whose `Origin` doesn't match its own
  address, and answers only requests addressed to an IP address, `localhost`
  or a `.local` name, which blocks DNS rebinding.
- **Connection limits.** Each address (or IPv6 /64 network) can hold at most
  16 connections, and idle connections are closed and recycled, so another
  device on the network can't use up the connections your phone needs.

## Network

CmdPalm listens on one port (8790 by default) on your local network. That
port speaks both HTTP and HTTPS.

- **HTTP** is the default because phones can open it without any setup. On
  HTTP, anyone who can watch your Wi-Fi traffic could see what you type, and
  could copy a remembered device's token and use it to connect as that
  device until you remove it. Use HTTP only on networks you trust, and
  remove any device you no longer use. The phone shows **Not encrypted**
  while it is connected over HTTP.
- **HTTPS** uses a certificate authority created on your Mac the first time
  CmdPalm runs. Its private key never leaves the Mac. The authority is
  limited by name constraints to local addresses, so even if it were stolen
  it could not be used to impersonate public websites. Install it on your
  phone from **Settings → Phone Setup → Encrypted Connection**, and compare
  the SHA-256 fingerprint shown there if you want to be sure.

There are no accounts, no analytics and no cloud relay. CmdPalm contacts
GitHub to check for updates, and nothing else. Voice typing is transcribed on
the Mac itself; if on-device recognition isn't available for a language,
voice typing is unavailable rather than sent to a server.

## What a paired device can do

A paired device can do anything you can do with a keyboard and mouse. Beyond
that:

- **Shell commands** from deck buttons are off until you allow them in
  **Settings → Deck**, and turning them on asks for confirmation.
- **Links** from deck buttons can't open `javascript:` or `data:` URLs.
  `file:` links can run programs, so they work only while shell commands are
  allowed.
- **The clipboard** is only sent to a phone when that phone asks for it, and
  never when it holds something marked as concealed, such as a password
  copied from a password manager. When text is sent as a paste, CmdPalm puts
  it on the clipboard briefly and then restores what was there, marked so
  clipboard managers skip both.
- macOS **Secure Input** (password fields, for example) blocks typed text.
  CmdPalm tells the phone when that happens instead of working around it.

**Pause** in the menu bar panel stops all input immediately, including text
still being typed, deck buttons that are still running and shell commands
they started. While paused, a device can't run actions, read or set the
clipboard, or start voice input. Apps and Shortcuts that a button already
opened keep running, as if you had opened them yourself.

## Updates

Updates are delivered with [Sparkle](https://sparkle-project.org). Both the
update feed and every update archive are signed with an EdDSA key held only by
the release workflow, and the app refuses updates that fail either check.

CmdPalm is not notarized by Apple. Releases are built on GitHub Actions from
the tagged source, signed with the same self-signed certificate every time
and with the hardened runtime turned on, and `SHA256SUMS` is attached to
every release.

## Logs

Logs in `~/Library/Logs/CmdPalm` record connections, errors and timing. They
never contain typed text, dictation, clipboard contents or deck button
contents.
