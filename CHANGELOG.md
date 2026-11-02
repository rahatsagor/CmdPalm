# Changelog

All notable changes to CmdPalm are recorded here. The release workflow turns
each section into the GitHub release notes and the in-app update notes, so
write entries for people using the app.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Mac app

- If the list of paired devices can't be read when CmdPalm opens, the
  settings each device kept on the Mac are no longer deleted with it.
- A saved deck CmdPalm can't use, for example one from a newer version, is
  set aside instead of being overwritten by the next change.
- HTTPS keeps working on a Mac that stays on for months. CmdPalm renews its
  certificate while it runs, tries again a minute after a failure instead of
  waiting for a restart, and replaces certificate files that don't match.
- Phone settings the Mac couldn't save, for example because the disk is
  full, now show an error on the phone instead of being lost at the next
  restart.
- Renaming a device in Settings also shows the new name for a device that is
  connected right now.
- After an app launches or a drive is connected, the app list and its icons
  share one look through your app folders instead of each starting its own.
- Turning shell commands off also stops the ones still running.
- A device paired while the disk was full is saved once there is room
  again, instead of being forgotten when CmdPalm next opens.
- Open at Login asks you to move CmdPalm to the Applications folder when it
  was opened from the disk image, instead of adding a login item that opens
  nothing after a restart.

### Deck, apps and media

- A deck change made while the Mac is busy is undone on the phone with a
  message, instead of showing a change the Mac never saved.
- Dragging a button to a new place is saved even when you tap Done or switch
  tabs before lifting your finger.
- Lock Screen, Sleep and Display Sleep buttons that were waiting for typing
  to finish no longer run if you pause CmdPalm meanwhile.
- Shortcuts whose names start with a hyphen run instead of failing.
- Renaming a custom keyboard and then tapping Duplicate keeps the new name.
- Duplicate in the button editor keeps the changes you just made, for the
  button and its copy.
- A button the Mac can't read, for example from a phone page left open
  across an update, says so instead of seeming to work.

### Keyboard and voice

- The Caps Lock key on the Mac keyboard lights up while Caps Lock is on,
  whether it was turned on from the phone or on the Mac itself, so capitals
  never come as a surprise. Custom keys that send Caps Lock light up too.
- Text typed as key presses comes out as written while Caps Lock is on,
  instead of all in capitals.
- A key another device is holding down, such as Delete, still works when
  you tap it or dictation corrects a word.
- In shortcut fields, Esc on a hardware keyboard picks the Escape key instead
  of closing the editor, Tab moves on to the next control, and the Shift a
  character like "?" needs no longer sticks to the next key you type.
- A key held down on an iPad keyboard keeps working after the connection
  drops and comes back.
- Dictation stops with a message when a call, Siri or another app takes the
  microphone, instead of looking active while nothing is heard. Stopping and
  starting it quickly no longer leaves audio open in the background.
- Long text copied from the Mac is cut to the size the phone can send back,
  so it can be pasted on the Mac again in any language.

### Trackpad

- Scrolling momentum stops when the phone disconnects or lets go of
  everything, instead of gliding on for up to four seconds.
- Games and apps that read raw mouse movement keep getting it while the
  pointer is pushed against the edge of the screen.
- When two devices scroll or zoom at once, one can no longer end the
  other's gesture early.

### Phone and tablet

- Keys on the Mac keyboard and custom keyboards no longer look pressed after
  you lock the phone or switch apps mid-press.
- The volume slider follows the Mac again after you switch tabs mid-drag.
- The click buttons, the keys above the phone keyboard and the modifier keys
  work with a keyboard and with VoiceOver and TalkBack. A hardware keyboard
  no longer also sends Return or Space to the Mac when it presses a button
  on the phone.
- The screen stays on while you wait for the Mac to approve a new device,
  and CmdPalm asks again to keep it on if the system lets go while it's open.
- Forgetting a Mac also clears its app list.

