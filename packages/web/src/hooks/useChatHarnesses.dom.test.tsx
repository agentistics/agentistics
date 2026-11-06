import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'

let createRoot: typeof import('react-dom/client').createRoot
let Settings: typeof import('../pages/settings/HarnessesSettings').default
let router: typeof import('react-router-dom')
const originalFetch = globalThis.fetch
const requests: string[] = []
const drivers = ['claude', 'codex', 'gemini', 'copilot']

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.fetch = (async (url: string) => {
    requests.push(String(url))
    const ids = String(url).includes('all=1') ? [...drivers, 'antigravity', 'kimi', 'opencode', 'hermes'] : drivers
    return Response.json(ids.map(id => ({ id, label: id, installed: true, authReady: true, ready: true, models: [], defaultModel: '', setup: {} })))
  }) as typeof fetch
  ;(Element.prototype as unknown as { animate: unknown }).animate = undefined
  createRoot = (await import('react-dom/client')).createRoot
  Settings = (await import('../pages/settings/HarnessesSettings')).default
  router = await import('react-router-dom')
})
afterAll(async () => { globalThis.fetch = originalFetch; await GlobalRegistrator.unregister() })

test('Nay settings request only chat backends and exclude session-only harnesses from the ready count', async () => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(router.MemoryRouter, null,
      createElement(router.Routes, null,
        createElement(router.Route, { element: createElement(router.Outlet, { context: { lang: 'en' } }) },
          createElement(router.Route, { index: true, element: createElement(Settings) }))))))
    expect(requests).toContain('/api/chat-harnesses')
    expect(requests.some(r => r.includes('all=1'))).toBe(false)
    expect(host.textContent).toContain('4 of 4 backends ready')
    for (const id of ['antigravity', 'kimi', 'opencode', 'hermes']) expect(host.textContent).not.toContain(id)
  } finally { await act(async () => root.unmount()); host.remove() }
})
