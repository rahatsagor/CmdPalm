#!/bin/bash
# Rebuilds README animations and the film poster in docs/media from the
# versioned launch media directory (clips/ and film-1080.mp4).
# Needs ffmpeg, ImageMagick, WebP tools, ffprobe and Python 3.
#
#   scripts/readme-media.sh path/to/landing-page/public/media/launch-055350f
set -euo pipefail

if [[ $# -ne 1 || ! -d "$1/clips" || ! -f "$1/film-1080.mp4" ]]; then
  echo "usage: $0 <launch media folder containing clips/ and film-1080.mp4>" >&2
  exit 1
fi
for tool in ffmpeg magick img2webp webpmux ffprobe python3; do
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

# Five feature moments in the current launch order. Display shows the finished edit.
mkdir -p "$WORK/hero"
ffmpeg -v error -y \
  -ss 0.7 -t 4.0 -i "$SRC/clips/trackpad.mp4" \
  -ss 0.3 -t 3.2 -i "$SRC/clips/keyboard.mp4" \
  -ss 2.0 -t 4.5 -i "$SRC/clips/display.mp4" \
  -ss 0.8 -t 3.2 -i "$SRC/clips/deck.mp4" \
  -ss 0.6 -t 3.4 -i "$SRC/clips/voice.mp4" \
  -filter_complex "[0:v][1:v][2:v][3:v][4:v]concat=n=5:v=1:a=0,fps=12,scale=800:-2:flags=lanczos[v]" \
  -map "[v]" "$WORK/hero/f%04d.png"
webp hero 12 52

for clip in trackpad keyboard display custom deck apps-media voice; do
  mkdir -p "$WORK/$clip"
  ffmpeg -v error -y -i "$SRC/clips/$clip.mp4" -vf "fps=12,scale=480:-2:flags=lanczos" "$WORK/$clip/f%04d.png"
  webp "$clip" 12 55
done

# The film poster: sample the closing moments of the 99-second film and keep
# the established play-button treatment and JPEG encoding.
ffmpeg -v error -y -ss 97.8 -i "$SRC/film-1080.mp4" -frames:v 1 -vf scale=1280:-2 "$WORK/film.png"
magick "$WORK/film.png" \( -size 1280x720 radial-gradient:'rgba(0,0,0,0.05)-rgba(0,0,0,0.6)' \) -compose over -composite \
  -fill 'rgba(18,18,18,0.78)' -stroke 'rgba(255,255,255,0.9)' -strokewidth 4 -draw "circle 640,380 640,302" \
  -stroke none -fill '#f9813d' -draw "polygon 618,342 618,418 684,380" \
  -quality 84 -strip "$OUT/film.jpg"
echo "film.jpg $(( $(stat -f%z "$OUT/film.jpg") / 1024 )) KB"

# Record metadata for exactly the generated README media. WebP dimensions,
# animation frame counts, and durations come from webpmux; hashes and sizes
# are computed from the finished outputs.
python3 - "$SRC" "$ROOT" <<'PY'
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

src = Path(sys.argv[1])
root = Path(sys.argv[2])
out = root / "docs/media"
source_manifest_path = src / "manifest.json"
if not source_manifest_path.is_file():
    raise SystemExit(f"error: expected source manifest: {source_manifest_path}")
source_manifest = json.loads(source_manifest_path.read_text())
source = source_manifest.get("source", {})
required = ["masterRelativePath", "masterSha256", "appSourceCommit", "renderCommit"]
missing = [key for key in required if not source.get(key)]
if missing:
    raise SystemExit("error: missing source manifest metadata: " + ", ".join(missing))
landing_root = src.parents[2]
master_path = (landing_root / source["masterRelativePath"]).resolve()
master_path_from_repo = os.path.relpath(master_path, root)
if master_path.is_file():
    master_hash = hashlib.sha256(master_path.read_bytes()).hexdigest()
    if master_hash != source["masterSha256"]:
        raise SystemExit("error: source master hash does not match the launch media manifest")
film_path = src / "film-1080.mp4"
film_probe = json.loads(subprocess.check_output([
    "ffprobe", "-v", "error", "-show_entries",
    "format=duration,size:stream=codec_type,codec_name,width,height,r_frame_rate",
    "-of", "json", str(film_path),
], text=True))
video_stream = next(s for s in film_probe["streams"] if s["codec_type"] == "video")
audio_stream = next((s for s in film_probe["streams"] if s["codec_type"] == "audio"), None)
if float(film_probe["format"]["duration"]) != 99 or (video_stream["width"], video_stream["height"]) != (1920, 1080):
    raise SystemExit("error: input film is not the expected 99-second 1920x1080 master encode")

names = ["hero.webp", "trackpad.webp", "keyboard.webp", "display.webp", "custom.webp", "deck.webp", "apps-media.webp", "voice.webp", "film.jpg"]
assets = []
for name in names:
    path = out / name
    if not path.is_file():
        raise SystemExit(f"error: generated asset missing: {path}")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    asset = {"path": f"docs/media/{name}", "sizeBytes": path.stat().st_size, "sha256": digest}
    if path.suffix == ".webp":
        info = subprocess.check_output(["webpmux", "-info", str(path)], text=True)
        canvas = re.search(r"Canvas size: (\d+) x (\d+)", info)
        if not canvas:
            raise SystemExit(f"error: webpmux did not report dimensions for {path}")
        frames = []
        for line in info.splitlines():
            match = re.match(r"\s*\d+:\s+\d+\s+\d+\s+\w+\s+\d+\s+\d+\s+(\d+)\s+", line)
            if match:
                frames.append(int(match.group(1)))
        frame_count_match = re.search(r"Number of frames: (\d+)", info)
        frame_count = int(frame_count_match.group(1)) if frame_count_match else 1
        asset.update({
            "mediaType": "image/webp",
            "width": int(canvas.group(1)),
            "height": int(canvas.group(2)),
            "animated": frame_count > 1,
            "frameCount": frame_count,
            "durationMilliseconds": sum(frames) if frames else 0,
            "probe": "webpmux -info",
        })
    else:
        dimensions = subprocess.check_output(["magick", "identify", "-format", "%w %h", str(path)], text=True).split()
        asset.update({
            "mediaType": "image/jpeg",
            "width": int(dimensions[0]),
            "height": int(dimensions[1]),
            "animated": False,
            "frameCount": 1,
            "durationMilliseconds": 0,
            "sourceFrameSeconds": 97.8,
            "probe": "magick identify",
        })
    assets.append(asset)

manifest = {
    "source": {
        "masterRelativePath": source["masterRelativePath"],
        "masterPathRelativeToLandingRepoRoot": source_manifest.get("source", {}).get("masterPathRelativeToRepoRoot", True),
        "masterPathFromCmdPalmRepoRoot": master_path_from_repo,
        "masterSha256": source["masterSha256"],
        "videoSourceCommit": source["renderCommit"],
        "appSourceCommit": source["appSourceCommit"],
        "launchMediaDirectoryRelativeToCmdPalmRepoRoot": os.path.relpath(src, root),
        "sourceLandingManifestPathFromCmdPalmRepoRoot": os.path.relpath(source_manifest_path, root),
        "inputFilmProbe": {
            "path": os.path.relpath(film_path, root),
            "sizeBytes": int(film_probe["format"]["size"]),
            "durationSeconds": float(film_probe["format"]["duration"]),
            "sha256": hashlib.sha256(film_path.read_bytes()).hexdigest(),
            "video": {key: video_stream[key] for key in ("codec_name", "width", "height", "r_frame_rate")},
            "audioCodec": audio_stream["codec_name"] if audio_stream else None,
            "probe": "ffprobe",
        },
    },
    "recipe": {
        "heroSegments": [
            {"clip": "trackpad", "startSeconds": 0.7, "durationSeconds": 4.0},
            {"clip": "keyboard", "startSeconds": 0.3, "durationSeconds": 3.2},
            {"clip": "display", "startSeconds": 2.0, "durationSeconds": 4.5},
            {"clip": "deck", "startSeconds": 0.8, "durationSeconds": 3.2},
            {"clip": "voice", "startSeconds": 0.6, "durationSeconds": 3.4},
        ],
        "animatedWebP": {"fps": 12, "heroWidth": 800, "featureWidth": 480, "heroQuality": 52, "featureQuality": 55},
        "filmPoster": {"sourceFrameSeconds": 97.8, "width": 1280, "jpegQuality": 84},
    },
    "assets": assets,
}
(out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(f"manifest.json: {len(assets)} assets recorded")
PY
