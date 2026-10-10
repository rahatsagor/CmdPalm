import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// During development, run the Mac app (or `cargo run --example dev-host`) and
// point the proxy at it so the client talks to a real host.
const host = process.env.CMDPALM_HOST ?? 'http://127.0.0.1:8790'
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig({
  plugins: [vue(), tailwindcss()],
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
