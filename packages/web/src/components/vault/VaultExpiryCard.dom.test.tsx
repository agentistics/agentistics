import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

let createRoot: typeof import('react-dom/client').createRoot
let Card: typeof import('./VaultExpiryCard').VaultExpiryCard
const originalFetch = globalThis.fetch
let originalAnimate: typeof Element.prototype.animate
let host: HTMLDivElement
let root: Root

beforeAll(async () => {
  GlobalRegistrator.register({ width: 390, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  originalAnimate = Element.prototype.animate
  // Animation timing is outside this card's interaction contract.
  Element.prototype.animate = undefined as unknown as typeof Element.prototype.animate
  createRoot = (await import('react-dom/client')).createRoot
  Card = (await import('./VaultExpiryCard')).VaultExpiryCard
})
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  globalThis.fetch = originalFetch
})
afterAll(async () => { Element.prototype.animate = originalAnimate; await GlobalRegistrator.unregister() })

for (const width of [390, 1440]) for (const lang of ['en', 'pt'] as const) {
  test(`cancelled Hello keeps the card actionable with the server sentence: ${lang}, ${width}px`, async () => {
    window.innerWidth = width
    const sentence = lang === 'pt'
      ? 'O Windows Hello foi cancelado. O cofre continua aberto até o tempo acabar; pressione Manter aberto para tentar de novo.'
      : 'Windows Hello was cancelled. The vault stays open until the timer ends; press Keep open to try again.'
    const requests: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = String(input)
      requests.push(path)
      if (path === '/api/vault') return Response.json({ state: 'open', autoLockInMs: 4 * 60_000 })
      if (path === '/api/vault/extend') return Response.json({ ok: false, code: 'stepup-required' }, { status: 401 })
      if (path === '/api/vault/stepup/gesture') return Response.json({ ok: false, code: 'presence-cancelled', sentence }, { status: 401 })
      throw new Error(`Unexpected request: ${path}`)
    }) as typeof fetch
    await act(async () => { root.render(createElement(Card, { lang, isMobile: width === 390, zIndex: 1100 })) })
    const button = host.querySelector<HTMLButtonElement>('[data-vault-extend]')!
    expect(button).not.toBeNull()
    await act(async () => { button.click() })
    expect(host.querySelector('[role="status"]')?.textContent).toBe(sentence)
    expect(button.disabled).toBe(false)
    expect(host.querySelector('[data-vault-lock-now]')).not.toBeNull()
    expect(host.querySelector('input')).toBeNull()
    expect(requests.filter(path => path === '/api/vault/stepup/gesture')).toHaveLength(1)
  })
}
