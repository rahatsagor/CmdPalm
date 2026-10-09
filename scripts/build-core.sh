#!/bin/bash
# Builds the Rust core as a static library and regenerates the Swift bindings
# in apple/Generated. Xcode runs this before compiling; it is also safe to run
# by hand.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TARGET=aarch64-apple-darwin
OUT="$ROOT/apple/Generated"

# Xcode runs build phases with a minimal PATH.
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
# Cargo reports paths through ~/.cargo's real location; when it is a symlink
# uniffi-bindgen cannot match crate sources without this.
if [[ -z "${CARGO_HOME:-}" && -d "$HOME/.cargo" ]]; then
  CARGO_HOME="$(cd "$HOME/.cargo" && pwd -P)"
  export CARGO_HOME
fi

if ! command -v cargo >/dev/null; then
  echo "error: cargo not found. Install Rust from https://rustup.rs" >&2
  exit 1
fi

# Xcode sets these for its own toolchain; they confuse rustc's linker.
unset SDKROOT MACOSX_DEPLOYMENT_TARGET IPHONEOS_DEPLOYMENT_TARGET LD LDFLAGS CC CXX
export MACOSX_DEPLOYMENT_TARGET=15.0

cd "$ROOT"
cargo build --locked --release --target "$TARGET" -p cmdpalm-core

LIB="$ROOT/target/$TARGET/release/libcmdpalm_core.dylib"
STAMP="$OUT/.stamp"
# Only rewrite the bindings when the library changed, so Xcode does not
# recompile the Swift target on every build.
if [[ ! -f "$STAMP" || "$LIB" -nt "$STAMP" || ! -f "$OUT/cmdpalm_core.swift" ]]; then
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  cargo run --locked --quiet --release -p uniffi-bindgen -- \
    generate --library "$LIB" --language swift --out-dir "$TMP" --no-format
  mkdir -p "$OUT"
  for file in cmdpalm_core.swift cmdpalm_coreFFI.h cmdpalm_coreFFI.modulemap; do
    if ! cmp -s "$TMP/$file" "$OUT/$file"; then
      cp "$TMP/$file" "$OUT/$file"
    fi
  done
  touch "$STAMP"
fi
