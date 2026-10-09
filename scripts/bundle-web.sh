#!/bin/bash
# Builds the phone client and copies it into the app bundle. Xcode runs this
# after compiling; set CMDPALM_SKIP_WEB=1 to reuse an existing web/dist.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
WEB="$ROOT/web"
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

if [[ "${CMDPALM_SKIP_WEB:-0}" != "1" || ! -f "$WEB/dist/index.html" ]]; then
  if ! command -v bun >/dev/null; then
    echo "error: bun not found. Install it from https://bun.sh" >&2
    exit 1
  fi
  cd "$WEB"
  if [[ ! -d node_modules ]]; then
    bun install --frozen-lockfile
  fi
  bun run build
fi

if [[ -n "${TARGET_BUILD_DIR:-}" && -n "${UNLOCALIZED_RESOURCES_FOLDER_PATH:-}" ]]; then
  DEST="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/web"
  rm -rf "$DEST"
  mkdir -p "$DEST"
  cp -R "$WEB/dist/." "$DEST/"
fi