### Privacy and security

- The Mac refuses requests with a repeated Host or Content-Length header,
  which a proxy in front of it could read differently.
- Links that open a terminal or connect to a file server, such as `ssh:`
  and `smb:`, need shell commands turned on, like links to files.

## [0.5.2] - 2026-10-31

A round of fixes that keep input in order and every device responsive.
Pasted text arrives before the keys you press after it, other phones keep
working while a long text is typed, the phone follows the Mac's keyboard
layout right away, and deck and media buttons work with a keyboard and
screen readers.

### Mac app

- Switching the Mac's keyboard layout, say from U.S. to German, updates
  the keys on the phone right away, even while you use another app. Before,
  the phone could keep the old layout until CmdPalm was next opened.
- The QR code and PIN in Settings keep renewing even when they were
  refreshed in the last second before they expired.
- Importing a deck checks the file's size before reading it, so picking a
  very large file by mistake no longer stalls the app.
- Quitting CmdPalm and opening it again straight away leaves it running.
  The new copy could hand over to the one that was quitting, and then both
  were gone.
- Saving the deck or pairing a device no longer holds up the other
  connected devices while the change is written to disk.

### Deck, apps and media

- Pausing CmdPalm also stops what a shell command left running in the
  background, such as `cmd &` or `nohup`.

### Keyboard and voice

- Text that is pasted always arrives before the keys you press after it.
  Pressing Return right after a paste could send a message before the text
  was in it.
- While a long text is typed as key presses, other phones and tablets keep
  working. Their keys, clicks and releases go through at once instead of
  waiting for the typing to finish.
- Tapping the microphone off and straight back on no longer cancels the new
  dictation without a word.

### Phone and tablet

- When the Mac is asleep or out of reach, the app shows its "can't reach
  your Mac" screen sooner, instead of waiting on files it already has.
- Holding rewind or fast forward keeps going when another finger taps the
  same button.
- Holding an app in **Apps** and switching tabs no longer opens that app's
  menu over the other tab.
- Deck buttons and media buttons work with a keyboard and with VoiceOver
  and TalkBack.
- On iPhone, haptics keep working after a button disappears while your
  finger is on it, for example when you switch tabs mid-press.

### Privacy and security

- Wrong PINs from another device on the network no longer block pairing by
  approval on the Mac.
- Behind a reverse proxy that adds to the `X-Forwarded-Host` and
  `X-Forwarded-Proto` headers, CmdPalm uses the values the proxy added, not
  ones the phone sent.
- A device you remove on the Mac can't sneak back in by reconnecting at the
  moment it is removed.

## [0.5.1] - 2026-10-30

CmdPalm has a new Mac icon made for Liquid Glass, and a round of fixes.
Deck buttons always act on the button you touch and run their steps in
order, dictation keeps your last phrase, and several phones on the same
Wi-Fi can connect at once. Thank you for the bug reports that led to many
of them.

### Mac app

- The Mac app icon uses Liquid Glass on macOS 26 and later, with dark,
  clear and tinted appearances. Its shape and spacing line up with other
  icons in the Dock and Finder, including on macOS 15. The icon on the
  phone's home screen and in the browser matches it.
- The "CmdPalm is available" note in the menu goes away once you've seen
  the update, even if you skip it or choose to be reminded later.
- Changing a server setting no longer shows CmdPalm as off for a moment
  while the server restarts.
- Quitting CmdPalm right after it pastes text puts back what was on your
  clipboard.

### Deck, apps and media

- Tapping or holding a deck button always acts on that button. After you
  switched tabs, the deck could show one page while acting on another, so a
  tap could run, and a hold could edit, the button in the same spot on the
  other page. Editing a button you added could open **Play / Pause** or an
  empty editor instead. The deck also comes back on the page you left it on.
- Saving, deleting or duplicating a deck button acts on that button even if
  another device changes the same page while its editor is open. The page
  editor closes if another device deletes the page, instead of changing a
  different one.
