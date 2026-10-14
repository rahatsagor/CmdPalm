#!/bin/bash
# Rebuilds the README animations and film poster in docs/media from the
# landing page's clips. Needs ffmpeg, ImageMagick and libwebp:
#
#   brew install ffmpeg imagemagick webp
#   scripts/readme-media.sh path/to/landing-page/public/media
set -euo pipefail

if [[ $# -ne 1 || ! -d "$1/clips" ]]; then
  echo "usage: $0 <media folder containing clips/ and film-1080.mp4>" >&2
  exit 1
fi
for tool in ffmpeg magick img2webp; do
  command -v "$tool" >/dev/null || { echo "error: $tool not found" >&2; exit 1; }
done

SRC="$(cd "$1" && pwd -P)"
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
OUT="$ROOT/docs/media"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

# webp NAME FPS QUALITY: turns the PNG frames in $WORK/NAME into a looping
# animation. GitHub plays animated WebP in READMEs, at a fraction of a GIF's size.
webp() {
  img2webp -loop 0 -min_size -lossy -q "$3" -m 6 -d $((1000 / $2)) "$WORK/$1"/f*.png -o "$OUT/$1.webp" >/dev/null
  echo "$1.webp $(( $(stat -f%z "$OUT/$1.webp") / 1024 )) KB"
}

# The hero: a highlight reel of four features.
mkdir -p "$WORK/hero"
ffmpeg -v error -y \
  -ss 0 -t 4.5 -i "$SRC/clips/trackpad.mp4" \
  -ss 0.3 -t 3.2 -i "$SRC/clips/keyboard.mp4" \
  -ss 0.8 -t 3.2 -i "$SRC/clips/deck.mp4" \
  -ss 0.6 -t 3.4 -i "$SRC/clips/voice.mp4" \
  -filter_complex "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0,fps=12,scale=800:-2:flags=lanczos[v]" \
  -map "[v]" "$WORK/hero/f%04d.png"
webp hero 12 52

for clip in trackpad keyboard custom deck apps-media voice; do
  mkdir -p "$WORK/$clip"
  ffmpeg -v error -y -i "$SRC/clips/$clip.mp4" -vf "fps=12,scale=480:-2:flags=lanczos" "$WORK/$clip/f%04d.png"
  webp "$clip" 12 55
done

# The film poster: a still with a play button, linking to the full film.
ffmpeg -v error -y -ss 62 -i "$SRC/film-1080.mp4" -frames:v 1 -vf scale=1280:-2 "$WORK/film.png"
magick "$WORK/film.png" \( -size 1280x720 radial-gradient:'rgba(0,0,0,0.05)-rgba(0,0,0,0.6)' \) -compose over -composite \
  -fill 'rgba(18,18,18,0.78)' -stroke 'rgba(255,255,255,0.9)' -strokewidth 4 -draw "circle 640,380 640,302" \
  -stroke none -fill '#f9813d' -draw "polygon 618,342 618,418 684,380" \
  -quality 84 -strip "$OUT/film.jpg"
echo "film.jpg $(( $(stat -f%z "$OUT/film.jpg") / 1024 )) KB"
