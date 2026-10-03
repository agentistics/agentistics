/**
 * The native harness and the providers are experimental (owner decision 2026-10-03). The TUI shows
 * native figures only through the server's `/api/runtime/metrics`, which leaves the native harness
 * out while the flag is off (`native-gate.ts`), and reaches no native or provider route of its own.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return sources(p)
    return /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : []
  })
}

describe('TUI: no native or provider surface of its own', () => {
  test('no source names a native or provider route', () => {
    for (const f of sources(import.meta.dir)) {
      const src = readFileSync(f, 'utf8')
      expect(src.includes('/api/runtime/sessions')).toBe(false)
      expect(src.includes('/api/provider')).toBe(false)
    }
  })
})
