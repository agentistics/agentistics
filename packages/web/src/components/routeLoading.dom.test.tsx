import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { PageRouteFrame } from './PageRouteFrame'
import { DeliveryCalendar } from './calendar/DeliveryCalendar'
import { LiveDeliveryView } from './tasks/LiveDelivery'
import { resetLiveCache, useLiveDeliveries } from './tasks/useLiveDeliveries'
import { ROUTE_HARD_TIMEOUT_MS } from '../lib/routeTransport'
import { eventStream } from '../lib/eventStream'

let root: Root | undefined
const realFetch = globalThis.fetch
const realTimeout = globalThis.setTimeout
const realInterval = globalThis.setInterval
let subscription: ReturnType<typeof spyOn>

function Live() {
  const state = useLiveDeliveries([])
  return <LiveDeliveryView {...state} lang="pt" fleet={[]} accountLabels={{}} onRetry={() => void state.reload()} />
}

beforeAll(() => {
  GlobalRegistrator.register({ width: 1280, height: 800 })
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: undefined })
  subscription = spyOn(eventStream, 'subscribe').mockReturnValue(() => {})
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  globalThis.fetch = realFetch
  globalThis.setTimeout = realTimeout
  globalThis.setInterval = realInterval
  resetLiveCache()
  document.body.innerHTML = ''
})
afterAll(async () => { subscription.mockRestore(); await GlobalRegistrator.unregister() })

async function mount(route: 'live' | 'calendar', width: number) {
  ;(window as unknown as { happyDOM: { setWindowSize(v: { width: number; height: number }): void } }).happyDOM.setWindowSize({ width, height: 800 })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<MemoryRouter>
    <main style={{ position: 'relative', height: 620, display: 'flex', flexDirection: 'column' }}>
      <PageRouteFrame compact={width === 390} scrollRef={null} maxWidth="100%">
        <header style={{ height: 100 }}>Toolbar above the route</header>
        <div data-route-panel={route} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {route === 'live' ? <Live /> : <DeliveryCalendar lang="pt" />}
        </div>
      </PageRouteFrame>
    </main>
  </MemoryRouter>))
}

for (const route of ['live', 'calendar'] as const) {
  test(`L4 ${route}: heartbeat cannot cancel the deadline; the alert survives background retries until a reply arrives`, async () => {
    let heartbeat: (() => void) | undefined
    let deadline: (() => void) | undefined
    let calls = 0
    let finish: ((response: Response) => void) | undefined
    globalThis.setInterval = ((callback: () => void, ms?: number) => {
      if (ms === 60_000) heartbeat = callback
      return realInterval(callback, ms)
    }) as typeof setInterval
    globalThis.setTimeout = ((callback: () => void, ms?: number) => {
      if (ms === ROUTE_HARD_TIMEOUT_MS) deadline = callback
      return realTimeout(callback, ms)
    }) as typeof setTimeout
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
      calls++
      return new Promise<Response>((resolve, reject) => {
        finish = resolve
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    }) as typeof fetch
    await mount(route, 390)
    // A fleet/book refresh can shift the request's start past the heartbeat's start. The
    // heartbeat then runs BEFORE the pending request's 60 s deadline, as in the browser QA.
    await act(async () => heartbeat!())
    expect(calls).toBe(1)
    await act(async () => deadline!())
    expect(document.querySelector('[role="alert"]')).not.toBeNull()
    expect(document.querySelector('[data-placement="fill"]')).toBeNull()
    await act(async () => heartbeat!())
    expect(calls).toBe(2)
    const alert = document.querySelector('[role="alert"]')!
    expect(alert).not.toBeNull()
    expect(alert.querySelector('button')!.style.border).not.toBe('')
    await act(async () => finish!(Response.json(route === 'live'
      ? { generatedAt: 'x', deliveries: [], samples: 0 }
      : { pieces: [], versions: [], marks: [] })))
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  test(`L1 ${route}: pending route fills the panel, including the toolbar, even with a zero-height route wrapper`, async () => {
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })) as typeof fetch
    for (const width of [1280, 390]) {
      await mount(route, width)
      const loader = document.querySelector<HTMLElement>('[data-placement="fill"]')!
      expect(loader !== null).toBe(true)
      // happy-dom does not lay out boxes. Assert the CSS containing-block chain instead: an
      // absolute full-panel surface must bypass the content-sized/zero-height route ancestors.
      const surface = loader.parentElement!
      expect(surface.style.position).toBe('absolute')
      expect(parseFloat(surface.style.inset)).toBe(0)
      let containingBlock = surface.parentElement!
      while (containingBlock.tagName !== 'MAIN' && !['relative', 'absolute', 'fixed'].includes(containingBlock.style.position)) containingBlock = containingBlock.parentElement!
      expect(containingBlock.tagName).toBe('MAIN')
      await act(async () => root?.unmount())
      root = undefined
      document.body.innerHTML = ''
    }
  })

  test(`L4 ${route}: hard timeout replaces the loader with a local alert and styled, working retry`, async () => {
    let calls = 0
    let timedOut = false
    globalThis.setTimeout = ((callback: TimerHandler, ms?: number, ...args: unknown[]) => realTimeout(callback, ms === ROUTE_HARD_TIMEOUT_MS ? 10 : ms, ...args)) as typeof setTimeout
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
      calls++
      if (timedOut) return Promise.resolve(new Response('{}', { status: 503 }))
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => {
        timedOut = true
        reject(new DOMException('Aborted', 'AbortError'))
      }, { once: true }))
    }) as typeof fetch
    await mount(route, 1280)
    await act(async () => { await new Promise(resolve => realTimeout(resolve, 30)) })
    expect(timedOut).toBe(true)
    expect(document.querySelector('[data-placement="fill"]') === null).toBe(true)
    const alert = document.querySelector('[role="alert"]')!
    expect(alert !== null).toBe(true)
    expect(alert.textContent).toMatch(/entregas|calendário/i)
    const retry = alert.querySelector('button')!
    expect(retry.textContent).toBe('Tentar de novo')
    expect(retry.style.border).not.toBe('')
    expect(retry.style.background).not.toBe('')
    await act(async () => { retry.click(); await new Promise(resolve => realTimeout(resolve, 550)) })
    expect(calls).toBe(2)
  })
}
