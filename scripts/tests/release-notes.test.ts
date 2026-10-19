// Release gates must reject inconsistent versions and unusable update keys.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  type Run,
  buildNumber,
  checkKeys,
  checkVersion,
  minimumMacOS,
  section,
  sign,
  toHtml,
  unwrap,
} from '../release-notes'

const SCRIPTS = resolve(import.meta.dir, '..')

describe('release versions', () => {
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cmdpalm-release-'))
    mkdirSync(join(root, 'web'))
    mkdirSync(join(root, 'apple'))
    writeFileSync(join(root, 'Cargo.toml'), '[workspace.package]\nversion = "0.1.0"\n')
    writeFileSync(join(root, 'web/package.json'), JSON.stringify({ version: '0.1.0' }))
    writeFileSync(
      join(root, 'apple/project.yml'),
      'options:\n  deploymentTarget:\n    macOS: "15.0"\nsettings:\n  base:\n    MARKETING_VERSION: "0.1.0"\n',
    )
    writeFileSync(join(root, 'CHANGELOG.md'), '## [0.1.0] - 2026-10-09\n\n- First release.\n')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  test('consistent metadata passes', () => {
    checkVersion('0.1.0', root)
  })

  test.each(['Cargo.toml', 'web/package.json', 'apple/project.yml'])('%s must match the tag', (filename) => {
    const path = join(root, filename)
    writeFileSync(path, readFileSync(path, 'utf8').replace('0.1.0', '0.2.0'))
    expect(() => checkVersion('0.1.0', root)).toThrow(filename)
  })

  test.each(['## [Unreleased]\n', '## [0.1.0]\n\n'])('missing or empty release notes are rejected: %j', (changelog) => {
    writeFileSync(join(root, 'CHANGELOG.md'), changelog)
    expect(() => checkVersion('0.1.0', root)).toThrow()
  })

  test('a version never matches the section of a longer one', () => {
    writeFileSync(
      join(root, 'CHANGELOG.md'),
      '## [Unreleased]\n\n## [0.1.10] - 2026-10-20\n\n- Ten.\n\n## [0.1.1-beta]\n\n- Beta.\n\n## [0.1.1] - 2026-10-10\n\n- One.\n\n[0.1.1]: https://example.com\n',
    )
    expect(section('0.1.1', root)).toBe('- One.')
    expect(section('0.1.10', root)).toBe('- Ten.')
    expect(() => section('0.1.0', root)).toThrow('no section for 0.1.0')
  })

  test('the minimum macOS comes from the deployment target', () => {
    expect(minimumMacOS(root)).toBe('15.0')
    writeFileSync(join(root, 'apple/project.yml'), '    MARKETING_VERSION: "0.1.0"\n')
    expect(() => checkVersion('0.1.0', root)).toThrow('deploymentTarget')
  })

  test('build numbers increase at version boundaries', () => {
    expect(buildNumber('0.1.99')).toBeLessThan(buildNumber('0.2.0'))
    expect(buildNumber('0.99.99')).toBeLessThan(buildNumber('1.0.0'))
  })

  test.each(['01.2.3', '0.08.0', '1.100.0', '1.2.100', '1.2.3-beta', '1.2'])(
    'ambiguous and out of range versions are rejected: %s',
    (version) => {
      expect(() => buildNumber(version)).toThrow()
      for (const command of [
        [join(SCRIPTS, 'build-app.sh'), '--version', version],
        [join(SCRIPTS, 'bump-version.sh'), version],
      ]) {
        const [script = '', ...args] = command
        const result = spawnSync(script, args, { encoding: 'utf8' })
        expect(result.status, result.stderr).toBe(2)
      }
    },
  )
})

describe('release notes', () => {
  test('wrapped lines are joined for GitHub', () => {
    const markdown =
      'The first release.\n\n### Trackpad\n\n' +
      '- Move, tap to click, and touch and hold\n  to drag.\n' +
      '- Pinch to zoom.\n\n' +
      'A paragraph that\nwraps onto two lines.\n'
    expect(unwrap(markdown)).toBe(
      'The first release.\n\n### Trackpad\n\n' +
        '- Move, tap to click, and touch and hold to drag.\n' +
        '- Pinch to zoom.\n\n' +
        'A paragraph that wraps onto two lines.',
    )
  })
})

