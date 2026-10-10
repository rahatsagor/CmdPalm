#!/usr/bin/env python3
"""Release tooling that reads CHANGELOG.md.

    release_notes.py notes 1.2.0              Markdown notes for a GitHub release
    release_notes.py appcast 1.2.0 ZIP OUT    Sparkle appcast with HTML notes
    release_notes.py check 1.2.0              Validate versions and release notes
    release_notes.py check-keys               Validate matching Sparkle keys

The appcast is written unsigned; sign it (and the archive) with Sparkle's
sign_update. The release workflow does both.
"""

from __future__ import annotations

import base64
import binascii
import html
import json
import os
import re
import subprocess
import sys
import tomllib
from email.utils import formatdate
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = "rahatsagor/CmdPalm"
MIN_MACOS = "15.0"


def unwrap(markdown: str) -> str:
    """Join hard-wrapped lines. GitHub shows every newline in release notes
    as a line break, so wrapped changelog lines would break mid-sentence."""
    lines: list[str] = []
    for line in markdown.splitlines():
        stripped = line.strip()
        continues = (
            lines
            and stripped
            and lines[-1].strip()
            and not stripped.startswith(("#", "- ", "* ", ">", "|", "```"))
            and not lines[-1].lstrip().startswith(("#", "|", "```"))
        )
        if continues:
            lines[-1] = lines[-1].rstrip() + " " + stripped
        else:
            lines.append(line.rstrip())
    return "\n".join(lines)


def section(version: str) -> str:
    """The body of the `## [version]` section of CHANGELOG.md."""
    text = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    pattern = re.compile(rf"^## \[?{re.escape(version)}\]?[^\n]*\n(.*?)(?=^## |\Z)", re.M | re.S)
    match = pattern.search(text)
    if not match:
        sys.exit(f"error: CHANGELOG.md has no section for {version}")
    body = re.sub(r"^\[[^\]]+\]: .*$", "", match.group(1), flags=re.M).strip()
    if not body:
        sys.exit(f"error: the CHANGELOG.md section for {version} is empty")
    return body


def inline(text: str) -> str:
    out = html.escape(text, quote=False)
    out = re.sub(r"`([^`]+)`", r"<code>\1</code>", out)
    out = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", out)
    out = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r'<a href="\2">\1</a>', out)
    return out


def to_html(markdown: str) -> str:
    """Just enough Markdown for changelog sections: headings, lists, paragraphs."""
    parts: list[str] = []
    in_list = False
    paragraph: list[str] = []

    def flush() -> None:
        nonlocal in_list
        if paragraph:
            parts.append(f"<p>{inline(' '.join(paragraph))}</p>")
            paragraph.clear()
        if in_list:
            parts.append("</ul>")
            in_list = False

    for line in markdown.splitlines():
        stripped = line.strip()
        if not stripped:
            flush()
        elif stripped.startswith("### "):
            flush()
            parts.append(f"<h3>{inline(stripped[4:])}</h3>")
        elif stripped.startswith(("- ", "* ")):
            if paragraph:
                parts.append(f"<p>{inline(' '.join(paragraph))}</p>")
                paragraph.clear()
            if not in_list:
                parts.append("<ul>")
                in_list = True
            parts.append(f"<li>{inline(stripped[2:])}</li>")
        elif in_list and line.startswith("  "):
            parts[-1] = parts[-1][: -len("</li>")] + " " + inline(stripped) + "</li>"
        else:
            paragraph.append(stripped)
    flush()
    return "\n".join(parts)


def build_number(version: str) -> int:
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]?)\.(0|[1-9][0-9]?)", version):
        sys.exit("error: use a version like 1.2.3 with minor and patch numbers below 100")
    major, minor, patch = (int(p) for p in version.split("."))
    return major * 10000 + minor * 100 + patch


def check_version(version: str) -> None:
    build_number(version)
    cargo = tomllib.loads((ROOT / "Cargo.toml").read_text(encoding="utf-8"))
    web = json.loads((ROOT / "web/package.json").read_text(encoding="utf-8"))
    project = (ROOT / "apple/project.yml").read_text(encoding="utf-8")
    matches = re.findall(r'^\s+MARKETING_VERSION: "([^"]+)"$', project, re.M)
    if len(matches) != 1:
        sys.exit("error: apple/project.yml must define one MARKETING_VERSION")
    versions = {
        "Cargo.toml": cargo["workspace"]["package"]["version"],
        "web/package.json": web["version"],
        "apple/project.yml": matches[0],
    }
    for filename, recorded in versions.items():
        if recorded != version:
            sys.exit(f"error: tag version {version} does not match {recorded} in {filename}")
    section(version)


