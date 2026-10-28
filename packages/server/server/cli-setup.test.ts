import { describe, expect, test } from 'bun:test'
import { applyRecommendedDefaults, runSetup, SETUP_USAGE } from './cli-setup'
import { PREFERENCES_FILE, readPreferences, writePreferences } from './preferences'
import { rmSync } from 'node:fs'

describe('runSetup --help', () => {
  for (const flag of ['--help', '-h']) {
    test(`${flag} prints the usage and exits 0 without a TTY`, async () => {
      const chunks: string[] = []
      const orig = process.stdout.write.bind(process.stdout)
      process.stdout.write = ((c: string | Uint8Array) => { chunks.push(String(c)); return true }) as typeof process.stdout.write
      try {
        expect(await runSetup([flag])).toBe(0)
      } finally {
        process.stdout.write = orig
      }
      expect(chunks.join('')).toBe(SETUP_USAGE)
    })
  }
})

// `bun test` runs against a throwaway data dir (config.ts / data-dir.ts), so PREFERENCES_FILE is
// never the owner's.
describe('applyRecommendedDefaults', () => {
  const reset = () => rmSync(PREFERENCES_FILE, { force: true })

  test('an absent archive mode becomes consolidate, and a second run changes nothing', async () => {
    reset()
    expect(await applyRecommendedDefaults()).toContain('set to consolidate')
    expect((await readPreferences()).archiveMode).toBe('consolidate')
    expect(await applyRecommendedDefaults()).toContain('left unchanged')
    expect((await readPreferences()).archiveMode).toBe('consolidate')
    reset()
  })

  for (const mode of ['off', 'full'] as const) {
    test(`an existing '${mode}' is preserved`, async () => {
      reset()
      await writePreferences({ archiveMode: mode })
      expect(await applyRecommendedDefaults()).toContain(`already set to ${mode}`)
      expect((await readPreferences()).archiveMode).toBe(mode)
      reset()
    })
  }
})
