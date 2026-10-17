# Changelog

All notable changes to CmdPalm are recorded here. The release workflow turns
each section into the GitHub release notes and the in-app update notes, so
write entries for people using the app.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixes

- The return key on the phone's keyboard showed an emoji on iPhone and iPad.
  It now shows the ⏎ symbol, like the other keys. Home and End in shortcut
  labels use ⇱ and ⇲ for the same reason.

## [0.2.0] - 2026-10-14

A more dependable update. Typing, pasting and voice typing behave better,
pairing copes with slow networks, and the QR code can now use any address
for people who connect through a VPN or their own setup.

### Fixes

- Pasting while the Mac was still typing earlier text could paste your
  previous clipboard instead.
- A held ⌘ or other modifier no longer turns typed text or dictation
  corrections into shortcuts, such as ⌘⌫ moving a file to the Trash.
- Starting and stopping voice typing quickly, or disconnecting while it
  started, could leave speech recognition running on the Mac. Stopping
  CmdPalm now stops it too.
- Pairing with the QR code on a slow network tries again instead of quietly
  falling back to the PIN screen, and says what to do if it can't connect.
- The phone no longer waits forever for approval after the Mac goes to sleep
  or drops off the network.
- Occasional wrong PINs are forgotten after an hour, so they no longer add
  up to ever longer lockouts.
- A device removed on the Mac can no longer bring its settings back by
  saving them just as it is removed. Devices that aren't remembered can't
  see other devices' settings.
- When the Mac isn't connected to a network, the menu says so instead of
  showing a QR code that can't work.
- Changing the port after CmdPalm couldn't start now starts it, and quick
  restarts no longer leave the server on an old setting.
- A damaged settings file is no longer renamed again on every launch.
- One IPv6 device can no longer hold every approval request slot.

### Other ways to connect

For people who connect their devices in their own way. Nothing changes if
you don't use these.

- **Custom** in **Settings → Phone Setup** puts any address in the QR code:
  one of the Mac's other addresses, such as a VPN's, a name from your own
  DNS, or the `https://` address of a reverse proxy.
- Names without dots, and names under `.home.arpa` and `.internal`, work as
  well as `.local`.
- **Accept connections through a proxy on this Mac**, under **Settings →
  Advanced**, lets a reverse proxy on the Mac pass along which device is
  connecting and whether the connection is encrypted. It is off by default.

## [0.1.1] - 2026-10-10

A safer, smoother update to the first release. Voice typing now stays
entirely on your Mac, other devices on your network have fewer ways to get in
the way, and pairing and reconnecting on the phone are more reliable.

### Privacy and security

- Voice typing always runs on your Mac. If your Mac can't recognise a
  language on-device, CmdPalm tells you instead of sending audio to Apple's
  servers.
- The PIN only works while CmdPalm shows it on the Mac, and for three
  minutes after, so nobody can try to guess it while you aren't pairing.
  Wrong PINs from IPv6 addresses are counted per network, so a device can't
  get around the lockout by switching addresses.
- A device whose approval requests keep being declined has to wait before
  asking again. Requests can't hide invisible characters in their names,
  and pressing Return no longer approves a device.
- Pause also stops shell commands that a deck button started.
- Passwords copied from a password manager are never sent to a phone, and
  clipboard managers no longer record the clipboard CmdPalm restores after a
  paste.
- Another device on the network can no longer use up the connections your
  phone needs.
- The phone shows **Not encrypted** while it is connected over HTTP, and
  explains how to turn on the encrypted connection.
- The Mac app is signed with the hardened runtime.

### Phone and tablet

- Scanning the QR code works the first time, even on a phone that was
  paired before and then removed on the Mac.
- When the Mac app updates, an open CmdPalm page reloads itself instead of
  showing empty tabs.
- **Reconnect** is offered after you tap Disconnect.
- Keys pressed while the phone is reconnecting can't get stuck, and live
  typing no longer deletes text on the Mac after the connection drops.
