import { describe, expect, test } from 'bun:test'
import { withinOrNull } from './plan-limits-data'

describe('withinOrNull (USO.CARREGANDO: /api/plan-limits never waits for the whole data build)', () => {
  test('a value that settles in time is returned', async () => {
    expect(await withinOrNull(Promise.resolve(42), 50)).toBe(42)
  })
  test('a build that has not finished by the deadline yields null, promptly', async () => {
    const t0 = Date.now()
    expect(await withinOrNull(new Promise<number>(() => {}), 30)).toBeNull()
    expect(Date.now() - t0).toBeLessThan(500)
  })
  test('a failed build yields null, never a throw', async () => {
    expect(await withinOrNull(Promise.reject(new Error('boom')), 50)).toBeNull()
  })
})


test('the HTTP route samples cached data only, and bounds the entire optional live sample', async () => {
  const source = await Bun.file(new URL('./index.ts', import.meta.url)).text()
  const route = source.slice(source.indexOf("if (url.pathname === '/api/plan-limits'"), source.indexOf("if (url.pathname === '/api/events'"))
  expect(route).not.toContain('buildApiResponse(')
  expect(route).not.toContain('buildApiResponseForClient(')
  expect(route).toContain('peekApiResponse()')
  expect(route).toContain('loadDataSnapshot()')
  expect(route.indexOf('withinOrNull(')).toBeLessThan(route.indexOf('readLocalLiveSnapshot('))
  expect(route.indexOf('PLAN_LIMITS_DATA_WAIT_MS)')).toBeGreaterThan(route.indexOf('sampleLivePlanSessions(data.sessions'))
  expect(route).toContain('await planLimitsPayload(prefs.billing, now, liveSessions)')
})
