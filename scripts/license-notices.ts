// Run on Bun after the Rust and web dependencies have been fetched. Collect
// upstream notice files from the resolved versions, including vendored crypto.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

function command(args: string[], cwd = root): string {
  const result = Bun.spawnSync(args, { cwd, stdout: 'pipe', stderr: 'pipe', maxBuffer: 64 * 1024 * 1024 })
  if (result.exitCode !== 0) throw new Error(`${args.join(' ')} failed: ${result.stderr.toString().trim()}`)
  return result.stdout.toString()
}

// Scan nested vendored code too: ring and AWS-LC carry several upstream
// notices beyond their top-level license. Never follow symlinks.
function noticeFiles(dir: string, licenseDirectory = false): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !['.git', 'target', 'node_modules'].includes(entry.name)) files.push(...noticeFiles(join(dir, entry.name), licenseDirectory || /^licen[cs]es?$/i.test(entry.name)))
    else if (entry.isFile() && (licenseDirectory || /^(?:unlicen[cs]e|licen[cs]e|copying|copyright|notice)(?:[._-]|$)/i.test(entry.name))) files.push(join(dir, entry.name))
  }
  return files.sort()
}

function notices(name: string, version: string, license: string | null, dir: string, extra?: string | null): string {
  const files = new Set(noticeFiles(dir))
  if (extra) files.add(resolve(dir, extra))
  let provenance = ''
  // Some workspace crates omit the repository's license in their published
  // tarball. These fallbacks are copied from that crate's exact VCS commit.
  if (!files.size) {
    const fallback = join(root, 'packaging/licenses/rust', `${name}-${version}`)
    if (existsSync(fallback)) {
      provenance = readFileSync(join(fallback, 'SOURCES.json'), 'utf8').trim()
      const sources = JSON.parse(provenance) as { name: string; version: string; files: { file: string; sha256: string }[] }
      if (sources.name !== name || sources.version !== version) throw new Error(`Wrong fallback license version for ${name}`)
      for (const source of sources.files) {
        const file = join(fallback, source.file)
        if (createHash('sha256').update(readFileSync(file)).digest('hex') !== source.sha256) throw new Error(`Changed upstream notice: ${file}`)
        files.add(file)
      }
      dir = fallback
    }
  }
  if (!files.size) throw new Error(`No upstream license text found for ${name} ${version}. Add a versioned notice before shipping.`)
  const seen = new Set<string>()
  const parts = [`${name} ${version}\nLicense: ${license ?? 'See upstream text'}\n`]
  for (const file of [...files].sort()) {
    const text = readFileSync(file, 'utf8').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    parts.push(`--- ${relative(dir, file)} ---\n${text}`)
  }
  if (!seen.size) throw new Error(`Empty upstream licenses for ${name} ${version}`)
  if (provenance) parts.push(`Upstream source provenance:\n${provenance}`)
  return parts.join('\n\n')
}

interface CargoPackage { id: string; name: string; version: string; authors: string[]; license: string | null; license_file: string | null; manifest_path: string }
interface Metadata {
  packages: CargoPackage[]
  workspace_members: string[]
  resolve: { nodes: { id: string; deps: { pkg: string; dep_kinds: { kind: string | null }[] }[] }[] }
}

function rustNotices(): string[] {
  const metadata = JSON.parse(command(['cargo', 'metadata', '--locked', '--offline', '--format-version', '1', '--filter-platform', 'aarch64-apple-darwin'])) as Metadata
  const core = metadata.packages.find((pkg) => pkg.name === 'cmdpalm-core')
  if (!core) throw new Error('Missing cmdpalm-core metadata')
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]))
  const included = new Set<string>()
  const visit = (id: string) => {
    if (included.has(id)) return
    included.add(id)
    const node = nodes.get(id)
    if (!node) throw new Error(`Missing resolved dependency: ${id}`)
    for (const dep of node.deps) if (dep.dep_kinds.some((kind) => kind.kind !== 'dev')) visit(dep.pkg)
  }
  visit(core.id)
  return metadata.packages.filter((pkg) => included.has(pkg.id) && !metadata.workspace_members.includes(pkg.id))
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'))
    .map((pkg) => `Source: https://crates.io/crates/${pkg.name}/${pkg.version}\nAuthors listed by upstream: ${pkg.authors.join(', ')}\n\n${notices(pkg.name, pkg.version, pkg.license, dirname(pkg.manifest_path), pkg.license_file)}`)
}

interface BunLicense { name: string; versions: string[]; paths: string[]; license: string }
function webNotices(): string[] {
  const licenses = JSON.parse(command(['bun', 'pm', 'licenses', '--prod', '--json'], join(root, 'web'))) as Record<string, BunLicense[]>
  const packages = Object.values(licenses).flat().map((pkg) => ({ name: pkg.name, path: pkg.paths[0]! }))
  // Tailwind's preflight CSS and Vite's preload helper are emitted into the
  // client even though their packages are development dependencies.
  for (const name of ['tailwindcss', 'vite']) packages.push({ name, path: join(root, 'web/node_modules', name) })
  return packages.sort((a, b) => a.name.localeCompare(b.name, 'en')).map((pkg) => {
    const manifest = JSON.parse(readFileSync(join(pkg.path, 'package.json'), 'utf8')) as { name: string; version: string; license: string }
    return `Source: https://www.npmjs.com/package/${manifest.name}/v/${manifest.version}\n\n${notices(manifest.name, manifest.version, manifest.license, pkg.path)}`
  })
}

function sparkleNotices(): string {
  const project = readFileSync(join(root, 'apple/project.yml'), 'utf8')
  const version = project.match(/Sparkle:\s*\n\s+url:[^\n]*\n\s+exactVersion:\s*([^\s]+)/)?.[1]
  const file = join(root, 'packaging/licenses', `Sparkle-${version}.txt`)
  if (!version || !existsSync(file)) throw new Error('Add the exact Sparkle release LICENSE to packaging/licenses after upgrading Sparkle.')
  return `Sparkle ${version}\nSource: https://github.com/sparkle-project/Sparkle/blob/${version}/LICENSE\n\n${readFileSync(file, 'utf8').trim()}`
}

const output = process.argv[2]
if (!output) throw new Error('Usage: bun scripts/license-notices.ts <output.txt>')
const sections = [
  'CmdPalm licenses and third-party notices\n\nGenerated from resolved dependency sources. Includes build dependencies of the Rust core and web packages whose code may be included in the client. The presence of a notice does not mean every component is shipped.',
  `CmdPalm\nSource: https://github.com/rahatsagor/CmdPalm\nLicense: AGPL-3.0-only\n\n${readFileSync(join(root, 'LICENSE'), 'utf8').trim()}`,
  sparkleNotices(), ...rustNotices(), ...webNotices(),
  `Standard MIT license form referenced by the objc2 upstream notices\nSource: https://spdx.org/licenses/MIT.txt\nThe MIT option is used for these crates. Upstream author information and licensing policies appear in their individual notices above.\n\n${readFileSync(join(root, 'packaging/licenses/standard/MIT.txt'), 'utf8').trim()}`,
]
mkdirSync(dirname(resolve(output)), { recursive: true })
writeFileSync(output, `${sections.join('\n\n' + '='.repeat(78) + '\n\n')}\n`)
console.log(`Wrote ${sections.length - 3} dependency notices to ${output}`)
