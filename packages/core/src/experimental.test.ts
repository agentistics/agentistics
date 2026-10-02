import { describe, expect, test } from 'bun:test'
import { EXPERIMENTAL_FEATURES, applyExperimental, resolveExperimental, EXPERIMENTAL_APPLIED_ENV } from './experimental'

describe('experimental features table', () => {
  test('every row names a distinct AGENTISTICS_ variable and both descriptions', () => {
    const envs = EXPERIMENTAL_FEATURES.map(f => f.env)
    expect(new Set(envs).size).toBe(envs.length)
    for (const f of EXPERIMENTAL_FEATURES) {
      expect(f.env.startsWith('AGENTISTICS_')).toBe(true)
      expect(f.description.en.length).toBeGreaterThan(0)
      expect(f.description.pt.length).toBeGreaterThan(0)
    }
  })
})

describe('applyExperimental — off is byte-identical', () => {
  for (const pref of [undefined, false]) {
    test(`preference ${String(pref)} touches nothing`, () => {
      const env: Record<string, string | undefined> = { PATH: '/bin', AGENTISTICS_JOURNAL: '0' }
      const before = JSON.stringify(env)
      expect(applyExperimental(pref, env)).toEqual([])
      expect(JSON.stringify(env)).toBe(before)
    })
  }
})

describe('applyExperimental — on', () => {
  test('sets every unset variable and records which', () => {
    const env: Record<string, string | undefined> = {}
    const applied = applyExperimental(true, env)
    expect(applied).toEqual(EXPERIMENTAL_FEATURES.map(f => f.id))
    for (const f of EXPERIMENTAL_FEATURES) expect(f.isOn(env[f.env])).toBe(true)
    expect(env[EXPERIMENTAL_APPLIED_ENV]).toBe(applied.join(','))
  })
  test('an explicit =0 wins and is left alone', () => {
    const env: Record<string, string | undefined> = { AGENTISTICS_JOURNAL: '0' }
    const applied = applyExperimental(true, env)
    expect(applied).not.toContain('journal')
    expect(env.AGENTISTICS_JOURNAL).toBe('0')
  })
  test('is idempotent', () => {
    const env: Record<string, string | undefined> = {}
    applyExperimental(true, env)
    const once = JSON.stringify(env)
    applyExperimental(true, env)
    expect(JSON.stringify(env)).toBe(once)
  })
})

describe('resolveExperimental', () => {
  test('default: off with source default', () => {
    for (const r of resolveExperimental(undefined, {})) expect(r).toMatchObject({ on: false, source: 'default', overridden: false })
  })
  test('preference on, nothing exported: source preference', () => {
    for (const r of resolveExperimental(true, {})) expect(r).toMatchObject({ on: true, source: 'preference' })
  })
  test('explicit =0 beats the preference and says overridden', () => {
    const j = resolveExperimental(true, { AGENTISTICS_JOURNAL: '0' }).find(r => r.id === 'journal')!
    expect(j).toMatchObject({ on: false, source: 'env', overridden: true, envValue: '0' })
  })
  test('explicit =1 with the preference off is on, source env', () => {
    const j = resolveExperimental(false, { AGENTISTICS_JOURNAL: '1' }).find(r => r.id === 'journal')!
    expect(j).toMatchObject({ on: true, source: 'env', overridden: false })
  })
  test('provider accepts only 1, like providerFlagOn', () => {
    const p = resolveExperimental(undefined, { AGENTISTICS_PROVIDER: 'true' }).find(r => r.id === 'provider')!
    expect(p.on).toBe(false)
  })
  test('what apply wrote is the preference, not an override', () => {
    const env: Record<string, string | undefined> = {}
    applyExperimental(true, env)
    for (const r of resolveExperimental(true, env)) expect(r).toMatchObject({ on: true, source: 'preference' })
  })
  test('a blank variable is not explicit', () => {
    expect(resolveExperimental(true, { AGENTISTICS_JOURNAL: '  ' }).find(r => r.id === 'journal')!.source).toBe('preference')
  })
})
