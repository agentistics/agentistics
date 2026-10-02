import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyExperimentalFromDisk, readExperimentalPreference } from './experimental-boot'

function dirWith(content?: string): string {
  const d = mkdtempSync(join(tmpdir(), 'exp-boot-'))
  if (content !== undefined) writeFileSync(join(d, 'preferences.json'), content)
  return d
}

describe('experimental-boot', () => {
  test('missing, corrupt or non-boolean reads as unset', () => {
    expect(readExperimentalPreference(join(dirWith(), 'preferences.json'))).toBeUndefined()
    expect(readExperimentalPreference(join(dirWith('{nope'), 'preferences.json'))).toBeUndefined()
    expect(readExperimentalPreference(join(dirWith('{"experimental":"yes"}'), 'preferences.json'))).toBeUndefined()
  })
  test('preference true applies the variables; false leaves the environment identical', () => {
    const on: Record<string, string | undefined> = { AGENTISTICS_DIR: dirWith('{"experimental":true}') }
    expect(applyExperimentalFromDisk(on).length).toBeGreaterThan(0)
    expect(on.AGENTISTICS_JOURNAL).toBe('1')
    const off: Record<string, string | undefined> = { AGENTISTICS_DIR: dirWith('{"experimental":false}') }
    const before = JSON.stringify(off)
    expect(applyExperimentalFromDisk(off)).toEqual([])
    expect(JSON.stringify(off)).toBe(before)
  })
  test('does not import config or preferences (they load JOURNAL_ENABLED)', async () => {
    const src = await Bun.file(join(import.meta.dir, 'experimental-boot.ts')).text()
    expect(src).not.toMatch(/from '\.\/(config|preferences)'/)
  })
})
