/** Settings → Browser (S12): the switch, the numbers, the executable, and Delete profiles with its confirm and its refusal. */
import React, { act } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Root } from 'react-dom/client'

let createRoot: typeof import('react-dom/client').createRoot
let BrowserSettings: typeof import('./BrowserSettings').default
let RR: typeof import('react-router-dom')
const originalFetch = globalThis.fetch
beforeAll(async () => {
  GlobalRegistrator.register({ width: 1440, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  createRoot = (await import('react-dom/client')).createRoot
  RR = await import('react-router-dom')
  BrowserSettings = (await import('./BrowserSettings')).default
})
afterAll(async () => { globalThis.fetch = originalFetch; await GlobalRegistrator.unregister() })

const MB = 1024 ** 2
const baseStatus = {
  executable: { found: true, path: '/x/chrome-headless-shell', kind: 'headless-shell', source: 'playwright', sentence: 's' },
  live: [] as unknown[],
  ceilings: { live: 3 },
  memory: { available: 4 * 1024 ** 3, minAvailable: 1.5 * 1024 ** 3, trimBytes: 900 * MB, killBytes: 1200 * MB, rssFallbackFactor: 1.6 },
  profiles: { count: 2 },
}

let host: HTMLDivElement, root: Root
let prefs: { browserEnabled?: boolean }, status: typeof baseStatus, puts: unknown[], deletes: number, deleteAnswer: { status: number; body: unknown }, statusCode: number

beforeEach(() => {
  prefs = {}; status = structuredClone(baseStatus); puts = []; deletes = 0; statusCode = 200
  deleteAnswer = { status: 200, body: { ok: true, removed: 2 } }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/preferences' && init?.method === 'PUT') { puts.push(JSON.parse(String(init.body))); return Response.json({}) }
    if (url === '/api/preferences') return Response.json(prefs)
    if (url === '/api/session') return Response.json({ capabilities: { localShell: true } })
    if (url === '/api/browser/status') return statusCode === 200 ? Response.json(status) : Response.json({ error: 'browser_disabled' }, { status: statusCode })
    if (url === '/api/browser/profiles/delete') { deletes++; return Response.json(deleteAnswer.body, { status: deleteAnswer.status }) }
    return Response.json({})
  }) as typeof fetch
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

async function mount(lang: 'en' | 'pt' = 'en') {
  const { MemoryRouter, Routes, Route, Outlet } = RR
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/s']}>
        <Routes><Route element={<Outlet context={{ lang }} />}><Route path="/s" element={<BrowserSettings />} /></Route></Routes>
      </MemoryRouter>,
    )
  })
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
}
const text = () => host.textContent ?? ''
const btn = (label: string) => Array.from(host.ownerDocument.querySelectorAll('button')).find(b => b.textContent === label) as HTMLButtonElement | undefined
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); await new Promise(r => setTimeout(r, 20)) }) }

describe('the switch', () => {
  test('absent preference reads as ON; the toggle writes browserEnabled:false', async () => {
    await mount()
    const sw = host.querySelector('[role="switch"]') as HTMLElement
    expect(sw.getAttribute('aria-checked')).toBe('true')
    await click(sw)
    expect(puts).toEqual([{ browserEnabled: false }])
    expect(host.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false')
  })
  test('explicit off: no numbers are fetched or drawn (the server answers 403 anyway)', async () => {
    prefs = { browserEnabled: false }; statusCode = 403
    await mount()
    expect(host.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false')
    expect(text()).not.toContain('Memory use')
    expect(text()).not.toContain('Delete profiles')
  })
})

describe('the numbers', () => {
  test('per-browser PSS, the total, the server\'s thresholds and the executable with how it was found', async () => {
    status.live = [
      { key: 'a', owner: { kind: 'session', managedId: 'abcdef123456' }, memory: { basis: 'pss', bytes: 400 * MB, action: 'ok' } },
      { key: 'personal', owner: { kind: 'personal' }, memory: { basis: 'pss', bytes: 950 * MB, action: 'trim' } },
    ]
    await mount()
    const nums = Array.from(host.querySelectorAll('[data-browser-memory]')).map(e => e.textContent)
    expect(nums).toEqual(['400 MB PSS', '950 MB PSS'])
    expect(host.querySelector('[data-browser-total]')!.textContent).toBe('1.3 GB')
    expect(text()).toContain('above 900 MB')
    expect(text()).toContain('above 1.2 GB')
    expect(text()).toContain('/x/chrome-headless-shell')
    expect(text()).toContain('found in the Playwright cache')
  })
  test('not measured yet is said in words, never as 0', async () => {
    status.live = [{ key: 'a', owner: { kind: 'session', managedId: 'abcdef123456' }, memory: null }]
    await mount()
    expect(text()).toContain('not measured yet')
    expect(host.querySelector('[data-browser-memory]')!.textContent).toBe('not measured yet')
  })
  test('no executable: the server\'s sentence, not a path', async () => {
    status.executable = { found: false, sentence: 'This computer has no browser agentistics can use.' } as typeof status.executable
    await mount()
    expect(text()).toContain('This computer has no browser agentistics can use.')
  })
})

describe('Delete profiles', () => {
  test('asks first; cancelling deletes nothing; confirming calls the route once and says how many', async () => {
    await mount()
    await click(btn('Delete profiles')!)
    expect(text()).toContain('Delete profiles?')
    await click(btn('Cancel')!)
    expect(deletes).toBe(0)
    await click(btn('Delete profiles')!)
    await click(btn('Delete')!)
    expect(deletes).toBe(1)
    expect(host.querySelector('[data-browser-notice]')!.textContent).toBe('2 profile(s) deleted.')
  })
  test('refused while a browser is live: the button is disabled and the sentence says why', async () => {
    status.live = [{ key: 'a', owner: { kind: 'session', managedId: 'abcdef123456' }, memory: { basis: 'pss', bytes: 100 * MB, action: 'ok' } }]
    await mount()
    expect(btn('Delete profiles')!.disabled).toBe(true)
    expect(text()).toContain('A browser is open right now')
    await click(btn('Delete profiles')!)
    expect(deletes).toBe(0)
  })
  test('a 409 from the server (it became live meanwhile) shows the server\'s sentence', async () => {
    deleteAnswer = { status: 409, body: { ok: false, error: 'browser_live', sentence: 'A browser is open right now. Close it first.' } }
    await mount()
    await click(btn('Delete profiles')!)
    await click(btn('Delete')!)
    expect(host.querySelector('[data-browser-notice]')!.textContent).toBe('A browser is open right now. Close it first.')
  })
  test('no stored profiles: nothing to delete', async () => {
    status.profiles.count = 0
    await mount()
    expect(btn('Delete profiles')!.disabled).toBe(true)
  })
})

describe('the harness lines', () => {
  test('Hermes and Antigravity are named, in both languages', async () => {
    await mount('pt')
    expect(host.querySelector('[data-browser-harness="hermes"]')!.textContent).toContain('Hermes ainda não recebe as ferramentas de navegador do agentistics')
    expect(host.querySelector('[data-browser-harness="antigravity"]')!.textContent).toContain('navegador próprio')
  })
})
