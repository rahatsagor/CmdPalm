# Wire protocol

The phone app and the Mac talk over one WebSocket. This page describes
protocol version **1**. The definitions live in
[`core/src/protocol.rs`](../core/src/protocol.rs) and are mirrored in
[`web/src/lib/protocol.ts`](../web/src/lib/protocol.ts).

## Transport

The Mac listens on one TCP port (8790 by default, or the next free port if
that one is taken). The same port serves plain HTTP and TLS; the server looks
at the first byte of each connection to tell them apart.

| Path | Purpose |
| --- | --- |
| `/` and other paths | The phone app (static files). |
| `/ws` | The WebSocket. The `Origin` header, when present, must match `Host`. |
| `/api/info` | `{"name", "version", "protocol", "secure"}`. No authentication. |
| `/api/icon?id=<bundle id>&size=<px>&k=<session key>` | App icon as PNG, 64 to 512 px. Needs the `sessionKey` from `welcome`. |
| `/cmdpalm.crt` | The Mac's certificate authority (DER), for installing on the phone. |

Only `GET` and `HEAD` are accepted. The `Host` header must be present and be
an IP address, `localhost` or a `.local` name; anything else gets `421`, so a
website can't reach the server through DNS rebinding. Messages are limited to
1 MiB.

Text frames carry JSON objects with a `t` field naming the message type.
Field names are camelCase. Pointer data uses binary frames.

## Session

```text
phone                          Mac
  │ hello ───────────────────▶ │
  │                            │  checks token / code / PIN,
  │ ◀─────────────── pending   │  or asks the person at the Mac
  │ ◀── welcome  (or denied)   │
  │ ping ──▶  ◀── pong         │  every 2 s
  │ input, actions ──▶         │
  │ ◀── state updates          │
  │ ◀── bye                    │  disconnected, removed, shutting down
```

The first message must be `hello`, within 10 seconds:

```json
{
  "t": "hello",
  "v": 1,
  "device": { "id": "uuid", "name": "Living room iPhone", "model": "iPhone" },
  "auth": { "method": "token", "token": "…" },
  "remember": true
}
```

`device.id` is a stable random ID of up to 128 printable ASCII characters
without spaces; the phone app uses a UUID. Other IDs are `denied` as
`incompatible`.

`auth.method` is one of:

| Method | Fields | Meaning |
| --- | --- | --- |
| `token` | `token` | Reconnect with the token issued at pairing. |
| `pair` | `code` | The single-use code from the QR link (`/#pair=<code>`). |
| `pin` | `pin` | The six-digit PIN shown on the Mac. It works only while the Mac shows it, and for three minutes after. |
| `approve` | | Ask the person at the Mac to accept. The Mac replies `pending` and waits up to two minutes. |

On success the Mac sends `welcome`:

