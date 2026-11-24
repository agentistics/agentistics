import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export default defineConfig({ plugins: [react()], cacheDir: join(tmpdir(), 'vault-mac-vite') })
