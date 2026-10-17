/**
 * PROTOTYPE ONLY (CHAT.ACTIVITY) — a throwaway vite root that mounts the real chat components over
 * mocked turns. Never built into the product; run it with
 *   agentop run --rm -- bunx vite --config packages/web/proto/vite.config.ts --port <free port>
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('./chat-activity', import.meta.url)),
  define: { __BRAND_TAGS__: '{}', __APP_VERSION__: '"proto"' },
  publicDir: fileURLToPath(new URL('../public', import.meta.url)),
  plugins: [react()],
  server: { fs: { allow: [fileURLToPath(new URL('../../..', import.meta.url))] }, strictPort: true },
})
