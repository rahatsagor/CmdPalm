#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

export const ROOT = resolve(import.meta.dir, '..')
const REPO = 'rahatsagor/CmdPalm'

const USAGE = `Release tooling that reads CHANGELOG.md.

    release-notes.ts notes 1.2.0              Markdown notes for a GitHub release
    release-notes.ts appcast 1.2.0 ZIP OUT    Sparkle appcast with HTML notes
    release-notes.ts check 1.2.0              Validate versions and release notes
    release-notes.ts check-keys               Validate matching Sparkle keys

The appcast is written unsigned; sign it (and the archive) with Sparkle's
sign_update. The release workflow does both.`

/** A problem that stops the release; the message is shown as is. */
export class ReleaseError extends Error {}

function fail(message: string): never {
  throw new ReleaseError(`error: ${message}`)
}

/** Lines split at any line break, without an empty one after a final newline. */
function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** Join hard-wrapped lines. GitHub shows every newline in release notes as a
 * line break, so wrapped changelog lines would break mid-sentence. */
export function unwrap(markdown: string): string {
  const lines: string[] = []
  for (const line of splitLines(markdown)) {
    const stripped = line.trim()
    const last = lines.at(-1)
    const continues =
      last !== undefined &&
      stripped !== '' &&
      last.trim() !== '' &&
      !['#', '- ', '* ', '>', '|', '```'].some((start) => stripped.startsWith(start)) &&
      !['#', '|', '```'].some((start) => last.trimStart().startsWith(start))
    if (continues) {
      lines[lines.length - 1] = `${last.trimEnd()} ${stripped}`
    } else {
      lines.push(line.trimEnd())
    }
  }
  return lines.join('\n')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The body of the `## [version]` section of CHANGELOG.md. */
export function section(version: string, root = ROOT): string {
  const text = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  // The lookahead stops 1.2.1 from matching the heading of 1.2.10 or 1.2.1-beta.
  const pattern = new RegExp(
    `^## \\[?${escapeRegExp(version)}(?![\\w.-])\\]?[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`,
    'm',
  )
  const match = pattern.exec(text)
  if (!match) fail(`CHANGELOG.md has no section for ${version}`)
  const body = (match[1] ?? '').replace(/^\[[^\]]+\]: .*$/gm, '').trim()
  if (!body) fail(`the CHANGELOG.md section for ${version} is empty`)
  return body
}

function inline(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
}

/** Just enough Markdown for changelog sections: headings, lists, paragraphs. */
export function toHtml(markdown: string): string {
  const parts: string[] = []
  let inList = false
  const paragraph: string[] = []

  const endParagraph = () => {
    if (paragraph.length) {
      parts.push(`<p>${inline(paragraph.join(' '))}</p>`)
      paragraph.length = 0
    }
  }
  const flush = () => {
    endParagraph()
    if (inList) {
      parts.push('</ul>')
      inList = false
    }
  }

  for (const line of splitLines(markdown)) {
    const stripped = line.trim()
    if (!stripped) {
      flush()
    } else if (stripped.startsWith('### ')) {
      flush()
      parts.push(`<h3>${inline(stripped.slice(4))}</h3>`)
    } else if (stripped.startsWith('- ') || stripped.startsWith('* ')) {
      endParagraph()
      if (!inList) {
        parts.push('<ul>')
        inList = true
      }
      parts.push(`<li>${inline(stripped.slice(2))}</li>`)
    } else if (inList) {
      // An indented or lazy continuation of the last item.
      const item = parts.pop() ?? ''
      parts.push(`${item.slice(0, -'</li>'.length)} ${inline(stripped)}</li>`)
    } else {
      paragraph.push(stripped)
    }
  }
  flush()
  return parts.join('\n')
}

export function buildNumber(version: string): number {
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]?)\.(0|[1-9][0-9]?)$/.test(version)) {
    fail('use a version like 1.2.3 with minor and patch numbers below 100')
  }
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number)
  return major * 10000 + minor * 100 + patch
}

/** The deployment target in apple/project.yml, so the appcast never offers an
 * update to a Mac that can't run it. */
export function minimumMacOS(root = ROOT): string {
  const project = readFileSync(join(root, 'apple/project.yml'), 'utf8')
  const target = /^\s+deploymentTarget:\n\s+macOS: "([0-9]+(?:\.[0-9]+)*)"$/m.exec(project)?.[1]
  if (!target) fail('apple/project.yml must define deploymentTarget.macOS')
  return target
}

export function checkVersion(version: string, root = ROOT): void {
  buildNumber(version)
  minimumMacOS(root)
  const cargo = Bun.TOML.parse(readFileSync(join(root, 'Cargo.toml'), 'utf8')) as {
    workspace?: { package?: { version?: unknown } }
  }
  const web = JSON.parse(readFileSync(join(root, 'web/package.json'), 'utf8')) as { version?: unknown }
  const project = readFileSync(join(root, 'apple/project.yml'), 'utf8')
  const matches = [...project.matchAll(/^\s+MARKETING_VERSION: "([^"]+)"$/gm)]
  if (matches.length !== 1) fail('apple/project.yml must define one MARKETING_VERSION')
  const versions: Record<string, unknown> = {
    'Cargo.toml': cargo.workspace?.package?.version,
    'web/package.json': web.version,
    'apple/project.yml': matches[0]?.[1],
  }
  for (const [filename, recorded] of Object.entries(versions)) {
    if (recorded !== version) fail(`tag version ${version} does not match ${recorded} in ${filename}`)
  }
  section(version, root)
}

