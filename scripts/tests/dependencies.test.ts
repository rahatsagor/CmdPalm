// Scoped security overrides must keep the APIs their real callers use.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const webRequire = createRequire(new URL('../../web/package.json', import.meta.url))
const beautifyRequire = createRequire(webRequire.resolve('js-beautify'))
const glob = beautifyRequire('glob') as { hasMagic(pattern: string): boolean; globSync(pattern: string, options: { cwd: string }): string[] }
const editorconfig = beautifyRequire('editorconfig') as { parseSync(file: string): { indent_style?: string; indent_size?: number } }
let directory = ''

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'cmdpalm-dependencies-'))
  mkdirSync(join(directory, 'src/nested'), { recursive: true })
  writeFileSync(join(directory, '.editorconfig'), 'root = true\n\n[*.{js,ts}]\nindent_style = space\nindent_size = 2\ninsert_final_newline = true\n')
  writeFileSync(join(directory, 'src/first.js'), 'function first(){return 1;}')
  writeFileSync(join(directory, 'src/nested/second.js'), 'function second(){return 2;}')
  writeFileSync(join(directory, 'src/ignored.ts'), 'const untouched = 1;')
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

test('patched glob and minimatch keep nested file selection and EditorConfig matching', () => {
  expect(glob.hasMagic('src/**/*.js')).toBe(true)
  expect(glob.hasMagic('src/first.js')).toBe(false)
  expect(glob.globSync('src/**/*.js', { cwd: directory }).sort()).toEqual(['src/first.js', 'src/nested/second.js'])
  const config = editorconfig.parseSync(join(directory, 'src/nested/second.js'))
  expect(config.indent_style).toBe('space')
  expect(config.indent_size).toBe(2)
})

test('js-beautify formats globbed files using EditorConfig through the overridden dependencies', () => {
  const result = Bun.spawnSync(['bun', webRequire.resolve('js-beautify/js/bin/js-beautify.js'), '--editorconfig', '--replace', 'src/**/*.js'], {
    cwd: directory, stdout: 'pipe', stderr: 'pipe',
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(readFileSync(join(directory, 'src/first.js'), 'utf8')).toBe('function first() {\n  return 1;\n}\n')
  expect(readFileSync(join(directory, 'src/nested/second.js'), 'utf8')).toBe('function second() {\n  return 2;\n}\n')
  expect(readFileSync(join(directory, 'src/ignored.ts'), 'utf8')).toBe('const untouched = 1;')
})
