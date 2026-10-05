import { describe, expect, test } from 'bun:test'
import { EXPERIMENTAL_APPLIED_ENV } from '@agentistics/core'
import { applyExperimentalLive, buildExperimentalReport, setExperimental } from './experimental-web'
import { nativeExperimentalOn } from './native-gate'
import { providerFlagOn } from './config'
import { routeCapability } from './capability-guard'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Env = Record<string, string | undefined>

describe('buildExperimentalReport', () => {
  test('carries each feature words and whether the switch governs it', () => {
    const r = buildExperimentalReport(false, {})
    const provider = r.features.find(f => f.id === 'provider')!
    expect(provider.switchable).toBe(true)
    expect(provider.on).toBe(false)
    expect(provider.description.en.length).toBeGreaterThan(10)
    expect(provider.description.pt.length).toBeGreaterThan(10)
    // journal/projections are on by default: the preference is not what decides them
    expect(r.features.filter(f => !f.switchable).map(f => f.id).sort()).toEqual(['journal', 'projections'])
  })
})

const onApplied = () => {}

describe('setExperimental — applies live, never restarts', () => {
  test('enable: persists, flips the env every gate reads, and reports on', async () => {
    const env: Env = {}
    const writes: unknown[] = []
    const r = await setExperimental(true, { env, readPrefs: async () => ({}), writePrefs: async p => { writes.push(p) }, onApplied })
    expect(writes).toEqual([{ experimental: true }])
    expect(providerFlagOn(env)).toBe(true)
    expect(nativeExperimentalOn(env)).toBe(true)
    expect(r.enabled).toBe(true)
    expect(r.features.find(f => f.id === 'provider')!.on).toBe(true)
  })

  test('disable: persists, removes only what the preference wrote, reports off', async () => {
    const env: Env = {}
    await setExperimental(true, { env, readPrefs: async () => ({}), writePrefs: async () => {}, onApplied })
    const writes: unknown[] = []
    const r = await setExperimental(false, { env, readPrefs: async () => ({ experimental: true }), writePrefs: async p => { writes.push(p) }, onApplied })
    expect(writes).toEqual([{ experimental: false }])
    expect(nativeExperimentalOn(env)).toBe(false)
    expect(env[EXPERIMENTAL_APPLIED_ENV]).toBeUndefined()
    expect(r.enabled).toBe(false)
    expect(r.features.find(f => f.id === 'provider')!.on).toBe(false)
  })

  test('no change is not written again', async () => {
    const writes: unknown[] = []
    await setExperimental(true, { env: {}, readPrefs: async () => ({ experimental: true }), writePrefs: async p => { writes.push(p) }, onApplied })
    expect(writes).toEqual([])
  })

  test('an exported variable keeps deciding: disabling never removes it', () => {
    const env: Env = { AGENTISTICS_PROVIDER: '1' }
    applyExperimentalLive(false, env)
    expect(env.AGENTISTICS_PROVIDER).toBe('1')
  })

  test('route source: PUT never restarts anything', () => {
    const src = readFileSync(join(import.meta.dir, 'experimental-web.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(src).not.toMatch(/restart|spawn|Bun\.\$/i)
  })
})

describe('refused where the GET is refused', () => {
  test('the one path guards both methods under localShell', () => {
    expect(routeCapability('/api/experimental')).toBe('localShell')
  })
  test('a central answers 404 for GET and PUT alike', () => {
    const src = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8')
    const i = src.indexOf("url.pathname === '/api/experimental'")
    const block = src.slice(i, i + 700)
    expect(block).toContain("req.method === 'GET' || req.method === 'PUT'")
    expect(block).toMatch(/if \(TEAM_CENTRAL\) return new Response\('Not found', \{ status: 404/)
  })
})

describe('L1 — the switch refreshes what the server has cached', () => {
  test('after the state moves, onApplied runs once, after the env changed', async () => {
    const env: Env = {}
    const seen: boolean[] = []
    await setExperimental(true, { env, readPrefs: async () => ({}), writePrefs: async () => {}, onApplied: () => { seen.push(providerFlagOn(env)) } })
    expect(seen).toEqual([true])
  })
  test('the default refresh drops the cached /api/data and notifies SSE clients', () => {
    const src = readFileSync(join(import.meta.dir, 'experimental-web.ts'), 'utf8')
    expect(src).toMatch(/invalidateCache\(\)/)
    expect(src).toMatch(/triggerSseNotification\(\)/)
    expect(src).toMatch(/deps\.onApplied \?\? refreshAfterSwitch/)
  })
})
