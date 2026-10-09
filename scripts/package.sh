#!/bin/bash
# Packages build/Release/CmdPalm.app for distribution:
#   dist/CmdPalm-<version>.zip  (Sparkle updates and Homebrew)
#   dist/CmdPalm-<version>.dmg  (manual download)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
APP="$ROOT/build/Release/CmdPalm.app"
DIST="$ROOT/dist"

[[ -d "$APP" ]] || { echo "error: build the app first (scripts/build-app.sh)" >&2; exit 1; }
VERSION="$(defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString)"
mkdir -p "$DIST"

ZIP="$DIST/CmdPalm-$VERSION.zip"
rm -f "$ZIP"
# ditto keeps the bundle's symlinks and extended attributes intact.
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

DMG="$DIST/CmdPalm-$VERSION.dmg"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/CmdPalm.app"
ln -s /Applications "$STAGE/Applications"
cp "$ROOT/packaging/dmg/Open Me First.txt" "$STAGE/" 2>/dev/null || true
rm -f "$DMG"
hdiutil create -quiet -volname "CmdPalm $VERSION" -srcfolder "$STAGE" -fs APFS -format ULFO -ov "$DMG"

(cd "$DIST" && shasum -a 256 "$(basename "$ZIP")" "$(basename "$DMG")" | tee SHA256SUMS)
