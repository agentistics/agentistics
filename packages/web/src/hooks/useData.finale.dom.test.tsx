/**
 * UPDATE.FIM (2026-10-24): the end of the in-app update stuttered because the app beneath the finale
 * did its heavy first work there — on a real machine the full `/api/data` is 9 MB (too big for the
 * localStorage cache, so every post-update boot starts from nothing), and parsing it is a long task
 * on the finale's own thread. While the finale is up only the small slim answer may be asked for.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

let createRoot: typeof import('react-dom/client').createRoot
let useData: typeof import('./useData').useData
let gate: typeof import('../lib/finaleGate')
const realFetch = globalThis.fetch
let oldAct: boolean | undefined
const asked: string[] = []
/** When set, every request fails the way a busy, just-restarted server's do (a missed deadline). */
let serverDown = false

const payload = (extra: Record<string, unknown>) => Response.json({ statsCache: {}, sessions: [], projects: [], ...extra })

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  oldAct = (globalThis as any).IS_REACT_ACT_ENVIRONMENT
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  ;(globalThis as any).EventSource = class { addEventListener() {} removeEventListener() {} close() {} }
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    if (serverDown) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    if (url.startsWith('/api/data')) {
      asked.push(url)
      return url.includes('slim=1') ? payload({ partial: true, partialReason: 'slim' }) : payload({})
    }
    return Response.json({ ok: true })
  }) as typeof fetch
  createRoot = (await import('react-dom/client')).createRoot
  useData = (await import('./useData')).useData
  gate = await import('../lib/finaleGate')
})
afterEach(() => { serverDown = false; asked.length = 0; localStorage.clear(); gate.setFinaleForTest({ active: false, updatedAt: null }) })
afterAll(async () => { globalThis.fetch = realFetch; (globalThis as any).IS_REACT_ACT_ENVIRONMENT = oldAct; await GlobalRegistrator.unregister() })

let seen: ReturnType<typeof import('./useData').useData> | null = null
function Probe() { seen = useData(); return null }
const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)) })

async function mount() {
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(<Probe />) })
  return () => act(async () => { root.unmount() })
}

test('with no cache, the slim answer is asked at once and the full payload waits for the finale to leave', async () => {
  gate.setFinaleForTest({ active: true, updatedAt: Date.now() })
  const unmount = await mount()
  try {
    await wait(500)
    expect(asked).toEqual(['/api/data?partial=1&slim=1'])
    await act(async () => { gate.endFinale() })
    await wait(400)
    expect(asked).toEqual(['/api/data?partial=1&slim=1', '/api/data?partial=1'])
  } finally { await unmount() }
})

test('with a cached snapshot, nothing is fetched under the finale; the refresh goes when it leaves', async () => {
  localStorage.setItem('agentistics-data-cache-v1', JSON.stringify({ statsCache: {}, sessions: [], projects: [] }))
  gate.setFinaleForTest({ active: true, updatedAt: Date.now() })
  const unmount = await mount()
  try {
    await wait(300)
    expect(asked).toEqual([])
    await act(async () => { gate.endFinale() })
    await wait(300)
    expect(asked).toEqual(['/api/data?partial=1'])
  } finally { await unmount() }
})

test('an ordinary boot is unchanged: slim, then the full payload right after', async () => {
  const unmount = await mount()
  try {
    await wait(500)
    expect(asked).toEqual(['/api/data?partial=1&slim=1', '/api/data?partial=1'])
  } finally { await unmount() }
})

// The other half: with data on screen the liveness probe (2 s deadline) raised "The server is not
// answering … Try again" over the page while the new server was still building — as the finale ended.
const cached = () => localStorage.setItem('agentistics-data-cache-v1', JSON.stringify({ statsCache: {}, sessions: [], projects: [] }))

test('right after an update, a busy server does not raise the "not answering" strip', async () => {
  cached()
  gate.setFinaleForTest({ active: false, updatedAt: Date.now() })
  serverDown = true
  const unmount = await mount()
  try {
    await wait(2600)
    expect(seen!.offline).toBeNull()
    expect(seen!.data).not.toBeNull()
  } finally { await unmount() }
})

test('on an ordinary boot the same silence is reported, as before', async () => {
  cached()
  serverDown = true
  const unmount = await mount()
  try {
    await wait(2600)
    expect(seen!.offline).not.toBeNull()
  } finally { await unmount() }
})
