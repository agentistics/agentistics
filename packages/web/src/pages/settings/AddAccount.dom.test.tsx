/** Lifecycle regressions with fake HTTP and the same persistent route frame used by App. */
import React, { act } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Root } from 'react-dom/client'
import { ADD_COPY, addErrorText, type LoginInfoView, type RootRowView } from './addAccountLogic'

let createRoot: typeof import('react-dom/client').createRoot
let AddAccount: typeof import('./AddAccount').default
let PageRouteFrame: typeof import('../../components/PageRouteFrame').PageRouteFrame
const originalFetch = globalThis.fetch
const originalInterval = globalThis.setInterval, originalClear = globalThis.clearInterval
let poll: (() => void) | undefined
const viewportListeners = new Set<(event: MediaQueryListEvent) => void>()
beforeAll(async () => {
  GlobalRegistrator.register({ width: 1440, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: window.innerWidth < 768,
    addEventListener(_name: string, fn: (e: MediaQueryListEvent) => void) { viewportListeners.add(fn) },
    removeEventListener(_name: string, fn: (e: MediaQueryListEvent) => void) { viewportListeners.delete(fn) },
  })) as unknown as typeof window.matchMedia
  createRoot = (await import('react-dom/client')).createRoot
  AddAccount = (await import('./AddAccount')).default
  PageRouteFrame = (await import('../../components/PageRouteFrame')).PageRouteFrame
})
afterAll(async () => { globalThis.fetch = originalFetch; await GlobalRegistrator.unregister() })
let host: HTMLDivElement, root: Root, rows: RootRowView[], deletes: string[], codes: string[]
let finishDelete: () => void
let deleteWait: Promise<void>
const first: LoginInfoView = { kind: 'paste', url: 'https://accounts.google.com/o/oauth2/v2/auth?state=FIRST_FAKE', expiresAt: Date.now() + 300000 }
const json = (body: unknown) => Response.json(body)
beforeEach(() => {
  rows = []; deletes = []; codes = []; poll = undefined
  deleteWait = new Promise<void>(r => { finishDelete = r })
  globalThis.setInterval = ((fn: () => void, ms: number, ...args: unknown[]) => {
    if (ms === 2000) { poll = fn; return -9876 }
    return originalInterval(fn, ms, ...args)
  }) as typeof setInterval
  globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => {
    if (Number(id) === -9876) { poll = undefined; return }
    originalClear(id)
  }) as typeof clearInterval
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/experimental') return json({ features: [{ id: 'multi-account', on: true }] })
    if (init?.method === 'DELETE') {
      deletes.push(url); rows = [] // The next poll sees no row while DELETE is still pending.
      await deleteWait; return json({ ok: true })
    }
    if (url.endsWith('/code')) {
      codes.push(JSON.parse(String(init?.body)).code)
      rows = [{ ...rows[0]!, login: { ...first, url: first.url.replace('FIRST_FAKE', 'SECOND_FAKE'), error: 'invalid_code' } }]
      return json({ ok: true })
    }
    if (init?.method === 'POST') {
      rows = [{ harness: 'gemini', root: '/fake/root', status: 'pending', pendingId: 'r_fake', login: { ...first } }]
      return json({ ok: true, pendingId: 'r_fake', ...first })
    }
    return json({ roots: rows })
  }) as typeof fetch
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(async () => {
  finishDelete()
  await act(async () => { root.unmount(); await Promise.resolve() })
  host.remove(); globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear
})
const resize = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
  for (const fn of viewportListeners) fn({ matches: width < 768 } as MediaQueryListEvent)
}
const render = async (width: number, lang: 'pt' | 'en') => {
  await act(async () => {
    resize(width)
    root.render(<PageRouteFrame compact={width < 768} scrollRef={null} maxWidth={1400}>
      <AddAccount lang={lang} harnesses={['gemini']} onBound={() => {}} />
    </PageRouteFrame>)
  })
}
const button = (text: string, scope: ParentNode = document) => Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === text)!
const open = async (lang: 'pt' | 'en') => {
  const add = host.querySelector<HTMLButtonElement>(`[aria-label="${ADD_COPY(lang === 'pt').addTo('Gemini CLI')}"]`)!
  await act(async () => { add.click() })
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
}
for (const width of [390, 1440]) for (const lang of ['pt', 'en'] as const) {
  const t = ADD_COPY(lang === 'pt')
  describe(`Add account lifecycle ${lang} ${width}`, () => {
    test('active pending card has only status; Cancel closes before slow deletion and never expires', async () => {
      await render(width, lang); await open(lang)
      const card = host.querySelector('[data-add-account]')!
      expect(card.textContent).toContain(t.waiting)
      expect(card.querySelectorAll('[data-login-url]')).toHaveLength(1)
      expect(Array.from(card.querySelectorAll('button')).some(b => b.textContent === t.openLogin)).toBe(false)
      expect(Array.from(card.querySelectorAll('button')).filter(b => b.textContent === t.cancelPending)).toHaveLength(1) // modal only
      await act(async () => { button(t.cancelPending, document.querySelector('[role="dialog"]')!).click() })
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(deletes).toHaveLength(1)
      await act(async () => { poll?.() })
      expect(document.body.textContent).not.toContain(addErrorText({ error: 'login_timeout' }, lang === 'pt'))
      await act(async () => { finishDelete(); await Promise.resolve() })
    })
    test('crossing the breakpoint retains the exact dialog and pending helper', async () => {
      await render(width, lang); await open(lang)
      const dialog = document.querySelector('[role="dialog"]')
      await render(width === 390 ? 1440 : 390, lang)
      expect(document.querySelector('[role="dialog"]')).toBe(dialog)
      expect(deletes).toHaveLength(0)
      expect(document.querySelector('[data-login-url]')!.textContent).toBe(first.url)
    })
    test('invalid code refreshes the link, explains rejection and restores enabled paste input', async () => {
      await render(width, lang); await open(lang)
      const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
        setter.call(input, 'qa-fake-123')
        input.dispatchEvent(new window.Event('input', { bubbles: true }))
        input.dispatchEvent(new window.Event('change', { bubbles: true }))
      })
      await act(async () => { button(t.submit, document.querySelector('[role="dialog"]')!).click() })
      expect(codes).toEqual(['qa-fake-123'])
      expect(document.querySelector('[data-login-url]')!.textContent).toContain('SECOND_FAKE')
      expect(document.querySelector('[role="alert"]')!.textContent).toBe(addErrorText({ error: 'invalid_code' }, lang === 'pt'))
      expect(input.disabled).toBe(false)
      expect(input.value).toBe('')
    })
  })
}

describe('a fresh machine (no preference, no variable) can add an account (CONTAS.MAC.NOVO)', () => {
  test('the server report for a fresh machine turns the button on and drops the "turned off" line', async () => {
    const { resolveExperimental } = await import('@agentistics/core')
    const inner = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === '/api/experimental' ? json({ features: resolveExperimental(undefined, {}) }) : inner(input, init)) as typeof fetch
    await render(1440, 'pt')
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(host.querySelector(`[aria-label="${ADD_COPY(true).addTo('Gemini CLI')}"]`)).not.toBeNull()
    expect(host.textContent).not.toContain(ADD_COPY(true).flagOff)
  })
})
