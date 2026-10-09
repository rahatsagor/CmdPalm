#!/usr/bin/env bash
# Renders every icon from apple/Resources/icon.svg. Needs rsvg-convert
# (brew install librsvg). Outputs are committed, so this only runs when the
# artwork changes.
set -euo pipefail
cd "$(dirname "$0")/.."

src=apple/Resources/icon.svg
iconset=apple/CmdPalm/Assets.xcassets/AppIcon.appiconset
for tool in rsvg-convert python3; do
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
python3 - "$src" "$square" <<'PYTHON'
import sys
import xml.etree.ElementTree as ET

ET.register_namespace("", "http://www.w3.org/2000/svg")
tree = ET.parse(sys.argv[1])
background = tree.find(".//*[@id='background-shape']")
if background is None:
    raise SystemExit("error: icon.svg is missing the background-shape group")
for rect in background.findall("{http://www.w3.org/2000/svg}rect"):
    rect.attrib.pop("rx", None)
    rect.attrib.pop("ry", None)
tree.write(sys.argv[2], encoding="unicode")
PYTHON

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