- When the phone isn't connected, a deck button's editor stays open with
  your changes, so you can save them once it reconnects, and **Add page**
  no longer opens a page that was never saved.
- The row of deck page names scrolls to keep the selected page in view.
- A deck button's steps run in order. Opening an app or link, or running a
  shortcut or shell command, now waits for the keys and text before it, so
  text no longer lands in the app that just opened and a shortcut reads
  what ⌘C copied.
- Links pasted with a space before or after them open, instead of being
  refused as a kind of link that isn't allowed.

### Keyboard and voice

- On Android and in desktop browsers, tapping a key while editing a custom
  keyboard opens **Edit key** for that key, instead of a **New key** sheet
  that couldn't delete it.
- Dictation keeps your last phrase when you tap the microphone off and on
  again quickly, and a short dictation right after another is no longer cut
  off before its text arrives.

### Phone and tablet

- Several phones and tablets on the same Wi-Fi can connect at once over
  IPv6. They shared one connection limit, so loading the app on one could
  leave another unable to connect.

## [0.5.0] - 2026-10-28

The trackpad feels more like a Mac's. Pinch to zoom smoothly and turn two
fingers to rotate, with smart zoom and three-finger drag if you want them.
Haptics work on iPhone again, the full Mac keyboard can fill a phone held
upright, and CmdPalm tells you plainly when it can't reach your Mac. Thank
you to everyone who tried CmdPalm and shared ideas; several of them are in
this release.

### Trackpad

- **Smooth zoom.** Pinching zooms the way a Mac trackpad does, in apps that
  support it, such as Safari, Photos, Preview and Maps. To keep pressing
  ⌘+ and ⌘− instead, choose it under **Pinching** in the advanced settings.
- **Rotate.** Turn two fingers to rotate photos, maps and PDFs.
- Zooming and rotating start as soon as your fingers move, even when you
  pinch or turn around one finger that stays still, while two-finger
  scrolling stays a scroll.
- **Smart zoom**, if you turn it on: double-tap with two fingers to zoom in
  on a web page or PDF, and again to zoom back out. It's off at first,
  because right-clicks then wait a moment to see whether a second tap
  follows.
- **Three-finger drag**, in the advanced settings, drags windows and
  selects text with three fingers, like the Mac's accessibility option.
  Three-finger swipes turn off while it's on.
- Pinch your thumb and three fingers together to show your apps, or spread
  them to show the desktop. Pinching and spreading with three or four
  fingers can do any action under **Gestures**.
- **Scroll strip at the screen edge** puts the scroll strip right against
  the edge of the screen. Slide a finger along the side of the phone, or
  the edge of its case, to scroll without looking.
- **Scroll strip width** makes the strip wider and easier to hit.
- The setting that hides the Click and Right-click buttons is now called
  **Show click buttons**, so it's easier to find.

### Keyboard

- **Sideways keyboard** shows the full Mac keyboard across the whole screen
  of a phone held upright, turned on its side and without the trackpad.
  Turn the phone to type with landscape-sized keys, even with rotation
  locked. Switch it on in the phone's settings or with the button next to
  **Mac** on the Keyboard tab.

### Deck, apps and media

- A deck button whose shell command fails now says why, such as "command
  not found", instead of seeming to do nothing. A button waits up to a
  second and a half for its command, so the steps after it run once it's
  done.
- Shell commands typed on an iPhone keep plain quotes and dashes. iOS
  turned `"` into `“` and `--` into `—` as you typed, which broke longer
  commands while short ones like `say test` still worked.
- A new **Look Up** Mac action looks up the word under the pointer, for a
  gesture or a deck button.

### Phone and tablet

- **Haptics work on iPhone again.** iOS 26.5 stopped playing the haptics
  CmdPalm asked for and now plays one only when you tap something made to
  give one. The trackpad, keys, click buttons and deck buttons are now
  built that way, so you feel taps, clicks and key presses. Swipes and long
  presses still can't be felt on iPhone.
