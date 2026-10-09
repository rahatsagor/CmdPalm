#!/bin/bash
# Builds a release copy of CmdPalm.app into build/Release/.
#
#   scripts/build-app.sh [--version 1.2.3] [--debug]
#
# Environment:
#   CMDPALM_SIGN_IDENTITY  Code signing identity name. Defaults to
#                          "CmdPalm Self-Signed" when that identity exists
#                          (see scripts/make-signing-identity.sh), otherwise
#                          ad-hoc ("-").
#   CMDPALM_KEYCHAIN       Keychain holding the identity (optional).
#   CMDPALM_UPDATE_KEY     Sparkle EdDSA public key. Without it the build
#                          never checks for updates.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
CONFIGURATION=Release
VERSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="${2#v}"; shift 2 ;;
    --debug) CONFIGURATION=Debug; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$ROOT/Cargo.toml" | head -1)"
fi
if [[ ! "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]?)\.(0|[1-9][0-9]?)$ ]]; then
  echo "error: use a version like 1.2.3 with minor and patch numbers below 100 (got '$VERSION')" >&2
  exit 2
fi
# Sparkle compares build numbers, so derive one that always increases.
BUILD=$(( BASH_REMATCH[1] * 10000 + BASH_REMATCH[2] * 100 + BASH_REMATCH[3] ))

export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
for tool in cargo bun xcodegen xcodebuild; do
  command -v "$tool" >/dev/null || { echo "error: $tool is required (see CONTRIBUTING.md)" >&2; exit 1; }
done

echo "==> Building CmdPalm $VERSION ($BUILD), $CONFIGURATION"
"$ROOT/scripts/build-core.sh"
(cd "$ROOT/web" && bun install --frozen-lockfile && bun run build)
(cd "$ROOT/apple" && xcodegen generate --quiet)

DERIVED="$ROOT/build/DerivedData"
LOG="$ROOT/build/xcodebuild.log"
mkdir -p "$ROOT/build"
if ! CMDPALM_SKIP_WEB=1 xcodebuild \
  -project "$ROOT/apple/CmdPalm.xcodeproj" \
  -scheme CmdPalm \
  -configuration "$CONFIGURATION" \
  -derivedDataPath "$DERIVED" \
  -destination "platform=macOS,arch=arm64" \
  MARKETING_VERSION="$VERSION" \
  CURRENT_PROJECT_VERSION="$BUILD" \
  CMDPALM_UPDATE_KEY="${CMDPALM_UPDATE_KEY:-}" \
  build >"$LOG" 2>&1; then
  grep -E "error:" "$LOG" | sort -u | head -40 >&2 || true
  echo "error: xcodebuild failed; full log in $LOG" >&2
  exit 1
fi
grep -E "\.swift:[0-9]+:[0-9]+: warning:" "$LOG" | sort -u || true

OUT="$ROOT/build/$CONFIGURATION"
APP="$OUT/CmdPalm.app"
rm -rf "$APP"
mkdir -p "$OUT"
ditto "$DERIVED/Build/Products/$CONFIGURATION/CmdPalm.app" "$APP"

# A stable signing identity keeps the Accessibility permission across
# updates: macOS ties the permission to the signature, and ad-hoc signatures
# change with every build.
IDENTITY="${CMDPALM_SIGN_IDENTITY:-}"
KEYCHAIN_ARGS=()
if [[ -n "${CMDPALM_KEYCHAIN:-}" ]]; then KEYCHAIN_ARGS=(--keychain "$CMDPALM_KEYCHAIN"); fi
if [[ -z "$IDENTITY" ]]; then
  if security find-identity -p codesigning ${CMDPALM_KEYCHAIN:+"$CMDPALM_KEYCHAIN"} 2>/dev/null | grep -q '"CmdPalm Self-Signed"'; then
    IDENTITY="CmdPalm Self-Signed"
  else
    IDENTITY="-"
    echo "note: signing ad-hoc. Run scripts/make-signing-identity.sh so Accessibility permission survives rebuilds."
  fi
fi

sign() { codesign --force --timestamp=none ${KEYCHAIN_ARGS[@]+"${KEYCHAIN_ARGS[@]}"} --sign "$IDENTITY" "$@"; }
SPARKLE="$APP/Contents/Frameworks/Sparkle.framework/Versions/B"
# Inside-out, as Sparkle's documentation describes for re-signing.
sign "$SPARKLE/XPCServices/Installer.xpc"
sign --preserve-metadata=entitlements "$SPARKLE/XPCServices/Downloader.xpc"
sign "$SPARKLE/Autoupdate"
sign "$SPARKLE/Updater.app"
sign "$APP/Contents/Frameworks/Sparkle.framework"
sign "$APP"
codesign --verify --deep --strict "$APP"

echo "==> $APP"
echo "    signed with: $IDENTITY"
