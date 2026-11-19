# Contributing

Thanks for helping. CmdPalm takes bug reports and ideas as
[issues](https://github.com/rahatsagor/CmdPalm/issues/new/choose), and does
not accept pull requests. A clear report lets fixes ship quickly, and keeps
every change consistent with the rest of the app.

The most useful reports include:

- what you did, what you expected and what happened instead,
- the CmdPalm version, the Mac and its macOS version,
- the phone or tablet, its browser, and whether you opened CmdPalm from the
  home screen,
- the logs from `~/Library/Logs/CmdPalm`. They never contain what you type.

Report security problems privately, as described in [SECURITY.md](SECURITY.md).

The rest of this page explains how to build and change CmdPalm yourself, for
example in your own fork.

## Setup

- macOS 15 or later on Apple silicon, with the latest Xcode
- [Rust](https://rustup.rs) (stable)
- [Bun](https://bun.sh) 1.4.4 or later (for the scoped dependency overrides)
- [XcodeGen](https://github.com/yonaskolb/XcodeGen): `brew install xcodegen`

CI and releases use Rust stable, Bun's latest stable release, and the newest
stable Xcode installed on GitHub's `xcode-27` image. That runner image is
currently in public preview; beta Xcode compilers are excluded. Rust and phone
client dependencies use the committed lockfiles. Action code is pinned to
verified commits, with Dependabot proposing updates weekly. Keep TypeScript
on version 6 until the Vue type checker supports version 7.

```sh
scripts/build-app.sh --debug    # build/Debug/CmdPalm.app
scripts/build-app.sh            # build/Release/CmdPalm.app
```

The app build also generates `Contents/Resources/ThirdPartyNotices.txt` from
the resolved Rust and phone dependencies. Rust sources must be fetched first;
notice generation itself runs offline. A dependency without notice text stops
the build. For crates whose published archive omits their license, keep a
versioned copy from the exact upstream VCS commit in `packaging/licenses/rust/`,
with its source URLs and hashes in `SOURCES.json`. Sparkle's pinned release
license is kept in `packaging/licenses/`. The About pane opens the bundled
notices, and packaging refuses an app without them.

### Dependency security fixes

The phone's test utilities currently need scoped overrides for
`js-beautify > glob` and `editorconfig > minimatch`. These select patched
upstream releases without replacing unrelated dependencies. The Bun tests in
`scripts/tests/dependencies.test.ts` exercise their real formatting and
EditorConfig call paths. Run `bun audit` in `web/` after dependency changes.
Remove the overrides once compatible upstream dependency ranges include the
fixed versions.

`vendor/askama_derive` is the published 0.16.1 source with a small config-parser
patch: `toml` 1.1 replaces the unmaintained `basic-toml`. Its `NOTICE` and
`UPSTREAM.json` record the change, upstream commit and crate checksum. Cargo
uses this copy through `[patch.crates-io]`; it remains a third-party dependency
in bundled notices. Remove the patch when Askama ships a compatible fix.
To check the vendored parser and template behavior directly:

```sh
cargo test --manifest-path vendor/askama_derive/Cargo.toml --lib --target-dir target/vendor-askama
```

To work in Xcode, generate the project once and open it. The build runs the
Rust and web steps for you.

```sh
cd apple && xcodegen generate && open CmdPalm.xcodeproj
```

### Keeping the Accessibility permission

macOS ties the Accessibility permission to the app's code signature. Ad-hoc
signatures change with every build, so you would have to grant the permission
again after each one. Create a local self-signed identity once and the build
scripts use it automatically:

```sh
scripts/make-signing-identity.sh
```

## Layout

| Path | What it is |
| --- | --- |
| `core/` | Rust library: input engine, server, pairing, deck. Exposed to Swift with [UniFFI](https://mozilla.github.io/uniffi-rs/). |
| `core/src/input/` | Turns phone input into macOS events: key state, repeat, gestures, scroll phases and momentum. |
| `apple/` | The Mac app (SwiftUI and AppKit). `project.yml` is the source of truth for the Xcode project. |
| `web/` | The phone app (Vue, TypeScript, Tailwind). The Mac serves the built files from inside the app bundle. |
| `scripts/` | Build, packaging and release tooling. |
| `packaging/` | The Homebrew cask template and files that go into the DMG. |
| `docs/` | The [wire protocol](docs/PROTOCOL.md) between the phone app and the Mac, and the README's images in `docs/media/` (rebuild them with `scripts/readme-media.sh`). |

The Rust core owns everything that should behave the same regardless of the
UI: what a device may do, how input is posted, and how sessions start and
end. Swift handles what needs macOS frameworks (apps, audio, speech,
keyboard layouts, permissions) and talks to the core through
`HostDelegate`. Delegate calls arrive on core threads, so keep them
thread-safe and quick.

## Working on the phone app

Run a host without the Mac app, then the Vite dev server:

```sh
cargo run -p cmdpalm-core --example dev-host          # logs input instead of posting it
cargo run -p cmdpalm-core --example dev-host -- --live  # really moves the pointer
cd web && bun install && bun run dev
```

Open the pairing link the host prints, or the Vite address with the PIN.
Set `CMDPALM_NAME` to change the Mac name the phone shows.
Set `CMDPALM_HOST` if the host runs somewhere other than `127.0.0.1:8790`.

## Checks

CI runs all of these on every push.

```sh
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test

cd web
bun install
bun run lint
bun run typecheck
bun run test

cd ..
web/node_modules/.bin/oxlint scripts    # release tooling, on Bun
web/node_modules/.bin/tsc -p scripts
bun test ./scripts/tests

cd apple
xcodebuild test -project CmdPalm.xcodeproj -scheme CmdPalm -destination "platform=macOS,arch=arm64"
```

### Screen mirroring checks

The Rust suite includes a real local WebRTC handshake, encrypted media, and
late-frame rejection over a plain control WebSocket. Phone tests cover a
receive-only client without a secure context or microphone APIs, stale
answers, backgrounding, cached-page deactivation, revocation, and reconnects.
Approval tests cover remembered and temporary grants, expiry, cancellation,
re-pairing, lock/sleep, pause, and reconnect rate limits. HD checks include a
real encrypted data-channel transfer with backpressure and ordered bounded
picture reconstruction. The native suite round-trips one-pixel RGB detail
through the production PNG encoder.

The optional hardware test verifies the production encoder using a generated
gray pixel buffer. It checks first-frame output without feeding a second
frame, negotiated H.264 profiles, and receiver level limits. It does not
capture a display or request screen permission. Run it on an Apple-silicon Mac:

```sh
cd apple
CMDPALM_TEST_HARDWARE_VIDEO=1 TEST_RUNNER_CMDPALM_TEST_HARDWARE_VIDEO=1 \
  xcodebuild test -project CmdPalm.xcodeproj -scheme CmdPalm \
  -destination "platform=macOS,arch=arm64" \
  -only-testing:CmdPalmTests/DisplayHardwareEncoderSmokeTests
```

For manual browser transport checks without real screen content, build the
web client and use a synthetic all-IDR H.264 fixture with AUDs:

```sh
ffmpeg -f lavfi -i 'testsrc2=size=640x360:rate=60' -t 2 -an \
  -c:v h264_videotoolbox -profile:v baseline -bf 0 -g 1 -b:v 3M \
  -pix_fmt nv12 -bsf:v h264_metadata=aud=insert -f h264 /tmp/display-test.h264
CMDPALM_DISPLAY_FIXTURE=/tmp/display-test.h264 CMDPALM_DISPLAY_FPS=60 \
  cargo run -p cmdpalm-core --example display-smoke
```

This temporary host prints a pairing URL and grants its paired devices access
to its synthetic display automatically. It never captures the Mac or posts
real input. Test through a LAN IP address rather than `localhost` to exercise
an actual insecure HTTP origin. Browser and synthetic tests do not replace
hands-on iPhone/iPad/Android, multiple-monitor, lock/sleep, and power testing.
For HD text checks, set `CMDPALM_DISPLAY_IMAGE` to a PNG fixture up to 4K and
16 MiB before starting the helper. It sends that generated picture at one
update per second when HD text is selected. Check readability while zoomed,
fullscreen entry/exit, stopping, switching modes, and background cleanup.
Check fullscreen keyboard entry and exit, then rotate between portrait and
landscape while viewing. Hidden navigation must remain inaccessible, and
normal controls must work again after Exit or Stop.

For capture lifecycle changes, overlap display-list refreshes with monitor
change notifications while a view is active. Also stop a capture while it is
starting and verify that late frames or stopped-status callbacks cannot end
the replacement view. These checks require an explicitly authorized local
capture session; the synthetic transport host does not exercise ScreenCaptureKit.

## App icon

The icon combines a phone, the Mac Command key and a touch point. The Mac
app uses [`apple/CmdPalm/AppIcon.icon`](apple/CmdPalm/AppIcon.icon), an Icon
Composer document with editable SVG layers in its `Assets/` directory. Open
it with **Xcode > Open Developer Tool > Icon Composer** to adjust the glass,
colors and appearance variants. The Command symbol uses filled outlines so
its loops stay open when Icon Composer applies a different fill.

Keep the native layers on their full 1024px canvas without an outer corner
mask, padding or baked shadows. Xcode supplies the final icon shape and
spacing, compiles the layered icon for macOS 26 and later, and generates
the fallback images for macOS 15. Preview Default, Dark and Mono (clear and
tinted) appearances, both design generations, and small sizes before
committing changes. Do not add a second `AppIcon` inside `Assets.xcassets`.

The browser and phone home-screen icons are built from the same layers, so
there is only one design to edit. After changing a layer, regenerate them:

```sh
brew install librsvg
scripts/icons.sh
```

The script reuses each layer's shapes and adds the web icon's own
gradients and shadows. It restyles the layers by their fill colors and
stops with an error if one is missing, so update the colors in
`scripts/icons.sh` along with the layers when you change them. Commit the
layers and the generated files in `web/public/` together. The web SVG keeps
its rounded background; phone home-screen PNGs use square artwork for the
platform mask. Normal app builds compile `AppIcon.icon` and use the
committed web assets, so they do not need librsvg or a separate icon export.

## Guidelines

- **Protocol changes** touch three places: `core/src/protocol.rs`,
  `web/src/lib/protocol.ts` and `docs/PROTOCOL.md`. Keep them in sync, and
  bump `PROTOCOL_VERSION` for changes old clients can't handle.
- **Input handling** is the heart of the app. Changes to `core/src/input`
  need tests that show the exact events posted, including what happens when
  messages are lost or a device disconnects mid-press.
- **Never log what people type**, say or copy. Log events and errors, not
  content.
- **Write for the person using the app.** Messages say what happened and what
  to do next, without jargon. Organize settings by feature, keep common options
  first, and show each section without collapsible groups.
- **Changelog.** Add user-facing changes to the `Unreleased` section of
  `CHANGELOG.md`.

Tagged releases run the same CI checks before building and packaging the
app. Publishing requires matching Sparkle keys and the permanent code signing
identity configured in GitHub Actions; local builds and forks do not need
release secrets. Downloads become public only after the draft release has all
its files.

CmdPalm is released under the
[GNU Affero General Public License v3.0](LICENSE).
