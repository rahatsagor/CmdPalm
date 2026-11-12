import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// During development, run the Mac app (or `cargo run --example dev-host`) and
// point the proxy at it so the client talks to a real host.
const host = process.env.CMDPALM_HOST ?? 'http://127.0.0.1:8790'
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

function serviceWorkerAssets(): Plugin {
  let outDir = 'dist'
  return {
    name: 'cmdpalm-sw-assets',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      const assetsDir = resolve(outDir, 'assets')
      const swPath = resolve(outDir, 'sw.js')
      const assets = readdirSync(assetsDir)
        .filter((name) => !name.startsWith('.') && !name.endsWith('.map'))
        .sort()
        .map((name) => `/assets/${name}`)
      const sw = readFileSync(swPath, 'utf8')
      if (!sw.includes('const PRECACHE_ASSETS = []')) {
        throw new Error('dist/sw.js is missing PRECACHE_ASSETS placeholder')
      }
      writeFileSync(swPath, sw.replace('const PRECACHE_ASSETS = []', `const PRECACHE_ASSETS = ${JSON.stringify(assets)}`))
    },
  }
}

export default defineConfig({
  plugins: [vue(), tailwindcss(), serviceWorkerAssets()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'safari16.4',
    assetsInlineLimit: 0,
    reportCompressedSize: false,
  },
  server: {
    proxy: {
      '/ws': { target: host.replace(/^http/, 'ws'), ws: true },
      '/api': host,
      '/cmdpalm.crt': host,
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
  },
})
