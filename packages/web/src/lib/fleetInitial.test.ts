import { expect, test } from 'bun:test'
import { hasPendingFleetHistory, INITIAL_FLEET_SESSION_LIMIT, readFleetInPhases } from './fleetInitial'

test('the recent window is published before a blocked history page, then the remainder arrives', async () => {
  const originalFetch = globalThis.fetch
  let release!: (r: Response) => void
  const page = new Promise<Response>(r => { release = r })
  let pageStarted!: () => void
  const started = new Promise<void>(r => { pageStarted = r })
  const raw = {
    sessions: Array.from({ length: 15 }, (_, i) => ({ id: `closed:${i}`, state: 'closed', verbKey: 0 })),
    verbCatalog: [[]], closed: { total: 16, sent: 15 }, closedVersion: 'stable',
  }
  let initial: unknown
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url) === '/verify') return Response.json(raw)
    expect(String(url)).toBe('/closed?offset=15')
    pageStarted()
    return page
  }) as typeof fetch
  try {
    const all = readFleetInPhases(raw, n => `/closed?offset=${n}`, '/verify', [], wire => { initial = wire })
    await started
    expect(INITIAL_FLEET_SESSION_LIMIT).toBe(15)
    expect((initial as typeof raw).sessions).toHaveLength(15)
    release(Response.json({ sessions: [{ id: 'closed:older', state: 'closed', verbKey: 0 }], verbCatalog: [[]], total: 16 }))
    expect((await all).sessions).toHaveLength(16)
  } finally {
    release(Response.json({ sessions: [], total: 16 }))
    globalThis.fetch = originalFetch
  }
})


test('partial results remain labeled through the server phase and requested history pages', () => {
  const rows = [{ id: 'live', state: 'working' }, { id: 'closed:old', state: 'closed' }]
  expect(hasPendingFleetHistory({ rows, historyLoading: true }, false)).toBe(true)
  expect(hasPendingFleetHistory({ rows, closedTotal: 2 }, true)).toBe(true)
  expect(hasPendingFleetHistory({ rows, closedTotal: 2 }, false)).toBe(false)
  expect(hasPendingFleetHistory({ rows, closedTotal: 1 }, true)).toBe(false)
})