def check_keys() -> None:
    public = os.environ.get("SPARKLE_PUBLIC_KEY", "")
    private = os.environ.get("SPARKLE_PRIVATE_KEY", "").rstrip("\r\n")
    if not public or not private:
        sys.exit("error: set SPARKLE_PUBLIC_KEY (variable) and SPARKLE_PRIVATE_KEY (secret)")
    try:
        public_bytes = base64.b64decode(public, validate=True)
        private_bytes = base64.b64decode(private, validate=True)
    except (ValueError, binascii.Error):
        sys.exit("error: Sparkle keys must be valid base64")
    # Sparkle exports a 32-byte Ed25519 seed, or a legacy 96-byte key pair.
    if len(public_bytes) != 32 or len(private_bytes) not in (32, 96):
        sys.exit("error: Sparkle keys have invalid lengths")
    if len(private_bytes) == 32:
        # Wrap the seed in PKCS#8; OpenSSL derives its Ed25519 public key.
        pkcs8 = bytes.fromhex("302e020100300506032b657004220420") + private_bytes
        result = subprocess.run(
            ["openssl", "pkey", "-inform", "DER", "-pubout", "-outform", "DER"],
            input=pkcs8,
            capture_output=True,
        )
        if result.returncode != 0 or len(result.stdout) != 44:
            sys.exit("error: OpenSSL could not derive the Ed25519 public key; use OpenSSL 3 or later")
        derived_public = result.stdout[-32:]
    else:
        derived_public = private_bytes[-32:]
    if derived_public != public_bytes:
        sys.exit("error: the Sparkle public and private keys do not match")


def appcast(version: str, archive: Path, out: Path) -> None:
    signature = sign(archive)
    url = f"https://github.com/{REPO}/releases/download/v{version}/{archive.name}"
    notes = to_html(section(version))
    feed = f"""<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>CmdPalm</title>
    <link>https://github.com/{REPO}</link>
    <description>CmdPalm updates</description>
    <language>en</language>
    <item>
      <title>CmdPalm {version}</title>
      <pubDate>{formatdate(usegmt=True)}</pubDate>
      <sparkle:version>{build_number(version)}</sparkle:version>
      <sparkle:shortVersionString>{version}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>{MIN_MACOS}</sparkle:minimumSystemVersion>
      <sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>
      <sparkle:fullReleaseNotesLink>https://github.com/{REPO}/releases/tag/v{version}</sparkle:fullReleaseNotesLink>
      <description><![CDATA[
{notes}
      ]]></description>
      <enclosure url="{url}" length="{archive.stat().st_size}" type="application/octet-stream" sparkle:edSignature="{signature}"/>
    </item>
  </channel>
</rss>
"""
    out.write_text(feed, encoding="utf-8")


def sign_update() -> str:
    tool = os.environ.get("SPARKLE_SIGN_UPDATE")
    if tool:
        return tool
    found = sorted(ROOT.glob("build/DerivedData/SourcePackages/artifacts/sparkle/Sparkle/bin/sign_update"))
    if not found:
        sys.exit("error: sign_update not found; build the app first or set SPARKLE_SIGN_UPDATE")
    return str(found[0])


def sign(path: Path) -> str:
    """EdDSA signature of `path`, using the key in SPARKLE_PRIVATE_KEY or else
    the Keychain item for SPARKLE_ACCOUNT (default "cmdpalm")."""
    key = os.environ.get("SPARKLE_PRIVATE_KEY")
    command = [sign_update(), "-p", str(path)]
    if key:
        command[1:1] = ["--ed-key-file", "-"]
    else:
        command[1:1] = ["--account", os.environ.get("SPARKLE_ACCOUNT", "cmdpalm")]
    result = subprocess.run(command, input=key, capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit(f"error: sign_update failed: {result.stderr.strip()}")
    signature = result.stdout.strip()
    # Verify the ZIP as well as the feed, before publishing either file.
    verify = command[:-2] + ["--verify", str(path), signature]
    result = subprocess.run(verify, input=key, capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit(f"error: archive signature verification failed: {result.stderr.strip()}")
    return signature


def main() -> None:
    args = sys.argv[1:]
    if len(args) == 2 and args[0] == "notes":
        print(unwrap(section(args[1])))
    elif len(args) == 2 and args[0] == "check":
        check_version(args[1])
        print(f"Release metadata for {args[1]} is consistent")
    elif args == ["check-keys"]:
        check_keys()
        print("Sparkle keys match")
    elif len(args) == 4 and args[0] == "appcast":
        appcast(args[1], Path(args[2]), Path(args[3]))
    elif len(args) == 2 and args[0] == "html":
        print(to_html(section(args[1])))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
