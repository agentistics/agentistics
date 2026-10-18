// Dev-only preview of Settings → Billing layout options (BILLING.SIMPLE phase 1). Not shipped.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  root: fileURLToPath(new URL('./billing', import.meta.url)),
  publicDir: fileURLToPath(new URL('../public', import.meta.url)),
  define: { __BRAND_TAGS__: '{}', __APP_VERSION__: '"preview"' },
  plugins: [react()],
  server: { host: '127.0.0.1', strictPort: true, fs: { allow: [fileURLToPath(new URL('../../..', import.meta.url))] } },
})
