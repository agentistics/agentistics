import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement as h } from 'react'
import type { Root } from 'react-dom/client'
import type { PlanLimits } from '@agentistics/core'

let createRoot: typeof import('react-dom/client').createRoot
let Summary: typeof import('./PlanLimitMeter').PlanUsageSummary
let Section: typeof import('./ApiUsageSection').ApiUsageSection
let Lib: typeof import('../lib/apiUsage')
let Planlib: typeof import('../lib/planLimits')
let root: Root | undefined
const originalFetch = globalThis.fetch
const NOW = Date.parse('2026-11-06T12:00:00Z')

const claude: PlanLimits = {
  harness: 'claude', account: 'acc_1', plan: 'Claude Max 5x', label: 'Vini', updatedAt: NOW, source: 'statusline' as never,
  windows: [{ kind: '5h', usedPct: 38, resetsAt: NOW + 3_600_000 } as never],
}

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1200, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  ;(globalThis as { EventSource?: unknown }).EventSource = class { addEventListener() {} removeEventListener() {} close() {} }
  createRoot = (await import('react-dom/client')).createRoot
  Summary = (await import('./PlanLimitMeter')).PlanUsageSummary
  Section = (await import('./ApiUsageSection')).ApiUsageSection
  Lib = await import('../lib/apiUsage')
  Planlib = await import('../lib/planLimits')
})
afterEach(async () => { await act(async () => { root?.unmount() }); root = undefined; document.body.innerHTML = ''; globalThis.fetch = originalFetch })
afterAll(async () => { await GlobalRegistrator.unregister() })

function render(node: ReturnType<typeof h>) {
  const el = document.createElement('div'); document.body.appendChild(el)
  root = createRoot(el); act(() => { root!.render(node) })
  return el
}

describe('parseApiUsage', () => {
  test('reads the fixture and drops malformed items', () => {
    const items = Lib.parseApiUsage({ items: [...Lib.API_USAGE_FIXTURE.items, { id: 'x' }, null, { id: 'y', label: 'Y', status: 'weird' }] })
    expect(items.map(i => i.id)).toEqual(['provider-a', 'provider-b'])
    expect(items[0]!.resetsAt).toBe(Date.parse('2026-12-01T00:00:00Z'))
  })
  test('anything that is not a list yields none', () => {
    expect(Lib.parseApiUsage(null)).toEqual([])
    expect(Lib.parseApiUsage({ items: 'no' })).toEqual([])
    expect(Lib.parseApiUsage({})).toEqual([])
  })
  test('used share is null unless the item is ok with both figures', () => {
    const [ok, denied] = Lib.parseApiUsage(Lib.API_USAGE_FIXTURE)
    expect(Lib.apiUsedPct(ok!)).toBe(64)
    expect(Lib.apiUsedPct(denied!)).toBeNull()
  })
  test('keeps only same-origin engine endpoints and https links in key config', () => {
    const [valid, invalid] = Lib.parseApiUsage({ items: [
      { id: 'valid', label: 'Valid', status: 'no-key', unit: 'credits', config: { kind: 'api-key', status: 'missing', endpoint: '/api/engine/x/key', createUrl: 'https://example.test/key', pricingUrl: 'http://example.test/pricing' } },
      { id: 'invalid', label: 'Invalid', status: 'no-key', unit: 'credits', config: { kind: 'api-key', status: 'missing', endpoint: 'https://example.test/key', createUrl: 'http://example.test/key' } },
    ] })
    expect(valid!.config).toMatchObject({ endpoint: '/api/engine/x/key', createUrl: 'https://example.test/key' })
    expect(valid!.config?.pricingUrl).toBeUndefined()
    expect(invalid!.config).toBeUndefined()
    expect(Lib.apiRowLine(valid!, NOW, 'pt')).toBe('Sem chave · Adicionar')
  })
})