describe('release notes HTML', () => {
  test('wrapped list items stay inside their item', () => {
    expect(toHtml('### Fixes\n\n- One that\n  wraps.\n- Two that\nwraps lazily.\n\nAfter.')).toBe(
      '<h3>Fixes</h3>\n<ul>\n<li>One that wraps.</li>\n<li>Two that wraps lazily.</li>\n</ul>\n<p>After.</p>',
    )
  })

  test('text is escaped and inline markup is kept', () => {
    expect(toHtml('- **Bold** `a < b` & [link](https://cmdpalm.app) <script>')).toBe(
      '<ul>\n<li><strong>Bold</strong> <code>a &lt; b</code> &amp; <a href="https://cmdpalm.app">link</a> &lt;script&gt;</li>\n</ul>',
    )
  })
})

describe('Sparkle keys', () => {
  function keys(legacy = false) {
    // RFC 8032 section 7.1, test 1 (public test vector, not a release key).
    const seed = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex')
    const publicKey = Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex')
    let privateKey = seed
    if (legacy) {
      const expanded = createHash('sha512').update(seed).digest()
      expanded[0] = expanded[0]! & 248
      expanded[31] = (expanded[31]! & 63) | 64
      privateKey = Buffer.concat([expanded, publicKey])
    }
    return { SPARKLE_PUBLIC_KEY: publicKey.toString('base64'), SPARKLE_PRIVATE_KEY: privateKey.toString('base64') }
  }

  test.each([false, true])('current and legacy exports are accepted (legacy: %p)', (legacy) => {
    checkKeys(keys(legacy))
  })

  test('mismatched keys are rejected without printing the secret', () => {
    const env = { ...keys(), SPARKLE_PUBLIC_KEY: Buffer.alloc(32).toString('base64') }
    let message = ''
    try {
      checkKeys(env)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('do not match')
    expect(message).not.toContain(env.SPARKLE_PRIVATE_KEY)
  })

  test('missing, malformed and wrong length keys are rejected', () => {
    const invalid: Record<string, string>[] = [
      {},
      { SPARKLE_PUBLIC_KEY: 'not base64!', SPARKLE_PRIVATE_KEY: 'bad' },
      { ...keys(), SPARKLE_PRIVATE_KEY: Buffer.alloc(64).toString('base64') },
      { ...keys(), SPARKLE_PUBLIC_KEY: `${keys().SPARKLE_PUBLIC_KEY}\n` },
    ]
    for (const env of invalid) {
      expect(() => checkKeys(env), Object.keys(env).join()).toThrow()
    }
  })

  test('the archive signature is verified before use', () => {
    const signature = Buffer.alloc(64).toString('base64')
    const calls: { command: string[]; input?: string }[] = []
    const results = [
      { status: 0, stdout: `${signature}\n`, stderr: '' },
      { status: 0, stdout: '', stderr: '' },
    ]
    const exec: Run = (command, input) => {
      calls.push({ command, input })
      return results.shift()!
    }
    const env = { SPARKLE_SIGN_UPDATE: '/sparkle/sign_update', ...keys() }
    expect(sign('CmdPalm.zip', env, exec)).toBe(signature)
    expect(calls[1]?.command).toEqual([
      '/sparkle/sign_update',
      '--ed-key-file',
      '-',
      '--verify',
      'CmdPalm.zip',
      signature,
    ])
    expect(calls[1]?.input).toBe(env.SPARKLE_PRIVATE_KEY)
  })

  test('a failed archive verification stops the release', () => {
    const results = [
      { status: 0, stdout: 'signature', stderr: '' },
      { status: 1, stdout: '', stderr: 'invalid signature' },
    ]
    const exec: Run = () => results.shift()!
    expect(() => sign('CmdPalm.zip', { SPARKLE_SIGN_UPDATE: '/sparkle/sign_update' }, exec)).toThrow(
      'archive signature verification failed',
    )
  })
})