- The home screen app opens its "can't reach your Mac" screen within a few
  seconds when you're away from the Mac's network.
- A **Cancel** button while the Mac is asked to approve, and clearer
  messages when pairing doesn't work.
- Voice typing starts more reliably on iPhone and iPad.
- Settings that can't work in your browser, such as haptics on iOS 17 or
  Keep Screen On without the encrypted connection, are hidden or say why.
- The deck editor counts text the way the Mac does, so long text in other
  languages isn't rejected after you save.
- Clearer labels for app and mouse buttons, a styled volume slider in
  Firefox, and better VoiceOver and keyboard support in sheets.

### Mac app

- Opening CmdPalm while it's already running shows its settings.
- Deck buttons that control other apps through AppleScript now get a proper
  permission prompt.
- Devices are removed with **Remove** everywhere, and VoiceOver no longer
  reads the secret pairing code from the QR code.
- If the server can't start, the menu bar says so instead of staying on
  "Starting…".

## [0.1.0] - 2026-10-09

The first release.

### Trackpad

- Move, tap to click, two-finger tap to right-click, touch and hold to drag,
  tap-then-drag and optional drag lock.
- Two-finger scrolling with native scroll phases and momentum, so apps scroll
  the way they do with a real trackpad. Pinch to zoom.
- Three- and four-finger swipes and taps, each assignable to any action.
- Click buttons and a scroll strip for one-handed use.
- Smooth pointer motion: the Mac paces movement between network packets, so
  the cursor glides instead of stepping, even on busy Wi-Fi.
- A wider trackpad in landscape, with the controls moved to the sides.

### Keyboard

- A full Mac keyboard that shows the labels of the Mac's current input source,
  including option-layer characters and dead keys.
- Sticky, lockable modifiers and shortcuts that always arrive as one combo,
  even on a slow network.
- Multi-touch keys: hold several at once for any combination, and touches
  between keys still land on the nearest one.
- Custom keyboards with only the keys you need: keys, shortcuts, modifiers,
  media keys and mouse buttons on a grid you arrange, with an optional
  trackpad. Starts with presentation, game and editing layouts.
- Key repeat that follows the Mac's repeat speed.
- Live typing with autocorrect and dictation from the phone keyboard, or send
  text as Unicode, keystrokes, or a paste.

### Deck, apps and media

- A deck of buttons for keys, text, apps, websites, system actions, Shortcuts,
  mouse clicks and multi-step sequences. Shell commands are available once you
  allow them on the Mac.
- Launch, switch, hide and quit Mac apps with their real icons, including
  apps in folders you add, such as one on an external drive.
- Media and volume controls.

### Voice

- Talk into the phone and the Mac types it, using on-device speech recognition
  where the Mac supports it.

### Mac app

- Menu bar app with pairing by QR code, PIN or approval on the Mac. The QR
  code can hold the Mac's name or its IP address, for phones that can't open
  `.local` names.
- Remembered devices with rename and remove, and a pause switch that also
  stops text still being typed and buttons still running.
- Encrypted connections with a certificate generated on your Mac.
- Automatic updates with release notes.
- Notices the Accessibility permission as soon as you grant it, without a
  relaunch.

### Phone and tablet

- Works in Safari, Chrome, Firefox and Samsung Internet, with instructions
  for adding CmdPalm to the home screen in each, plus a full-screen button
  where the browser supports it. On Android, CmdPalm installs as an app over
  the encrypted connection.
- Your settings, custom keyboards and gestures are kept on the Mac for each
  device, so they survive a cleared browser, and you can copy them from
  another device.

[Unreleased]: https://github.com/rahatsagor/CmdPalm/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/rahatsagor/CmdPalm/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/rahatsagor/CmdPalm/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/rahatsagor/CmdPalm/releases/tag/v0.1.0
