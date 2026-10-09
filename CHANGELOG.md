# Changelog

All notable changes to CmdPalm are recorded here. The release workflow turns
each section into the GitHub release notes and the in-app update notes, so
write entries for people using the app.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/rahatsagor/CmdPalm/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/rahatsagor/CmdPalm/releases/tag/v0.1.0
