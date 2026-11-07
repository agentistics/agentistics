import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement as h } from 'react'

let createRoot: typeof import('react-dom/client').createRoot
let router: typeof import('react-router-dom')
let Group: typeof import('./TopBarGroup').TopBarGroup
let originalFetch: typeof globalThis.fetch

beforeAll(async () => {
  originalFetch = globalThis.fetch
  GlobalRegistrator.register({ width: 1200, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  ;(globalThis as { EventSource?: unknown }).EventSource = class { addEventListener() {} removeEventListener() {} close() {} }
  ;(globalThis as { fetch?: unknown }).fetch = async (input: unknown) => {
    const url = String(typeof input === 'string' ? input : (input as { url?: string })?.url ?? '')
    const body = url.includes('/api/tasks/live') ? { generatedAt: new Date().toISOString(), deliveries: [], leaders: [], history: [], samples: 0 } : { present: false }
    return new Response(JSON.stringify(body), { status: 200 })
  }
  // happy-dom cannot cancel the loader's Web Animations while the preview's board is still loading.
  ;(window.SVGElement.prototype as { animate?: unknown }).animate = undefined
  createRoot = (await import('react-dom/client')).createRoot
  router = await import('react-router-dom')
  Group = (await import('./TopBarGroup')).TopBarGroup
})
afterAll(async () => { (await import('../tasks/useLiveDeliveries')).resetLiveCache(); globalThis.fetch = originalFetch; await GlobalRegistrator.unregister() })

async function mount(props: { enabled?: boolean; onOpenHardware?: () => void }, entry = '/x') {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  let path = ''
  function Here() { path = router.useLocation().pathname; return null }
  await act(async () => { root.render(h(router.MemoryRouter, { initialEntries: [entry] }, h(Group, { lang: 'en', ...props }), h(Here))) })
  await act(async () => { await new Promise(r => setTimeout(r, 10)) })
  return { host, root, path: () => path }
}
const button = (host: HTMLElement) => host.querySelector('[data-topbar-group]') as HTMLButtonElement | null

describe('TopBarGroup', () => {
  test('one neutral grid button, no coloured dots, rows open on click and Esc closes', async () => {
    const v = await mount({ enabled: true, onOpenHardware: () => {} })
    const b = button(v.host)!
    expect(b).toBeTruthy()
    expect(b.dataset.accent).toBeUndefined()
    expect(v.host.querySelectorAll('[data-live-pulse], [data-live-badge], [data-vault-badge]')).toHaveLength(0)
    await act(async () => b.click())
    const pop = v.host.querySelector('[data-topbar-group-popover]')!
    expect(pop.getAttribute('role')).toBe('menu')
    expect(Array.from(pop.querySelectorAll('[data-group-row]')).map(e => e.getAttribute('data-group-row'))).toEqual(['hardware', 'autonomous', 'vault', 'live'])
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(v.host.querySelector('[data-topbar-group-popover]')).toBeNull()
    await act(async () => v.root.unmount()); v.host.remove()
  })
  test('rows go to their pages; Hardware calls the overlay; the popover closes', async () => {
    let hw = 0
    const v = await mount({ enabled: true, onOpenHardware: () => { hw++ } })
    await act(async () => button(v.host)!.click())
    await act(async () => (v.host.querySelector('[data-group-row="vault"]') as HTMLElement).click())
    expect(v.path()).toBe('/vault')
    expect(v.host.querySelector('[data-topbar-group-popover]')).toBeNull()
    await act(async () => button(v.host)!.click())
    await act(async () => (v.host.querySelector('[data-group-row="hardware"]') as HTMLElement).click())
    expect(hw).toBe(1)
    await act(async () => button(v.host)!.click())
    await act(async () => (v.host.querySelector('[data-group-row="autonomous"]') as HTMLElement).click())
    expect(v.path()).toBe('/leadership/away')
    await act(async () => v.root.unmount()); v.host.remove()
  })
  test('inside a session the Live row opens the preview over it — the session is not left (LIVE.ATALHO)', async () => {
    const v = await mount({ enabled: true, onOpenHardware: () => {} }, '/sessions/abc')
    await act(async () => button(v.host)!.click())
    const row = v.host.querySelector('[data-group-row="live"]') as HTMLElement
    expect(row.tagName).toBe('BUTTON')
    await act(async () => row.click())
    expect(v.path()).toBe('/sessions/abc')
    expect(v.host.querySelector('[data-topbar-group-popover]')).toBeNull()
    expect(v.host.querySelector('[data-live-popover]')).toBeTruthy()
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(v.host.querySelector('[data-live-popover]')).toBeNull()
    expect(v.path()).toBe('/sessions/abc')
    await act(async () => v.root.unmount()); v.host.remove()
  })
  test('outside a session the Live row still goes to the Live page', async () => {
    const v = await mount({ enabled: true, onOpenHardware: () => {} }, '/sessions')
    await act(async () => button(v.host)!.click())
    await act(async () => (v.host.querySelector('[data-group-row="live"]') as HTMLElement).click())
    expect(v.path()).toBe('/tasks/live')
    expect(v.host.querySelector('[data-live-popover]')).toBeNull()
    await act(async () => v.root.unmount()); v.host.remove()
  })
  test('on a central with no voice nothing is drawn at all', async () => {
    const v = await mount({ enabled: false })
    expect(button(v.host)).toBeNull()
    await act(async () => v.root.unmount()); v.host.remove()
  })
})
