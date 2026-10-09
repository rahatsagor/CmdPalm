#!/bin/bash
# Sets the version everywhere it is recorded.
#
#   scripts/bump-version.sh 1.2.0
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
VERSION="${1:-}"
VERSION="${VERSION#v}"
if [[ ! "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]?)\.(0|[1-9][0-9]?)$ ]]; then
  echo "usage: scripts/bump-version.sh 1.2.0 (minor and patch must be below 100)" >&2
  exit 2
fi

# The first `version =` in Cargo.toml is [workspace.package].
sed -i '' -E "1,/^version = /s/^version = \".*\"/version = \"$VERSION\"/" "$ROOT/Cargo.toml"
sed -i '' -E "s/^(  \"version\": )\".*\"/\1\"$VERSION\"/" "$ROOT/web/package.json"
sed -i '' -E "s/^(    MARKETING_VERSION: )\".*\"/\1\"$VERSION\"/" "$ROOT/apple/project.yml"
(cd "$ROOT" && cargo metadata --format-version 1 >/dev/null)

if ! grep -q "^## \[$VERSION\]" "$ROOT/CHANGELOG.md"; then
  echo "note: add a '## [$VERSION]' section to CHANGELOG.md before tagging."
fi
echo "Version set to $VERSION."