describe('popover summary', () => {
  const summary = () => h(Summary, { limits: [claude], registered: [], now: NOW, lang: 'pt' })

  test('both titled sections render, with the API row words', () => {
    Planlib.__setPlanLimitsForTest([claude], NOW)
    Lib.__setApiUsageForTest(Lib.parseApiUsage(Lib.API_USAGE_FIXTURE))
    const el = render(summary())
    const titles = Array.from(el.querySelectorAll('[data-usage-section-title]')).map(t => t.textContent)
    expect(titles).toEqual(['Contas', 'APIs'])
    const ok = el.querySelector('[data-api-row="provider-a"]')!
    expect(ok.textContent).toContain('Provider A')
    expect(ok.textContent).toContain('Pay as you go')
    expect(ok.textContent).toContain('restam 360 créditos')
    expect(ok.textContent).toContain('renova')
    expect(el.querySelector('[data-api-row="provider-b"]')!.textContent).toContain('não tem permissão')
    expect(el.querySelector('[data-plan-row="claude"]')).not.toBeNull()
    expect(el.querySelector('[data-plan-usage-open]')).not.toBeNull()
  })

  test('no APIs: the section and the titles are hidden, accounts unchanged', () => {
    Planlib.__setPlanLimitsForTest([claude], NOW)
    Lib.__setApiUsageForTest([])
    const el = render(summary())
    expect(el.querySelector('[data-usage-section-title]')).toBeNull()
    expect(el.querySelector('[data-api-usage]')).toBeNull()
    expect(el.querySelector('[data-plan-row="claude"]')).not.toBeNull()
    expect(el.textContent).toContain('Claude Code')
  })

  test('states no-key and error are said in words (en)', () => {
    const items = Lib.parseApiUsage({ items: [{ id: 'k', label: 'K', status: 'no-key', unit: 'credits' }, { id: 'e', label: 'E', status: 'error', unit: 'credits' }] })
    expect(Lib.apiRowLine(items[0]!, NOW, 'en')).toBe('no key configured')
    expect(Lib.apiRowLine(items[1]!, NOW, 'en')).toBe('could not read the balance')
  })
  test('permission and missing-key details are tooltip-only; errors keep visible detail', () => {
    const items = Lib.parseApiUsage({ items: [
      { id: 'k', label: 'K', status: 'no-key', unit: 'credits', detail: 'setup required' },
      { id: 'p', label: 'P', status: 'no-permission', unit: 'credits', detail: 'permission denied' },
      { id: 'e', label: 'E', status: 'error', unit: 'credits', detail: 'upstream unavailable' },
    ] })
    const el = render(h(Section, { items, now: NOW, lang: 'en' }))
    expect(el.querySelector('[data-api-row="k"]')!.textContent).not.toContain('setup required')
    expect(el.querySelector('[data-api-row="k"]')!.getAttribute('title')).toBe('setup required')
    expect(el.querySelector('[data-api-row="p"]')!.textContent).not.toContain('permission denied')
    expect(el.querySelector('[data-api-row="p"]')!.getAttribute('title')).toBe('permission denied')
    expect(el.querySelector('[data-api-row="e"]')!.textContent).toContain('upstream unavailable')
  })
  test('configured rows expose the pencil and save clears the password field', async () => {
    const item = Lib.parseApiUsage({
      items: [{
        id: 'k', label: 'K', status: 'no-key', unit: 'credits',
        config: {
          kind: 'api-key', status: 'missing', endpoint: '/api/engine/x/key', createUrl: 'https://example.test/key',
          requirements: [{ label: { pt: 'Leitura', en: 'Read' }, level: { pt: 'Ler', en: 'Read' }, required: true }],
        },
      }],
    })[0]!
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      expect(init?.body).toBe(JSON.stringify({ key: 'secret-value' }))
      return Response.json({ missing: [{ pt: 'Falta leitura', en: 'Read is missing' }] })
    }) as unknown as typeof fetch
    const el = render(h(Section, { items: [item], now: NOW, lang: 'pt' }))
    await act(async () => { (el.querySelector('[data-api-config-open]') as HTMLButtonElement).click() })
    const input = document.querySelector('[data-api-key-input]') as HTMLInputElement
    await act(async () => {
      input.value = 'secret-value'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(input.value).toBe('secret-value')
    await act(async () => { (document.querySelector('[role=dialog] button:last-of-type') as HTMLButtonElement).click() })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect((document.querySelector('[data-api-key-input]') as HTMLInputElement | null)?.value ?? '').toBe('')
  })
  test('key feedback stays in the dialog: plan notes, unverified checks and save errors', async () => {
    const item = Lib.parseApiUsage({ items: [{ id: 'k', label: 'K', status: 'no-key', unit: 'credits', config: {
      kind: 'api-key', status: 'missing', endpoint: '/api/engine/x/key', notes: [{ pt: 'Plano grátis', en: 'Free plan' }],
    } }] })[0]!
    let fail = false
    globalThis.fetch = (async () => fail ? Response.json({ error: 'bad key' }, { status: 400 }) : Response.json({ unverified: [{ pt: 'TTS', en: 'TTS' }] })) as unknown as typeof fetch
    const el = render(h(Section, { items: [item], now: NOW, lang: 'pt' }))
    await act(async () => { (el.querySelector('[data-api-config-open]') as HTMLButtonElement).click() })
    expect(document.querySelector('[data-api-plan-notes]')?.textContent).toContain('Plano grátis')
    const input = document.querySelector('[data-api-key-input]') as HTMLInputElement
    await act(async () => { input.value = 'secret'; input.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 0)) })
    await act(async () => { (document.querySelector('[role=dialog] button:last-of-type') as HTMLButtonElement).click(); await new Promise(r => setTimeout(r, 0)) })
    expect(document.querySelector('[data-api-unverified]')?.textContent).toContain('TTS')
    expect(document.querySelector('[data-api-key-dialog]')).not.toBeNull()
    fail = true
    await act(async () => { input.value = 'secret2'; input.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 0)) })
    await act(async () => { (document.querySelector('[role=dialog] button:last-of-type') as HTMLButtonElement).click(); await new Promise(r => setTimeout(r, 0)) })
    expect(document.querySelector('[data-api-key-error]')?.textContent).toContain('bad key')
    expect((document.querySelector('[data-api-key-input]') as HTMLInputElement).value).toBe('secret2')
  })
})

