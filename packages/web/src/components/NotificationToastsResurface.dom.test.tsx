import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

// QA (not part of the delivery): the three guards of `resurfaced` that no test of the delivery pins.
// A row the server returns again with the SAME id and a NEWER ts must re-toast ONLY when it is an
// unread, unkeyed error. Copied temporarily next to StatusRefusalToast.dom.test.tsx to run.
let createRoot: typeof import('react-dom/client').createRoot
let NotificationToasts: typeof import('./NotificationToasts').NotificationToasts
let MemoryRouter: typeof import('react-router-dom').MemoryRouter
let store: typeof import('../lib/notifications')
const realFetch = globalThis.fetch
const oldES = globalThis.EventSource
const oldAct = (globalThis as any).IS_REACT_ACT_ENVIRONMENT
let serverList: Record<string, unknown>[] = []
beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.EventSource = class { addEventListener() {} removeEventListener() {} close() {} } as never
  createRoot = (await import('react-dom/client')).createRoot
  NotificationToasts = (await import('./NotificationToasts')).NotificationToasts
  MemoryRouter = (await import('react-router-dom')).MemoryRouter
  store = await import('../lib/notifications')
  globalThis.fetch = (async (url: string) => {
    if (url === '/api/away') return Response.json({ state: null })
    if (url.startsWith('/api/notifications')) return Response.json(serverList)
    return new Response(null, { status: 503 })
  }) as unknown as typeof fetch
})
afterAll(async () => {
  globalThis.fetch = realFetch; globalThis.EventSource = oldES
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = oldAct
  await GlobalRegistrator.unregister()
})

async function mount() {
  serverList = []; store.clearNotifications(); await Bun.sleep(5)
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  await act(async () => root.render(<MemoryRouter><NotificationToasts lang="en" /></MemoryRouter>))
  return { host, close: async () => { await act(async () => root.unmount()); host.remove() } }
}
const toasts = (h: HTMLElement) => h.querySelectorAll('[data-testid="notification-toast"]')

async function repeatOf(row: Record<string, unknown>, second: Record<string, unknown>) {
  const { host, close } = await mount()
  try {
    serverList = [{ ...row, ts: 1000 }]
    await act(async () => { await store.refreshNotifications() })
    const first = toasts(host).length
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="dismiss"]')?.click())
    await act(async () => { await Bun.sleep(300) })
    serverList = [{ ...row, ...second, ts: 2000 }]
    await act(async () => { await store.refreshNotifications() })
    return { first, again: toasts(host).length }
  } finally { await close() }
}

test('control: an unread unkeyed error returned with a newer ts re-toasts', async () => {
  const r = await repeatOf({ id: 'a', type: 'error', title: 'refused', read: false }, {})
  expect(r).toEqual({ first: 1, again: 1 })
})
test('a KEYED error (loading progress) returned with a newer ts does NOT re-toast', async () => {
  const r = await repeatOf({ id: 'k', type: 'error', title: 'journal failed', read: false, meta: { notificationKey: 'load:journal', loadingKind: 'journal', state: 'failed' } }, {})
  expect(r).toEqual({ first: 1, again: 0 })
})
test('a WARNING returned with a newer ts does NOT re-toast (only refusals repeat this way)', async () => {
  const r = await repeatOf({ id: 'w', type: 'warning', title: 'slow', read: false }, {})
  expect(r).toEqual({ first: 1, again: 0 })
})
test('a READ error returned with a newer ts does NOT re-toast', async () => {
  const r = await repeatOf({ id: 'r', type: 'error', title: 'old refusal', read: false }, { read: true })
  expect(r).toEqual({ first: 1, again: 0 })
})