/** Strict base64: no stray characters such as a pasted newline, and correct
 * padding. */
function decodeBase64(text: string): Buffer | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) return null
  return Buffer.from(text, 'base64')
}

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

export function checkKeys(env: Record<string, string | undefined> = process.env): void {
  const publicKey = env.SPARKLE_PUBLIC_KEY ?? ''
  const privateKey = (env.SPARKLE_PRIVATE_KEY ?? '').replace(/[\r\n]+$/, '')
  if (!publicKey || !privateKey) fail('set SPARKLE_PUBLIC_KEY (variable) and SPARKLE_PRIVATE_KEY (secret)')
  const publicBytes = decodeBase64(publicKey)
  const privateBytes = decodeBase64(privateKey)
  if (!publicBytes || !privateBytes) fail('Sparkle keys must be valid base64')
  // Sparkle exports a 32-byte Ed25519 seed, or a legacy 96-byte key pair.
  if (publicBytes.length !== 32 || (privateBytes.length !== 32 && privateBytes.length !== 96)) {
    fail('Sparkle keys have invalid lengths')
  }
  let derived: Buffer
  if (privateBytes.length === 32) {
    try {
      const key = createPrivateKey({
        key: Buffer.concat([ED25519_PKCS8_PREFIX, privateBytes]),
        format: 'der',
        type: 'pkcs8',
      })
      derived = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32)
    } catch {
      fail('could not derive the Ed25519 public key from SPARKLE_PRIVATE_KEY')
    }
  } else {
    derived = privateBytes.subarray(-32)
  }
  if (!derived.equals(publicBytes)) fail('the Sparkle public and private keys do not match')
}

export type Run = (command: string[], input?: string) => { status: number | null; stdout: string; stderr: string }

const run: Run = (command, input) => {
  const [tool = '', ...args] = command
  const result = spawnSync(tool, args, { input, encoding: 'utf8' })
  return {
    status: result.error ? null : result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr || String(result.error ?? ''),
  }
}

function signUpdate(env: Record<string, string | undefined>, root: string): string {
  const tool = env.SPARKLE_SIGN_UPDATE
  if (tool) return tool
  const found = join(root, 'build/DerivedData/SourcePackages/artifacts/sparkle/Sparkle/bin/sign_update')
  if (!existsSync(found)) fail('sign_update not found; build the app first or set SPARKLE_SIGN_UPDATE')
  return found
}

/** EdDSA signature of `path`, using the key in SPARKLE_PRIVATE_KEY or else
 * the Keychain item for SPARKLE_ACCOUNT (default "cmdpalm"). */
export function sign(
  path: string,
  env: Record<string, string | undefined> = process.env,
  exec: Run = run,
  root = ROOT,
): string {
  const key = env.SPARKLE_PRIVATE_KEY || undefined
  const credentials = key ? ['--ed-key-file', '-'] : ['--account', env.SPARKLE_ACCOUNT ?? 'cmdpalm']
  const tool = signUpdate(env, root)
  let result = exec([tool, ...credentials, '-p', path], key)
  if (result.status !== 0) fail(`sign_update failed: ${result.stderr.trim()}`)
  const signature = result.stdout.trim()
  // Verify the ZIP as well as the feed, before publishing either file.
  result = exec([tool, ...credentials, '--verify', path, signature], key)
  if (result.status !== 0) fail(`archive signature verification failed: ${result.stderr.trim()}`)
  return signature
}

export function appcast(version: string, archive: string, out: string, root = ROOT): void {
  const signature = sign(archive, process.env, run, root)
  const url = `https://github.com/${REPO}/releases/download/v${version}/${basename(archive)}`
  const notes = toHtml(section(version, root))
  const feed = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>CmdPalm</title>
    <link>https://github.com/${REPO}</link>
    <description>CmdPalm updates</description>
    <language>en</language>
    <item>
      <title>CmdPalm ${version}</title>
      <pubDate>${new Date().toUTCString()}</pubDate>
      <sparkle:version>${buildNumber(version)}</sparkle:version>
      <sparkle:shortVersionString>${version}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>${minimumMacOS(root)}</sparkle:minimumSystemVersion>
      <sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>
      <sparkle:fullReleaseNotesLink>https://github.com/${REPO}/releases/tag/v${version}</sparkle:fullReleaseNotesLink>
      <description><![CDATA[
${notes}
      ]]></description>
      <enclosure url="${url}" length="${statSync(archive).size}" type="application/octet-stream" sparkle:edSignature="${signature}"/>
    </item>
  </channel>
</rss>
`
  writeFileSync(out, feed, 'utf8')
}

function main(args: string[]): void {
  const [command, ...rest] = args
  if (command === 'notes' && rest.length === 1) {
    console.log(unwrap(section(rest[0]!)))
  } else if (command === 'check' && rest.length === 1) {
    checkVersion(rest[0]!)
    console.log(`Release metadata for ${rest[0]} is consistent`)
  } else if (command === 'check-keys' && rest.length === 0) {
    checkKeys()
    console.log('Sparkle keys match')
  } else if (command === 'appcast' && rest.length === 3) {
    appcast(rest[0]!, rest[1]!, rest[2]!)
  } else if (command === 'html' && rest.length === 1) {
    console.log(toHtml(section(rest[0]!)))
  } else {
    throw new ReleaseError(USAGE)
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    if (!(error instanceof ReleaseError)) throw error
    console.error(error.message)
    process.exit(1)
  }
}