- **Key press haptics**, in the phone's settings, turns the tap you feel on
  each key press on or off without turning off other haptics.
- **A clear screen when the Mac is away.** When the Mac is asleep, off or on
  another network, CmdPalm says it can't reach it, lists what to check and
  offers **Try again**, instead of a spinner or a blank page. It reconnects
  by itself as soon as the Mac is back, and the same screen covers the app
  if the connection is gone for a while.
- With the encrypted connection, the home screen app keeps a copy of itself
  and a small offline page, so it opens even the first time the Mac can't
  be reached.

### Fixes

- An app you quit from the **Apps** tab leaves the **Open** list right
  away, even when the Mac takes a moment to finish quitting it.
- Editors that slide up from the bottom, such as the ones for naming a deck
  page or a button, stay above the phone's keyboard, so you can see what
  you type. The field you're typing in scrolls into view, and the phone no
  longer offers to fill in a contact while you name things.
## [0.4.0] - 2026-10-24

A smoother pointer and a keyboard that knows its left from its right. The
pointer glides evenly at high speeds, the right ⌘, ⌥ and ⇧ keys reach the
Mac as themselves for hyper keys and other tools that tell them apart, and
the deck fills wide screens with a button size you choose.

### Trackpad

- The pointer glides on through a Wi-Fi packet that arrives a little late,
  instead of stopping and then catching up. This is most noticeable with a
  high pointer speed.
- Pointer acceleration eases in and out instead of switching on at a fixed
  finger speed, and fast pointer speeds smooth out uneven touch timing, so
  the pointer no longer surges and hitches as you speed up and slow down.

### Keyboard

- The right ⌘, ⌥ and ⇧ keys on the Mac keyboard now press the right-side
  keys on the Mac when you tap, double-tap or hold them, so apps that tell
  the sides apart work from the phone. For example, a Raycast hyper key set
  to right ⌘. Each side lights up on its own.
- Custom keyboards can have right-side ⌃, ⌥, ⇧ and ⌘ keys.

### Deck, apps and media

- The deck uses the space on wide screens. A page's columns are what a phone
  held upright shows; a phone turned sideways or a tablet fits more buttons
  of the same size instead of a few huge ones.
- **Settings → Deck → Button size** makes deck buttons smaller, to fit more
  on a page, or larger, on this device only.
- Deck button labels and icons scale with the button. Labels on narrow
  buttons no longer break in the middle of a word, and the smallest buttons
  show just their icon.

### Phone and tablet

- Vibration on Android phones is strong enough to feel: the shortest taps
  were too brief for many phone motors. A deck button or gesture that fails
  now buzzes twice.
- Haptics on iPhone and iPad (iOS 18 and later) are set up the way the
  earlier WebPad's were.

### Fixes

- An app you quit from the **Apps** tab no longer stays in the **Open**
  list until you refresh it.
- When you set up a keyboard shortcut, the key it uses, such as the C in
  ⌘C, shows as chosen in the key field instead of looking like a hint.
## [0.3.2] - 2026-10-20

A steadier CmdPalm. Pause stops a deck button at once, a held key or drag
survives a weak moment on Wi-Fi, and the phone no longer loses changes or
gets stuck while it reconnects. Other devices on the network also have
fewer ways to get in the way.

### Fixes

- **Pause** and disconnecting now stop a deck button's remaining shortcuts
  and clicks at once, instead of after the whole sequence has played.
- A held key, drag or modifier is no longer let go when one of the phone's
  check-ins arrives late. If the phone really drops off the network, a held
  key still stops repeating within 3 seconds.
- Changing a setting while CmdPalm restarts its server, such as turning off
  shell commands, is no longer undone when the restart finishes.
- After you rename the Mac, or it gets a new name when it joins a network,
  the QR code and the encrypted connection use the new name without
  restarting CmdPalm.
