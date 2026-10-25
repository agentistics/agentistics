import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
let createRoot: typeof import('react-dom/client').createRoot
let NotificationToasts: typeof import('./NotificationToasts').NotificationToasts
let NotificationBell: typeof import('./NotificationBell').NotificationBell
let MemoryRouter: typeof import('react-router-dom').MemoryRouter
let store: typeof import('../lib/notifications')
const realFetch = globalThis.fetch
const oldEventSource = globalThis.EventSource
const oldAct = (globalThis as any).IS_REACT_ACT_ENVIRONMENT
beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.EventSource = class { addEventListener() {} removeEventListener() {} close() {} } as never
  globalThis.fetch = (async (url: string) => url === '/api/away' ? Response.json({ state: null }) : url.includes('/clean/') ? Response.json(null) : new Response(null, { status: 503 })) as unknown as typeof fetch
  createRoot = (await import('react-dom/client')).createRoot
  NotificationToasts = (await import('./NotificationToasts')).NotificationToasts
  NotificationBell = (await import('./NotificationBell')).NotificationBell
  MemoryRouter = (await import('react-router-dom')).MemoryRouter
  store = await import('../lib/notifications')
})
afterAll(async () => {
  globalThis.fetch = realFetch; globalThis.EventSource = oldEventSource
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = oldAct
  await GlobalRegistrator.unregister()
})
const visibility = (hidden: boolean) => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: hidden ? 'hidden' : 'visible' }); document.dispatchEvent(new Event('visibilitychange')) }
async function mount(withHeaderBell = true) {
  visibility(false); store.clearNotifications()
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  await act(async () => root.render(<MemoryRouter>{withHeaderBell && <NotificationBell lang="en" />}<NotificationToasts lang="en" /></MemoryRouter>))
  return { host, close: async () => { await act(async () => root.unmount()); host.remove() } }
}
test('single new toast dismisses without losing its unread bell entry', async () => {
  const { host, close } = await mount()
  try {
    await act(async () => store.pushLocalNotification({ type: 'success', title: 'Saved' }))
    expect(host.querySelectorAll('[data-testid="notification-toast"]')).toHaveLength(1)
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="dismiss"]')!.click())
    await act(async () => { await Bun.sleep(300) })
    expect(host.querySelector('[data-testid="notification-toast"]')).toBeNull()
    expect(store.readNotifications()).toHaveLength(1)
    expect(store.readNotifications()[0]!.read).toBe(false)
  } finally { await close() }
})
test('burst summary opens the real bell by keyboard and preserves all 20 entries', async () => {
  const { host, close } = await mount()
  try {
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="Notifications"]')!.click())
    await act(async () => { for (let i = 0; i < 20; i++) store.pushLocalNotification({ type: 'info', title: `News ${i}` }) })
    expect(host.querySelectorAll('[data-testid="notification-toast"]')).toHaveLength(0)
    const summary = host.querySelector<HTMLElement>('[data-testid="notification-summary"]')!
    expect(summary.textContent).toContain('+20 more — open the bell')
    expect(store.readNotifications().filter(n => !n.read)).toHaveLength(20)
    await act(async () => summary.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(host.textContent).toContain('Clear all')
    expect(host.querySelectorAll('[data-bell-sticky-header]')).toHaveLength(1)
    expect(store.readNotifications()).toHaveLength(20)
    expect(store.readNotifications().every(n => n.read)).toBe(true)
  } finally { await close() }
})
test('hidden backlog waits for return and receives its full dismissal time', async () => {
  const { host, close } = await mount()
  try {
    await act(async () => visibility(true))
    await act(async () => { for (let i = 0; i < 20; i++) store.pushLocalNotification({ type: 'info', title: `Hidden ${i}` }) })
    expect(host.querySelector('[data-testid="notification-summary"]')).toBeNull()
    await act(async () => { await Bun.sleep(4800) })
    await act(async () => visibility(false))
    expect(host.querySelector('[data-testid="notification-summary"]')!.textContent).toContain('20 updates while you were away')
    expect(host.querySelectorAll('[data-testid="notification-toast"]')).toHaveLength(0)
    expect(store.readNotifications().filter(n => !n.read)).toHaveLength(20)
    await act(async () => { await Bun.sleep(4800) })
    expect(host.querySelector('[data-testid="notification-summary"]')).toBeNull()
  } finally { await close() }
}, 15000)
test('Nay and update records stay in bell without contributing to burst summaries', async () => {
  const { host, close } = await mount()
  try {
    await act(async () => { for (let i = 0; i < 20; i++) store.pushLocalNotification({ type: 'info', code: i % 2 ? 'session.turn_ended' : 'app.update_available' }) })
    expect(host.querySelector('[data-testid="notification-toast"]')).toBeNull()
    expect(host.querySelector('[data-testid="notification-summary"]')).toBeNull()
    expect(store.readNotifications()).toHaveLength(20)
  } finally { await close() }
})
test('global away mode also defers and aggregates updates until the owner returns', async () => {
  const { host, close } = await mount()
  const { refreshAway } = await import('../lib/awayMode')
  const previousFetch = globalThis.fetch
  try {
    // Parse the real away contract rather than mocking the hook.
    globalThis.fetch = (async () => Response.json({ state: { version: 1, on: true, since: new Date().toISOString(), until: null, authorised: [], note: '' } })) as unknown as typeof fetch
    await act(async () => { await refreshAway() })
    await act(async () => store.pushLocalNotification({ type: 'info', title: 'Away update' }))
    expect(host.querySelector('[data-testid="notification-toast"]')).toBeNull()
    globalThis.fetch = previousFetch
    await act(async () => { await refreshAway() })
    expect(host.querySelector('[data-testid="notification-summary"]')!.textContent).toContain('1 update while you were away')
  } finally { globalThis.fetch = previousFetch; await close() }
})
test('a delayed refresh received after returning still summarizes news dated during the absence', async () => {
  const { host, close } = await mount()
  const previousFetch = globalThis.fetch
  try {
    await act(async () => visibility(true))
    const ts = Date.now()
    await act(async () => visibility(false))
    globalThis.fetch = (async () => Response.json([{ id: 'late-backlog', type: 'info', ts, read: false, title: 'Delayed' }])) as unknown as typeof fetch
    await act(async () => { await store.refreshNotifications() })
    expect(host.querySelector('[data-testid="notification-toast"]')).toBeNull()
    expect(host.querySelector('[data-testid="notification-summary"]')!.textContent).toContain('1 update while you were away')
  } finally { globalThis.fetch = previousFetch; await close() }
})
test('summary opens one persistent bell panel even on a route without a header bell', async () => {
  const { host, close } = await mount(false)
  try {
    await act(async () => { for (let i = 0; i < 20; i++) store.pushLocalNotification({ type: 'info', title: `News ${i}` }) })
    await act(async () => host.querySelector<HTMLElement>('[data-testid="notification-summary"]')!.click())
    await act(async () => { await Bun.sleep(300) })
    expect(host.querySelector('[data-testid="notification-summary"]')).toBeNull()
    expect(host.textContent).toContain('Clear all')
    expect(host.querySelectorAll('[data-bell-sticky-header]')).toHaveLength(1)
    expect(store.readNotifications()).toHaveLength(20)
  } finally { await close() }
})
