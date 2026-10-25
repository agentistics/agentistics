import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

// The OS paints the window chrome (status bar, Android's gesture/navigation strip) from these
// colours. They were orange once and an installed WebAPK kept painting the strip orange.
const DARK = '#0a0a0f'

describe('app chrome colours stay on the dark base', () => {
  test('index.html theme-color', () => {
    const m = read('../../index.html').match(/<meta\s+name="theme-color"\s+content="([^"]+)"/)
    expect(m?.[1]?.toLowerCase()).toBe(DARK)
  })
  test('manifest theme_color / background_color', () => {
    const cfg = read('../../vite.config.ts')
    expect(cfg.match(/theme_color:\s*'([^']+)'/)?.[1]?.toLowerCase()).toBe(DARK)
    expect(cfg.match(/background_color:\s*'([^']+)'/)?.[1]?.toLowerCase()).toBe(DARK)
  })
  test('manifest names its identity explicitly (forces a WebAPK re-sync)', () => {
    const cfg = read('../../vite.config.ts')
    expect(cfg).toMatch(/\bid:\s*'\/'/)
    expect(cfg).toMatch(/\bscope:\s*'\/'/)
  })
})