- Starting voice typing again right after stopping it could type old text
  or leave speech recognition running on the Mac.
- Momentum scrolling no longer jumps after the Mac was busy typing, and a
  scroll from a second device properly ends the first one.
- **Open Settings** for Accessibility works when the permission was turned
  off while CmdPalm was running.
- Saving the certificate in **Settings → Phone Setup** says so if it fails.
- Problems found while loading saved files at launch now appear in the logs.

### Phone and tablet

- Deck changes made while the phone is reconnecting are no longer shown and
  then quietly lost. The phone says the change wasn't saved.
- Voice typing can no longer start while the phone is reconnecting and then
  stay stuck listening.
- The Apps tab no longer keeps loading when you open it while the phone
  reconnects, and it refreshes after a reconnect.
- With **Tap, then drag** on, a tap followed quickly by a two-finger
  gesture no longer loses the click.
- After locking the phone mid-press, modifiers, click buttons and media keys
  no longer stay held on screen or block the next press.
- A setting changed just before you close CmdPalm is saved.

### Privacy and security

- A device that asks for approval and leaves before you answer now has to
  wait after a few tries, like one you decline, so it can't flood the Mac
  with prompts.
- The Mac refuses requests that carry a body, so a second request can't be
  hidden inside one that passes through a proxy on the Mac.

### Other ways to connect

- A reverse proxy that connects to CmdPalm over IPv6 (`::1`) gets the higher
  connection limit meant for proxies.
- `X-Forwarded-For` entries that include a port are understood.

## [0.3.1] - 2026-10-17

Pick the scroll strip you like: the new short handle, the long strip from
earlier versions, or none at all.

### Trackpad

- **Scroll strip** under **Settings → Scrolling & zoom** now offers Short,
  Long and Hide. Long brings back the full-height strip, which scrolls only
  while your finger moves. Short is the handle from 0.3.0 that keeps
  scrolling while you hold it at either end.
- Which side the strip is on is now its own setting, **Scroll strip side**,
  in the advanced settings. A strip you had hidden or moved to the left
  stays that way.

## [0.3.0] - 2026-10-17

Scroll long pages with one thumb, and a crash on macOS 27 is fixed. The
scroll strip gets a shorter handle that keeps scrolling while you hold it,
the keyboard's return key no longer turns into an emoji, and every download
can now be checked against the source it was built from.

### Trackpad

- The scroll strip is now a short handle with arrows, so it no longer looks
  like a menu button. Drag it to scroll, or drag it to the top or bottom of
  the trackpad and hold it there to keep scrolling, faster the further you
  go. Turn this off with **Hold to keep scrolling** in the advanced settings.

### Fixes

- CmdPalm could crash on macOS 27 when an app that reads the screen through
  accessibility, such as Screenpipe, looked at the pairing PIN in the welcome
  guide, the menu or Settings.
- The return key on the phone's keyboard showed an emoji on iPhone and iPad.
  It now shows the ⏎ symbol, like the other keys. Home and End in shortcut
  labels use ⇱ and ⇲ for the same reason.
- The F8 key now tells screen readers it plays and pauses.

### Privacy and security

- Every release file now has a signed build attestation, which proves it was
  built by this repository's release workflow and from which commit.
  [SECURITY.md](https://github.com/rahatsagor/CmdPalm/blob/main/SECURITY.md#updates)
  shows how to check a download.

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

[Unreleased]: https://github.com/rahatsagor/CmdPalm/compare/v0.5.2...HEAD
[0.5.2]: https://github.com/rahatsagor/CmdPalm/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/rahatsagor/CmdPalm/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/rahatsagor/CmdPalm/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/rahatsagor/CmdPalm/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/rahatsagor/CmdPalm/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/rahatsagor/CmdPalm/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/rahatsagor/CmdPalm/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/rahatsagor/CmdPalm/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/rahatsagor/CmdPalm/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/rahatsagor/CmdPalm/releases/tag/v0.1.0
