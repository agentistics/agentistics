import { expect, test } from 'bun:test'
import { readCompactFleetResponse } from './fleetStream'

test('legacy responses retain both shapes without fetching history', async () => {
  const old = { sessions: [{ id: 'a', verbs: [] }], rows: [{ id: 'a', title: 'old' }] }
  expect(await readCompactFleetResponse(old, () => { throw new Error('unexpected fetch') }, true)).toBe(old as any)
})

test('compact responses expand verbs and paged historical rows', async () => {
  const oldFetch = globalThis.fetch
  const hits: string[] = []
  globalThis.fetch = (async (url: string | URL | Request) => {
    hits.push(String(url))
    return Response.json({ sessions: [{ id: 'ended', state: 'exited', verbKey: 0 }], verbCatalog: [[{ action: 'resume', enabled: true }]], total: 1 })
  }) as unknown as typeof fetch
  try {
    const wire = await readCompactFleetResponse({ sessions: [{ id: 'live', harness: 'claude', verbKey: 0 }], verbCatalog: [[{ action: 'prompt', enabled: true }]], closed: { total: 1, sent: 0 } }, n => `/closed?offset=${n}`, true)
    expect(hits).toEqual(['/closed?offset=0'])
    expect(wire.rows.map(r => r.id)).toEqual(['live', 'ended'])
    expect((wire.sessions[1] as any).verbs[0].action).toBe('resume')
  } finally { globalThis.fetch = oldFetch }
})

test('changed history version never yields a mixed snapshot', async () => {
  const oldFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => ++calls === 1
    ? Response.json({ sessions: [{ id: 'ended', verbKey: 0 }], verbCatalog: [[]], total: 1 })
    : Response.json({ closed: { total: 1 }, closedVersion: 'new' })) as unknown as typeof fetch
  try {
    const wire = await readCompactFleetResponse({ sessions: [], verbCatalog: [], closed: { total: 1, sent: 0 }, closedVersion: 'old' }, () => '/closed', true, '/fleet')
    expect(wire.rows.map(r => r.id)).not.toContain('ended') // live rows only, the half-read page is discarded
  } finally { globalThis.fetch = oldFetch }
})

test('closed set changing mid-paging retries once from a fresh body', async () => {
  const oldFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url))
    const u = String(url)
    if (u === '/fleet') return Response.json({ sessions: [{ id: 'live', verbKey: 0 }], verbCatalog: [[]], closed: { total: 1, sent: 0 }, closedVersion: 'v2' })
    return Response.json({ sessions: [{ id: 'ended', state: 'exited', verbKey: 0 }], verbCatalog: [[]], total: urls.filter(x => x.startsWith('/closed')).length === 1 ? 2 : 1 })
  }) as unknown as typeof fetch
  try {
    const wire = await readCompactFleetResponse({ sessions: [{ id: 'live', verbKey: 0 }], verbCatalog: [[]], closed: { total: 1, sent: 0 }, closedVersion: 'v1' }, n => `/closed?offset=${n}`, true, '/fleet')
    expect(urls.filter(u => u === '/fleet').length).toBe(2) // refetch + verify
    expect(wire.rows.map(r => r.id)).toEqual(['live', 'ended'])
  } finally { globalThis.fetch = oldFetch }
})

test('closed set still changing publishes live rows and keeps previous history', async () => {
  const oldFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => String(url) === '/fleet'
    ? Response.json({ sessions: [{ id: 'live', verbKey: 0 }], verbCatalog: [[]], closed: { total: 1, sent: 0 }, closedVersion: 'x' })
    : Response.json({ sessions: [{ id: 'ended', verbKey: 0 }], verbCatalog: [[]], total: 99 })) as unknown as typeof fetch
  try {
    const wire = await readCompactFleetResponse({ sessions: [{ id: 'live', verbKey: 0 }], verbCatalog: [[]], closed: { total: 1, sent: 0 }, closedVersion: 'x' }, n => `/closed?offset=${n}`, true, '/fleet',
      [{ id: 'live', state: 'working' }, { id: 'old-ended', state: 'lost' }] as never)
    expect(wire.rows.map(r => r.id)).toEqual(['live', 'old-ended'])
  } finally { globalThis.fetch = oldFetch }
})

test('rows a view already carried are not duplicated by history pages', async () => {
  const oldFetch = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ sessions: [{ id: 'named', state: 'lost', verbKey: 0 }, { id: 'other', state: 'lost', verbKey: 0 }], verbCatalog: [[]], total: 2 })) as unknown as typeof fetch
  try {
    const wire = await readCompactFleetResponse({ sessions: [{ id: 'live', verbKey: 0 }, { id: 'named', state: 'lost', verbKey: 0 }], verbCatalog: [[]], closed: { total: 2, sent: 0 } }, n => `/closed?offset=${n}`, true)
    expect(wire.rows.map(r => r.id)).toEqual(['live', 'named', 'other'])
  } finally { globalThis.fetch = oldFetch }
})
