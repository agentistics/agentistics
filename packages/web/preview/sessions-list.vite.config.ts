// Dev-only preview of the sessions list redesign ("A + C + D", 2026-10-23). Not shipped.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  root: fileURLToPath(new URL('./sessions-list', import.meta.url)),
  publicDir: fileURLToPath(new URL('../public', import.meta.url)),
  define: { __BRAND_TAGS__: '{}', __APP_VERSION__: '"preview"' },
  plugins: [react()],
  server: { host: '127.0.0.1', strictPort: true, fs: { allow: [fileURLToPath(new URL('../../..', import.meta.url))] } },
})
