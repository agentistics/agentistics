import { describe, expect, test } from 'bun:test'
import { EXPERIMENTAL_APPLIED_ENV, applyExperimental, featureOn } from '@agentistics/core'
import { applyExperimentalLive, buildExperimentalReport, setExperimental } from './experimental-web'
import { nativeExperimentalOn } from './native-gate'
import { providerFlagOn } from './config'
import { routeCapability } from './capability-guard'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { applyExperimentalFromDisk, readExperimentalPreference } from './experimental-boot'
import { join } from 'node:path'

type Env = Record<string, string | undefined>
const onApplied = () => {}

describe('buildExperimentalReport', () => {
  test('carries each feature words and whether the switch governs it', () => {
    const r = buildExperimentalReport(false, {})
    const provider = r.features.find(f => f.id === 'provider')!
    expect(provider.switchable).toBe(true)
    expect(provider.on).toBe(false)
    expect(provider.description.en.length).toBeGreaterThan(10)
    expect(provider.description.pt.length).toBeGreaterThan(10)
    // journal/projections/adapter-chat are on by default: the preference is not what decides them
    expect(r.features.filter(f => !f.switchable).map(f => f.id).sort()).toEqual(['journal', 'projections'])
    expect(r.features.find(f => f.id === 'adapter-chat')!.switchable).toBe(true)
  })
})

describe('adapter-chat — default ON, switchable OFF', () => {
  const on = (env: Env) => featureOn('adapter-chat', env)
  test('nothing set: ON', () => { expect(on({})).toBe(true) })
  test('env 0: OFF, even with the global switch on', async () => {
    const env: Env = { AGENTISTICS_ADAPTER_CHAT: '0' }
    await setExperimental(true, { env, readPrefs: async () => ({}), writePrefs: async () => {}, onApplied })
    expect(on(env)).toBe(false)
  })
  test('global experimental OFF: OFF live, ON again when re-enabled, no restart', async () => {
    const env: Env = {}
    const r = await setExperimental(false, { env, readPrefs: async () => ({}), writePrefs: async () => {}, onApplied })
    expect(on(env)).toBe(false)
    expect(r.features.find(f => f.id === 'adapter-chat')!.on).toBe(false)
    await setExperimental(true, { env, readPrefs: async () => ({ experimental: false }), writePrefs: async () => {}, onApplied })
    expect(on(env)).toBe(true)
  })
  test('boot with preference false: OFF; with an exported 1 it stays ON', () => {
    const env: Env = {}
    applyExperimental(false, env)
    expect(on(env)).toBe(false)
    const env2: Env = { AGENTISTICS_ADAPTER_CHAT: '1' }
    applyExperimental(false, env2)
    expect(on(env2)).toBe(true)
  })
  test('row off (report): preference false reports it off, absent reports it on', () => {
    expect(buildExperimentalReport(false, {}).features.find(f => f.id === 'adapter-chat')!.on).toBe(false)
    expect(buildExperimentalReport(undefined, {}).features.find(f => f.id === 'adapter-chat')!.on).toBe(true)
  })
})


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
    expect(src).toMatch(/resetChatStreams\(\)/) // open chat streams reconnect to the reader the switch names now
    expect(src).toMatch(/invalidateCache\(\)/)
    expect(src).toMatch(/triggerSseNotification\(\)/)
    expect(src).toMatch(/deps\.onApplied \?\? refreshAfterSwitch/)
  })
})

describe('F4 fix2 — OFF from an ABSENT preference is persisted', () => {
  /** A preferences file the switch really writes and a fresh process really boots from. */
  function store(initial: Record<string, unknown> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'exp-persist-'))
    const file = join(dir, 'preferences.json')
    writeFileSync(file, JSON.stringify(initial))
    const read = async () => JSON.parse(readFileSync(file, 'utf8')) as { experimental?: boolean }
    const write = async (patch: { experimental: boolean }) => {
      writeFileSync(file, JSON.stringify({ ...(await read()), ...patch }))
    }
    return { dir, file, read, write }
  }

  test('absent -> OFF writes `experimental: false`', async () => {
    const st = store()
    const writes: unknown[] = []
    await setExperimental(false, { env: {}, readPrefs: st.read, writePrefs: async p => { writes.push(p); await st.write(p) }, onApplied })
    expect(writes).toEqual([{ experimental: false }])
    expect(readExperimentalPreference(st.file)).toBe(false)
  })

  test('a later GET (same process) still reports adapter-chat OFF', async () => {
    const st = store()
    const env: Env = {}
    await setExperimental(false, { env, readPrefs: st.read, writePrefs: st.write, onApplied })
    const report = buildExperimentalReport((await st.read()).experimental, env)
    expect(report.features.find(f => f.id === 'adapter-chat')!.on).toBe(false)
  })

  test('a RESTART (fresh env, boot from disk) comes back OFF', async () => {
    const st = store()
    await setExperimental(false, { env: {}, readPrefs: st.read, writePrefs: st.write, onApplied })
    const fresh: Env = { AGENTISTICS_DIR: st.dir }
    applyExperimentalFromDisk(fresh)
    expect(featureOn('adapter-chat', fresh)).toBe(false)
    expect(buildExperimentalReport(readExperimentalPreference(st.file), fresh).features.find(f => f.id === 'adapter-chat')!.on).toBe(false)
  })

  test('re-enable after a restart turns it back ON and persists that too', async () => {
    const st = store()
    await setExperimental(false, { env: {}, readPrefs: st.read, writePrefs: st.write, onApplied })
    const fresh: Env = { AGENTISTICS_DIR: st.dir }
    applyExperimentalFromDisk(fresh)
    await setExperimental(true, { env: fresh, readPrefs: st.read, writePrefs: st.write, onApplied })
    expect(featureOn('adapter-chat', fresh)).toBe(true)
    expect(readExperimentalPreference(st.file)).toBe(true)
    const again: Env = { AGENTISTICS_DIR: st.dir }
    applyExperimentalFromDisk(again)
    expect(featureOn('adapter-chat', again)).toBe(true)
  })

  test('an explicit false is not written again', async () => {
    const writes: unknown[] = []
    await setExperimental(false, { env: {}, readPrefs: async () => ({ experimental: false }), writePrefs: async p => { writes.push(p) }, onApplied })
    expect(writes).toEqual([])
  })
})

describe('multi-account — default ON on a fresh machine, switchable OFF (CONTAS.MAC.NOVO)', () => {
  test('no preference and no variable: the report the accounts screen reads says ON', () => {
    const row = buildExperimentalReport(undefined, {}).features.find(f => f.id === 'multi-account')!
    expect(row).toMatchObject({ on: true, source: 'default', switchable: true })
    expect(featureOn('multi-account', {})).toBe(true)
  })
  test('the login routes stay behind localShell: the default does not widen the security gate', () => {
    expect(routeCapability('/api/accounts/roots')).toBe('localShell')
  })
  test('an explicit preference false still turns it off', () => {
    expect(buildExperimentalReport(false, {}).features.find(f => f.id === 'multi-account')!.on).toBe(false)
  })
})
