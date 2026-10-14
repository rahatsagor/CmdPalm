#!/usr/bin/env bash
# Renders every icon from apple/Resources/icon.svg. Needs rsvg-convert
# (brew install librsvg). Outputs are committed, so this only runs when the
# artwork changes.
set -euo pipefail
cd "$(dirname "$0")/.."

src=apple/Resources/icon.svg
iconset=apple/CmdPalm/Assets.xcassets/AppIcon.appiconset
for tool in rsvg-convert bun; do
  command -v "$tool" >/dev/null || {
    echo "error: $tool is required to regenerate icons (see CONTRIBUTING.md)" >&2
    exit 1
  }
done
mkdir -p "$iconset" web/public build

# Platforms that apply their own mask (macOS 26+, iOS home screen) get
# full-bleed square artwork.
scratch=$(mktemp -d build/icons.XXXXXX)
square="$scratch/icon-square.svg"
trap 'rm -rf "$scratch"' EXIT

# Only remove the background's corner mask. Keep the phone and all artwork
# geometry intact, even when their radii or the background radius change.
cat >"$scratch/square.ts" <<'TS'
const [source, target] = process.argv.slice(2) as [string, string]
let found = false
const rewriter = new HTMLRewriter()
  .on('#background-shape', { element: () => void (found = true) })
  .on('#background-shape > rect', {
    element(rect) {
      rect.removeAttribute('rx')
      rect.removeAttribute('ry')
    },
  })
const square = await rewriter.transform(new Response(Bun.file(source))).text()
if (!found) {
  console.error('error: icon.svg is missing the background-shape group')
  process.exit(1)
}
await Bun.write(target, square)
TS
bun "$scratch/square.ts" "$src" "$square"

render() { rsvg-convert -w "$2" -h "$2" "$1" -o "$3"; }

for size in 16 32 128 256 512; do
  render "$square" "$size" "$iconset/icon_${size}.png"
  render "$square" $((size * 2)) "$iconset/icon_${size}@2x.png"
done

cat >"$iconset/Contents.json" <<'JSON'
{
  "images" : [
    { "filename" : "icon_16.png", "idiom" : "mac", "scale" : "1x", "size" : "16x16" },
    { "filename" : "icon_16@2x.png", "idiom" : "mac", "scale" : "2x", "size" : "16x16" },
    { "filename" : "icon_32.png", "idiom" : "mac", "scale" : "1x", "size" : "32x32" },
    { "filename" : "icon_32@2x.png", "idiom" : "mac", "scale" : "2x", "size" : "32x32" },
    { "filename" : "icon_128.png", "idiom" : "mac", "scale" : "1x", "size" : "128x128" },
    { "filename" : "icon_128@2x.png", "idiom" : "mac", "scale" : "2x", "size" : "128x128" },
    { "filename" : "icon_256.png", "idiom" : "mac", "scale" : "1x", "size" : "256x256" },
    { "filename" : "icon_256@2x.png", "idiom" : "mac", "scale" : "2x", "size" : "256x256" },
    { "filename" : "icon_512.png", "idiom" : "mac", "scale" : "1x", "size" : "512x512" },
    { "filename" : "icon_512@2x.png", "idiom" : "mac", "scale" : "2x", "size" : "512x512" }
  ],
  "info" : { "author" : "xcode", "version" : 1 }
}
JSON

cp "$src" web/public/icon.svg
render "$square" 180 web/public/apple-touch-icon.png
render "$square" 192 web/public/icon-192.png
render "$square" 512 web/public/icon-512.png
echo "Icons updated."
