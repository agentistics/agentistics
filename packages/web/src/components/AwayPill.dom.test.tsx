import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { AWAY_OFF } from '@agentistics/core'
import AwayPill from './AwayPill'
import { __setAwayForTest } from '../lib/awayMode'

let createRoot: typeof import('react-dom/client').createRoot
const originalFetch = globalThis.fetch
const originalEventSource = globalThis.EventSource
const originalAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
let on = false
const writes: unknown[] = []
beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.EventSource = class { close() {} addEventListener() {} removeEventListener() {} } as never
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url === '/api/away') {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)); writes.push(body); on = body.on
      }
      return Response.json({ ok: true, state: { ...AWAY_OFF, on }, activeSessions: 2 })
    }
    return Response.json({ limits: [], registered: [] })
  }) as typeof fetch
  createRoot = (await import('react-dom/client')).createRoot
})
afterAll(async () => {
  __setAwayForTest(null)
  globalThis.fetch = originalFetch
  globalThis.EventSource = originalEventSource
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalAct
  await GlobalRegistrator.unregister()
})
for (const width of [1280, 390]) for (const lang of ['pt', 'en'] as const) {
  test(`moon opens existing activation and return dialogs (${width}px, ${lang})`, async () => {
    window.innerWidth = width
    window.matchMedia = (() => ({ matches: width < 768, addEventListener() {}, removeEventListener() {} })) as never
    on = false; writes.length = 0; __setAwayForTest(AWAY_OFF)
    const host = document.createElement('div'); document.body.appendChild(host)
    const root = createRoot(host)
    const clickText = async (text: string) => {
      const button = Array.from(host.querySelectorAll('button')).find(b => b.textContent === text)
      expect(button).toBeDefined()
      await act(async () => button!.click())
    }
    try {
      await act(async () => root.render(<AwayPill lang={lang} enabled />))
      const moon = () => host.querySelector<HTMLButtonElement>('[data-testid="away-pill"]')!
      expect(moon().classList.contains('ag-tap-icon')).toBe(width < 768)
      await act(async () => moon().click())
      expect(host.querySelector('[role="dialog"]')?.textContent).toContain(lang === 'pt' ? 'Até quando' : 'Until when')
      expect(writes).toHaveLength(0)
      await clickText(lang === 'pt' ? 'Cancelar' : 'Cancel')
      expect(host.querySelector('[role="dialog"]')).toBeNull()
      await act(async () => moon().click())
      await clickText(lang === 'pt' ? 'Ligar' : 'Turn on')
      expect(writes).toHaveLength(1)
      expect(writes[0]).toMatchObject({ on: true, maxWorkers: expect.any(Number) })
      expect(host.querySelector('[role="dialog"]')).toBeNull()
      await act(async () => moon().click())
      expect(host.querySelector('[role="dialog"]')?.textContent).toContain(lang === 'pt' ? 'Voltou?' : 'Back?')
      await clickText(lang === 'pt' ? 'Desligar — voltei' : "Turn off — I'm back")
      expect(writes[1]).toEqual({ on: false })
      expect(moon().getAttribute('aria-label')).toBe(lang === 'pt' ? 'Ligar modo ausente' : 'Turn on away mode')
    } finally {
      await act(async () => root.unmount()); host.remove()
    }
  })
}
