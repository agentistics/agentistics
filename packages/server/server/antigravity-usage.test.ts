import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readAntigravityCredential } from './antigravity-credential'
import type { PlanLimits } from '@agentistics/core'
import { agyLiveFrom, antigravityAccessToken, fetchAntigravityUsage, startAntigravityUsagePoll, __resetAntigravityUsageForTest, type AntigravityUsageDeps } from './antigravity-usage'

const body = JSON.parse(readFileSync(join(import.meta.dir, '../../core/src/__fixtures__/agy-fetch-models.json'), 'utf8'))
const NOW = Date.parse('2026-10-28T12:00:00Z')
const SECRET = 'ya29.FAKE-TOKEN-for-tests-only'
const cred = (over: Record<string, unknown> = {}, method: unknown = 'consumer') => JSON.stringify({
  auth_method: method, token: { access_token: SECRET, expiry: new Date(NOW + 3_600_000).toISOString(), ...over },
})
const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })

interface Rig { deps: AntigravityUsageDeps; calls: { url: string; init: RequestInit }[]; ingested: PlanLimits[]; logs: string[] }
function rig(over: Partial<AntigravityUsageDeps> & { reply?: (url: string) => Response } = {}): Rig {
  const calls: Rig['calls'] = [], ingested: PlanLimits[] = [], logs: string[] = []
  const reply = over.reply ?? ((url: string) => url.endsWith('loadCodeAssist') ? ok({ paidTier: { name: 'Google AI Plus' } }) : ok(body))
  return {
    calls, ingested, logs,
    deps: {
      root: '/fake/agy', now: () => NOW, agyLive: async () => true,
      readToken: async () => cred(), readProjectId: async () => 'proj-anon-0000\n',
      fetchImpl: async (url, init) => { calls.push({ url, init }); return reply(url) },
      ingest: async l => { ingested.push(l) },
      ...over,
    },
  }
}

beforeEach(() => __resetAntigravityUsageForTest())

describe('antigravityAccessToken', () => {
  test('a live consumer token', () => expect(antigravityAccessToken(cred(), NOW)).toEqual({ token: SECRET, method: 'consumer' }))
  test('missing / unparseable / empty → no-credential', () => {
    for (const raw of [null, '', 'not json', JSON.stringify({ token: {} })]) expect(antigravityAccessToken(raw, NOW)).toEqual({ skip: 'no-credential' })
  })
  test('expired, within the margin, or no readable expiry → expired', () => {
    expect(antigravityAccessToken(cred({ expiry: new Date(NOW - 1000).toISOString() }), NOW)).toEqual({ skip: 'expired' })
    expect(antigravityAccessToken(cred({ expiry: new Date(NOW + 30_000).toISOString() }), NOW)).toEqual({ skip: 'expired' })
    expect(antigravityAccessToken(cred({ expiry: 'soon' }), NOW)).toEqual({ skip: 'expired' })
  })
  test('unknown auth method → unknown-auth', () => expect(antigravityAccessToken(cred({}, 'magic'), NOW)).toEqual({ skip: 'unknown-auth' }))
})

