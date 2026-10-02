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
  test('CLI: preference ON + no env turns the feature on; explicit =0 stays off; preference OFF changes nothing', () => {
    const on: Record<string, string | undefined> = { AGENTISTICS_DIR: dirWith('{"experimental":true}') }
    applyExperimentalFromDisk(on)
    expect(on.AGENTISTICS_PROVIDER).toBe('1')
    const off0: Record<string, string | undefined> = { AGENTISTICS_DIR: dirWith('{"experimental":true}'), AGENTISTICS_PROVIDER: '0' }
    applyExperimentalFromDisk(off0)
    expect(off0.AGENTISTICS_PROVIDER).toBe('0')
    const pref: Record<string, string | undefined> = { AGENTISTICS_DIR: dirWith('{"experimental":false}') }
    applyExperimentalFromDisk(pref)
    expect(pref.AGENTISTICS_PROVIDER).toBeUndefined()
  })
  test('bin/cli.ts applies the preference for every subcommand, before the first dispatch', async () => {
    const src = await Bun.file(join(import.meta.dir, '../bin/cli.ts')).text()
    const apply = src.indexOf('applyExperimentalFromDisk()')
    expect(apply).toBeGreaterThan(-1)
    expect(src.slice(src.lastIndexOf('\n', apply - 200), apply)).not.toMatch(/if \(command ===/)
    expect(apply).toBeLessThan(src.indexOf("command === 'mcp'") === -1 ? Infinity : src.indexOf("command === 'mcp'"))
  })
  test('the preference reaches JOURNAL_ENABLED in a fresh CLI-shaped process (journal sink on); explicit =0 wins', async () => {
    const run = async (env: Record<string, string>) => {
      const code = `const b = await import('./experimental-boot.ts'); b.applyExperimentalFromDisk(); const c = await import('./config.ts'); console.log(c.JOURNAL_ENABLED)`
      const p = Bun.spawn([process.execPath, '-e', code], { cwd: import.meta.dir, env: { PATH: process.env.PATH ?? '', ...env }, stdout: 'pipe' })
      return (await new Response(p.stdout).text()).trim()
    }
    const home = dirWith('{"experimental":true}')
    expect(await run({ AGENTISTICS_DIR: home, HOME: home })).toBe('true')
    expect(await run({ AGENTISTICS_DIR: home, HOME: home, AGENTISTICS_JOURNAL: '0' })).toBe('false')
    expect(await run({ AGENTISTICS_DIR: dirWith('{"experimental":false}'), HOME: home })).toBe('false')
  })
  test('does not import config or preferences (they load JOURNAL_ENABLED)', async () => {
    const src = await Bun.file(join(import.meta.dir, 'experimental-boot.ts')).text()
    expect(src).not.toMatch(/from '\.\/(config|preferences)'/)
  })
})