describe('usage page section', () => {
  test('an empty list says "no API connected"; unanswered shows nothing', () => {
    let el = render(h(Section, { items: [], now: NOW, lang: 'en', emptyNotice: true }))
    expect(el.querySelector('[data-api-empty]')!.textContent).toBe('No API connected.')
    act(() => root!.unmount())
    el = render(h(Section, { items: null, now: NOW, lang: 'en', emptyNotice: true }))
    expect(el.textContent).toBe('')
  })
  test('the popover-style hide: empty without emptyNotice renders nothing', () => {
    const el = render(h(Section, { items: [], now: NOW, lang: 'pt' }))
    expect(el.textContent).toBe('')
  })
})

describe('store', () => {
  test('a 404 (community build) resolves to an empty list', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    let seen: unknown = 'unset'
    function Probe() { seen = Lib.useApiUsage().items; return null }
    render(h(Probe))
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
    expect(seen).toEqual([])
  })
  test('a later server failure preserves the last good list', async () => {
    let calls = 0
    globalThis.fetch = (async () => calls++ === 0
      ? Response.json({ items: [{ id: 'a', label: 'A', status: 'ok', unit: 'credits', used: 1, limit: 2 }] })
      : new Response('down', { status: 503 })) as unknown as typeof fetch
    Lib.__setApiUsageForTest(null)
    let seen: unknown = 'unset'
    function Probe() { seen = Lib.useApiUsage().items; return null }
    render(h(Probe))
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
    expect(seen).toEqual([{ id: 'a', label: 'A', status: 'ok', unit: 'credits', used: 1, limit: 2 }])
    await act(async () => { await Lib.__refreshApiUsageForTest() })
    expect(seen).toEqual([{ id: 'a', label: 'A', status: 'ok', unit: 'credits', used: 1, limit: 2 }])
  })
})