describe('fetchAntigravityUsage', () => {
  test('body → an antigravity record with the plan label, one fetchAvailableModels call + one loadCodeAssist', async () => {
    const r = rig()
    const res = await fetchAntigravityUsage(r.deps)
    expect('limits' in res && res.limits.harness).toBe('antigravity')
    expect('limits' in res && res.limits.plan).toBe('Google AI Plus')
    expect('limits' in res && res.limits.windows.length).toBe(2)
    expect(r.calls.map(c => c.url)).toEqual([
      'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
      'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
    ])
    expect(JSON.parse(r.calls[0]!.init.body as string)).toEqual({ project: 'proj-anon-0000' })
  })
  test('the plan label is asked once per 6 h', async () => {
    const r = rig()
    await fetchAntigravityUsage(r.deps); await fetchAntigravityUsage(r.deps)
    expect(r.calls.filter(c => c.url.endsWith('loadCodeAssist'))).toHaveLength(1)
  })
  test('a loadCodeAssist failure never blocks the record', async () => {
    const r = rig({ reply: url => url.endsWith('loadCodeAssist') ? ok({}, 500) : ok(body) })
    const res = await fetchAntigravityUsage(r.deps)
    expect('limits' in res && res.limits.plan).toBeUndefined()
  })
  test('gcp auth uses the non-daily host', async () => {
    const r = rig({ readToken: async () => cred({}, 'gcp') })
    await fetchAntigravityUsage(r.deps)
    expect(r.calls[0]!.url.startsWith('https://cloudcode-pa.googleapis.com/')).toBe(true)
  })
  test('expired token → no fetch', async () => {
    const r = rig({ readToken: async () => cred({ expiry: new Date(NOW - 1).toISOString() }) })
    expect(await fetchAntigravityUsage(r.deps)).toEqual({ skip: 'expired' })
    expect(r.calls).toHaveLength(0)
  })
  test('unknown auth → no fetch', async () => {
    const r = rig({ readToken: async () => cred({}, 'other') })
    expect(await fetchAntigravityUsage(r.deps)).toEqual({ skip: 'unknown-auth' })
    expect(r.calls).toHaveLength(0)
  })
  test('no agy alive → no fetch, and the token is not even read', async () => {
    let read = false
    const r = rig({ agyLive: async () => false, readToken: async () => { read = true; return cred() } })
    expect(await fetchAntigravityUsage(r.deps)).toEqual({ skip: 'no-agy' })
    expect(r.calls).toHaveLength(0)
    expect(read).toBe(false)
  })
  test('no project id → no-project, no fetch', async () => {
    const r = rig({ readProjectId: async () => null })
    expect(await fetchAntigravityUsage(r.deps)).toEqual({ skip: 'no-project' })
    expect(r.calls).toHaveLength(0)
  })
  test('429 → rate-limited; 401/403/500 → http; garbage → unparseable; throw → network', async () => {
    expect(await fetchAntigravityUsage(rig({ reply: () => ok({}, 429) }).deps)).toEqual({ skip: 'rate-limited' })
    for (const s of [401, 403, 500]) expect(await fetchAntigravityUsage(rig({ reply: () => ok({}, s) }).deps)).toEqual({ skip: 'http' })
    expect(await fetchAntigravityUsage(rig({ reply: () => new Response('<html>') }).deps)).toEqual({ skip: 'unparseable' })
    expect(await fetchAntigravityUsage(rig({ reply: () => ok({ models: {} }) }).deps)).toEqual({ skip: 'unparseable' })
    expect(await fetchAntigravityUsage(rig({ fetchImpl: async () => { throw new Error(`boom ${SECRET}`) } }).deps)).toEqual({ skip: 'network' })
  })
  test('the token only ever appears in the Authorization header', async () => {
    const r = rig()
    const res = await fetchAntigravityUsage(r.deps)
    const out = JSON.stringify(res)
    expect(out.includes(SECRET)).toBe(false)
    for (const c of r.calls) {
      expect(String(c.init.body ?? '').includes(SECRET)).toBe(false)
      expect(c.url.includes(SECRET)).toBe(false)
      expect((c.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`)
    }
    for (const skip of [
      await fetchAntigravityUsage(rig({ fetchImpl: async () => { throw new Error(SECRET) } }).deps),
      await fetchAntigravityUsage(rig({ reply: () => ok({}, 401) }).deps),
    ]) expect(JSON.stringify(skip).includes(SECRET)).toBe(false)
  })
})

describe('startAntigravityUsagePoll', () => {
  test('AGENTISTICS_ANTIGRAVITY_USAGE=0 starts nothing', async () => {
    process.env.AGENTISTICS_ANTIGRAVITY_USAGE = '0'
    try {
      const r = rig()
      startAntigravityUsagePoll(r.deps)()
      await Bun.sleep(20)
      expect(r.calls).toHaveLength(0)
    } finally { delete process.env.AGENTISTICS_ANTIGRAVITY_USAGE }
  })
  test('a tick ingests an antigravity record from the default root, and never contains the token', async () => {
    const r = rig({ readToken: root => readAntigravityCredential(root, {
      platform: 'linux', defaultRoot: '/fake/agy',
      readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) },
      resolveExecutable: async () => '/fake/secret-tool',
      run: async () => ({ code: 0, stdout: `[/1]\nsecret = ${cred()}\ncreated = fixture\n` }),
    }) })
    const stop = startAntigravityUsagePoll(r.deps)
    await Bun.sleep(50)
    stop()
    expect(r.ingested).toHaveLength(1)
    expect(r.ingested[0]!.harness).toBe('antigravity')
    expect(JSON.stringify(r.ingested).includes(SECRET)).toBe(false)
  })
  test('nothing is ingested when agy is not running', async () => {
    const r = rig({ agyLive: async () => false })
    const stop = startAntigravityUsagePoll(r.deps)
    await Bun.sleep(30)
    stop()
    expect(r.ingested).toHaveLength(0)
    expect(r.calls).toHaveLength(0)
  })
})

describe('agyLiveFrom', () => {
  const no = async () => false, yes = async () => true
  test('a scanned process counts', async () => expect(await agyLiveFrom({ scanned: yes, managedRunning: no })).toBe(true))
  test('a running managed agy session counts even with no scanned process', async () => expect(await agyLiveFrom({ scanned: no, managedRunning: yes })).toBe(true))
  test('neither → not alive; a throwing source never fails the other', async () => {
    expect(await agyLiveFrom({ scanned: no, managedRunning: no })).toBe(false)
    const boom = async (): Promise<boolean> => { throw new Error('x') }
    expect(await agyLiveFrom({ scanned: boom, managedRunning: yes })).toBe(true)
    expect(await agyLiveFrom({ scanned: boom, managedRunning: boom })).toBe(false)
  })
})
