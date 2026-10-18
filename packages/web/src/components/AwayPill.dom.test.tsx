import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { AWAY_OFF } from '@agentistics/core'
import AwayPill from './AwayPill'
import { HeaderStatusButtons } from './HeaderStatusButtons'
import { MemoryRouter } from 'react-router-dom'
import { MOBILE_PILL_BAR_Z, NAY_FAB_Z } from '../lib/zLayers'
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
    if (url.startsWith('/api/clean/')) return Response.json(null)
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
      const button = Array.from(document.querySelectorAll('button')).find(b => b.textContent === text)
      expect(button).toBeDefined()
      await act(async () => button!.click())
    }
    try {
      await act(async () => root.render(<AwayPill lang={lang} enabled />))
      const moon = () => host.querySelector<HTMLButtonElement>('[data-testid="away-pill"]')!
      expect(moon().classList.contains('ag-tap-icon')).toBe(width < 768)
      await act(async () => moon().click())
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(lang === 'pt' ? 'Até quando' : 'Until when')
      assertViewportDialog(host)
      expect(writes).toHaveLength(0)
      await clickText(lang === 'pt' ? 'Cancelar' : 'Cancel')
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      await act(async () => moon().click())
      await clickText(lang === 'pt' ? 'Ligar' : 'Turn on')
      expect(writes).toHaveLength(1)
      expect(writes[0]).toMatchObject({ on: true, maxWorkers: expect.any(Number) })
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      await act(async () => moon().click())
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(lang === 'pt' ? 'Voltou?' : 'Back?')
      assertViewportDialog(host)
      await clickText(lang === 'pt' ? 'Desligar — voltei' : "Turn off — I'm back")
      expect(writes[1]).toEqual({ on: false })
      expect(moon().getAttribute('aria-label')).toBe(lang === 'pt' ? 'Ligar modo ausente' : 'Turn on away mode')
    } finally {
      await act(async () => root.unmount()); host.remove()
    }
  })
}

function assertViewportDialog(host: HTMLElement) {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
  expect(dialog.classList.contains('ag-dialog-viewport')).toBe(true)
  expect(dialog.style.maxHeight).toContain('100dvh')
  expect(dialog.style.maxHeight).toContain('safe-area-inset-top')
  expect(dialog.style.maxHeight).toContain('safe-area-inset-bottom')
  expect(dialog.style.overflow).toBe('hidden')
  const body = dialog.querySelector<HTMLElement>('.ag-dialog-scroll-body')!
  expect(body.style.overflowY).toBe('auto')
  expect(parseFloat(body.style.minHeight)).toBe(0)
  expect(body.contains(dialog.querySelector('textarea'))).toBe(dialog.querySelector('textarea') !== null)
  expect(dialog.firstElementChild).not.toBe(body)
  expect((dialog.firstElementChild as HTMLElement).style.flexShrink).toBe('0')
  const actions = dialog.lastElementChild as HTMLElement
  expect(actions.style.flexShrink).toBe('0')
  expect(actions.querySelectorAll('button')).toHaveLength(2)
  const backdrop = dialog.parentElement!
  expect(backdrop.parentElement).toBe(document.body)
  expect(host.contains(dialog)).toBe(false)
  expect(Number(backdrop.style.zIndex)).toBeGreaterThan(Math.max(MOBILE_PILL_BAR_Z, NAY_FAB_Z))
}

for (const width of [1280, 390]) for (const on of [false, true]) {
  test(`header order is vault, moon, bell (${width}px, away ${on ? 'on' : 'off'})`, async () => {
    window.innerWidth = width
    window.matchMedia = (() => ({ matches: width < 768, addEventListener() {}, removeEventListener() {} })) as never
    __setAwayForTest({ ...AWAY_OFF, on })
    const host = document.createElement('div'); document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () => root.render(<MemoryRouter><HeaderStatusButtons lang="en" isCentral={false} mobile={width < 768} /></MemoryRouter>))
      const buttons = Array.from(host.querySelectorAll('button'))
      expect(buttons).toHaveLength(3)
      expect(buttons[0]!.hasAttribute('data-vault-header')).toBe(true)
      expect(buttons[1]!.getAttribute('data-testid')).toBe('away-pill')
      expect(buttons[2]!.title).toBe('Notifications')
    } finally {
      await act(async () => root.unmount()); host.remove()
    }
  })
}
