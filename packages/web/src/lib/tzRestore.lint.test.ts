/**
 * `delete process.env.TZ` does not put the zone back under `bun test`: the runtime stays in the
 * zone that was last set, and every later assignment of `TZ` in the same run is ignored. One such
 * restore made unrelated date tests in later files fail only in multi-file runs.
 *
 * Restore with a value instead:
 *   const previous = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone
 *   …
 *   process.env.TZ = previous
 */
import { expect, test } from 'bun:test'
import { Glob } from 'bun'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const PACKAGES = resolve(import.meta.dir, '../../..')
const FORBIDDEN = /delete\s+process\.env(\.TZ\b|\[\s*['"]TZ['"]\s*\])/

test('no test file restores the time zone by deleting TZ', () => {
  const offenders: string[] = []
  let scanned = 0
  for (const file of new Glob('*/{src,server,scripts,bin}/**/*.test.{ts,tsx}').scanSync(PACKAGES)) {
    if (file.endsWith('tzRestore.lint.test.ts')) continue
    scanned++
    if (FORBIDDEN.test(readFileSync(join(PACKAGES, file), 'utf8'))) offenders.push(file)
  }
  expect(scanned).toBeGreaterThan(100)
  expect(offenders).toEqual([])
})