| Field | Meaning |
| --- | --- |
| `v` | Protocol version. |
| `host` | `{name, version, os}`. |
| `sessionKey` | Short-lived key for `/api/icon`. |
| `token` | Present after a new pairing with `remember: true`. Store it and use it for `token` auth. |
| `features` | `{voice, shell, secure, permission}`: voice typing available, shell commands allowed, connection is TLS, Mac has Accessibility permission. |
| `deck` | The current deck (see below). |
| `layout` | The Mac's keyboard layout, if known. |
| `volume` | `{value: 0–1, muted}`, if the output device has a volume control. |
| `paused` | Input is paused on the Mac. |
| `settings` | `{settings, updatedAt}`: the settings this device saved with `settingsSave`, if the Mac has any (see [Phone settings](#phone-settings)). |

Otherwise the Mac sends `denied` and closes the connection:

| `reason` | Meaning |
| --- | --- |
| `unknown` | The token is unknown or was revoked. Pair again. |
| `wrongPin` | The PIN is wrong, or it changed since the phone saw it. |
| `pinClosed` | The PIN isn't shown on the Mac right now. Open the CmdPalm menu on the Mac and try again. Not counted as a wrong attempt. |
| `expiredCode` | The QR code is wrong, expired or already used. |
| `rejected` | The person at the Mac declined or didn't answer in time, or this pairing method is turned off. |
| `blocked` | Too many wrong PINs, or too many declined approval requests. `retryAfter` gives seconds to wait. |
| `busy` | Too many approval requests are already waiting. |
| `incompatible` | Unsupported protocol version or invalid device info. |

The phone sends `ping` (`{"t":"ping","id":n}`) every two seconds and the Mac
answers `pong` with the same `id`. A connection silent for 8 seconds is
treated as gone, and everything that device was holding (keys, buttons) is
released.

## Phone → Mac

### Input

Key codes are macOS virtual key codes (ANSI positions, `kVK_*`). Modifiers are
a bitmask:

| Bit | Modifier |
| --- | --- |
| 1 | Command |
| 2 | Shift |
| 4 | Option |
| 8 | Control |
| 16 | Fn |

| Message | Fields | Meaning |
| --- | --- | --- |
| `key` | `code`, `down`, `mods`, `repeat` (default true) | Press or release a key. `mods` are held only around this key. The Mac repeats held keys at its own repeat rate unless `repeat` is false. |
| `tap` | `code`, `mods` | Press and release as one combo. Use this for shortcuts so a lost packet can't leave a modifier stuck. |
| `button` | `button`, `op`, `mods` | Mouse button `left`, `right`, `middle`, `back` or `forward`; `op` is `down`, `up` or `click`. |
| `media` | `key`, `op` | `volumeUp`, `volumeDown`, `mute`, `brightnessUp`, `brightnessDown`, `playPause`, `next`, `previous`, `fastForward`, `rewind`, `illuminationUp`, `illuminationDown`, `illuminationToggle`. |
| `text` | `text`, `mode` | Type text, up to 64 KiB. `mode` is `unicode` (default), `keystrokes` (real key presses through the Mac's layout) or `paste`. |
| `edit` | `delete`, `insert` | Delete characters before the caret (at most 4 096), then type `insert` (up to 64 KiB). Used for live typing and autocorrect. |
| `release` | | Release everything this device holds. |

### Binary frames

Little-endian. The first byte is the type.

| Byte | Layout | Meaning |
| --- | --- | --- |
| `0x01` | `dx: f32, dy: f32` | Move the pointer by this many points. |
| `0x02` | `phase: u8, dx: f32, dy: f32` | Scroll by pixels. Phases: 1 began, 2 changed, 4 ended, 8 cancelled. |
| `0x03` | `vx: f32, vy: f32` | Fingers lifted while scrolling at this velocity (px/s). The Mac continues with momentum. |
| `0x04` | | A finger touched the surface; stops momentum. |
| `0x10` | `pcm: i16…` | Microphone audio for voice typing: 16 kHz, mono. |

### Actions

`{"t":"action","action":{…},"id":n}` runs an action. If `id` is given, the Mac
answers with `actionResult` (`{id, ok, message?}`). A failed action without an
`id` still gets an `actionResult`, with no `id`. Actions are the same objects
deck buttons store, tagged by `kind`:

| `kind` | Fields |
| --- | --- |
| `keys` | `code`, `mods`, `char` (optional letter, so the shortcut follows the key with that label on non-QWERTY layouts) |
| `text` | `text`, `enter` |
| `media` | `key` |
| `app` | `id` (bundle identifier), `op`: `open`, `toggle`, `hide`, `quit` |
| `url` | `url`. `javascript:` and `data:` are refused; `file:` only works while shell commands are allowed |
| `system` | `name`, e.g. `missionControl`, `launchpad`, `lockScreen`, `screenshotArea`; see `SystemAction` |
| `shortcut` | `name` of a macOS Shortcuts automation |
| `shell` | `command`; refused unless allowed on the Mac. Pausing input stops commands that are still running. |
| `mouse` | `button`, `clicks` |
| `delay` | `ms`, up to 10 000 |
| `sequence` | `steps`: up to 64 actions, nested at most 3 deep |

### Other requests

| Message | Fields | Reply |
| --- | --- | --- |
| `apps` | | `apps` |
| `appAction` | `id`, `op` | `appsChanged` once the app responds |
| `deckSave` | `deck` | `deck` to every connected device |
| `volume` | `value?`, `muted?` | `volume` |
| `clipboardSet` | `text` | |
| `clipboardGet` | | `clipboard` |
| `voiceStart` | `locale?` | `voice` updates |
| `voiceStop` | `cancel` | final `voice` update |
| `settingsSave` | `settings`, `updatedAt` | none; a `notice` with code `settings` on failure |
| `settingsList` | | `settingsList` |
| `settingsCopy` | `from` (device ID) | `settings`, or a `notice` with code `settings` |

## Mac → phone

| Message | Fields | Sent when |
| --- | --- | --- |
| `apps` | `apps: [{id, name, running, active, hidden}]` | Answer to `apps`. |
| `appsChanged` | | Apps launched, quit, hid or changed focus. Request `apps` again if the list is visible. |
| `deck` | `deck` | The deck changed. |
| `layout` | `layout` | The Mac's input source changed. |
| `volume` | `value`, `muted` | Output volume changed. |
| `volumeUnavailable` | | The output device has no volume control (HDMI, for example). |
| `paused` | `paused` | Input was paused or resumed on the Mac. While paused, the Mac ignores input and refuses actions, text, clipboard and voice: `action` gets a failed `actionResult`, `voiceStart` gets `voice` with `unavailable`, and the others get a `notice` with code `paused`. |
| `features` | `features` | Permissions or settings changed. |
| `notice` | `level`, `code`, `message` | Something the person should know, e.g. `secureInput` when a password field blocks typing. |
| `clipboard` | `text` | Answer to `clipboardGet`. |
| `voice` | `state`, `text?`, `final`, `message?` | Voice typing: `listening`, `stopped`, `unavailable` or `error`. |
| `actionResult` | `id?`, `ok`, `message?` | Answer to an `action` with an `id`, or a failed action without one. |
| `settingsList` | `devices: [{id, name, model, updatedAt}]` | Answer to `settingsList`: other paired devices with saved settings, newest first. |
| `settings` | `settings`, `updatedAt` | Answer to `settingsCopy`: that device's saved settings. |
| `bye` | `reason`, `reconnect?` | The Mac is closing the connection, with a message to show. `reconnect: true` means the Mac stopped or restarted its server and the phone may reconnect with its token on its own; otherwise (disconnected or removed on the Mac, protocol errors) it waits for the person to reconnect. |

### Keyboard layout

```json
{
  "id": "com.apple.keylayout.ABC",
  "name": "ABC",
  "iso": false,
  "keys": [{ "code": 0, "base": "a", "shift": "A", "option": "å", "optionShift": "Å" }]
}
```

`dead` is a bitmask of levels that start a dead-key sequence (bit 0 base,
1 shift, 2 option, 3 option-shift). Their labels are for display only, and the
Mac never uses them to type a character.

## Deck

```json
{
  "version": 1,
  "pages": [
    {
      "id": "main",
      "name": "Main",
      "columns": 4,
      "tiles": [
        {
          "id": "t1",
          "label": "Screenshot",
          "icon": { "kind": "symbol", "name": "camera" },
          "color": "#3b82f6",
          "action": { "kind": "system", "name": "screenshotArea" }
        }
      ]
    }
  ]
}
```

Limits: 24 pages, 64 tiles per page, 80-character labels, IDs of up to 128
bytes, and 4 096 bytes (UTF-8) of text, URL or shell command per action. The
Mac rejects a deck that breaks these limits, and the sender gets a `notice`
explaining why.

## Phone settings

Each remembered device can keep its own settings on the Mac, so they survive
a cleared browser and can be copied to another device. The phone's own
storage stays the source of truth; the Mac stores the object as it is.

```json
{ "t": "settingsSave", "settings": { "version": 1, "settings": { "theme": "dark" }, "keyboards": [] }, "updatedAt": 1750000000000 }
```

- `settings` must be a JSON object of at most 128 KiB. Its contents are up to
  the phone; the phone app sends `{version, settings, keyboards}` and leaves
  out per-device values such as the device name.
- `updatedAt` is when the person last changed a setting, in milliseconds since
  1970. The Mac keeps a save only if it is not older than the copy it has.
- Only devices paired with `remember: true` are stored; for others,
  `settingsSave` is ignored. There is no reply on success.
- `welcome` carries the saved copy as `settings: {settings, updatedAt}`. The
  phone applies it when it is newer than its own settings and otherwise sends
  `settingsSave`.
- `settingsList` lists the other paired devices that have saved settings.
  `settingsCopy` with one of their `id`s answers with
  `{"t":"settings","settings":{…},"updatedAt":n}`. The phone applies it and
  saves it as its own with a new `updatedAt`.

These messages are allowed while input is paused.
