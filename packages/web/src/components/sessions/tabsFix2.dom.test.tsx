/** UI.TABS-LIST fix2: the end confirmation leaves on confirm, "closing" in the header, ring contrast, row width. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import type { FleetRow } from '../../lib/fleet'

let createRoot: typeof import('react-dom/client').createRoot
let SessionActions: typeof import('./SessionActions').SessionActions
let SessionStateText: typeof import('./SessionStateText').SessionStateText
let closing: typeof import('../../lib/closingSessions')
let notifications: typeof import('../../lib/notifications')

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(globalThis as { EventSource?: unknown }).EventSource ??= class { close() {} addEventListener() {} removeEventListener() {} onerror = null; onmessage = null }
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never
  globalThis.fetch = (async () => new Response('{}', { status: 404 })) as never
  createRoot = (await import('react-dom/client')).createRoot
  SessionActions = (await import('./SessionActions')).SessionActions
  SessionStateText = (await import('./SessionStateText')).SessionStateText
  closing = await import('../../lib/closingSessions')
  notifications = await import('../../lib/notifications')
})
afterAll(async () => {
  await new Promise(r => setTimeout(r, 50))
  await GlobalRegistrator.unregister()
})

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); closing.resetClosing() })
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

const row = {
  id: 'agentop-abc', title: 'a session', harness: 'claude', cwd: '/x', project: 'x', state: 'waiting', stateLabel: 'precisa de você',
  actionable: true, attachCommand: '', verbs: [{ action: 'kill', label: 'End', enabled: true }],
} as unknown as FleetRow

const click = async (el: Element | undefined) => { await act(async () => { (el as HTMLElement).click() }) }
const byText = (t: string) => Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === t)

describe('end confirmation', () => {
  test('closes the moment it is confirmed, while the close is still pending', async () => {
    let release!: (v: { ok: boolean; message: string }) => void
    const pending = new Promise<{ ok: boolean; message: string }>(r => { release = r })
    await act(async () => root.render(createElement(SessionActions, { row, lang: 'en', act: () => pending, inline: true } as never)))
    await click(byText('End'))
    expect(host.querySelector('[role="alertdialog"], button')?.textContent).toBeTruthy()
    expect(byText('Cancel')).toBeTruthy()
    await click(Array.from(host.querySelectorAll('button')).filter(b => b.textContent?.trim() === 'End').pop())
    expect(byText('Cancel')).toBeUndefined()
    expect(host.textContent).not.toContain('End this session')
    await act(async () => release({ ok: false, message: 'refused by test' }))
    // A refusal is the toast, and the confirmation stays closed.
    expect(byText('Cancel')).toBeUndefined()
    expect(host.textContent).not.toContain('refused by test')
    void notifications
  })
})

describe('header state while closing', () => {
  test('says closing instead of the last polled state', async () => {
    await act(async () => root.render(createElement(SessionStateText, { id: 'x1', label: 'needs you', pt: false })))
    expect(host.textContent).toBe('needs you')
    await act(async () => { closing.beginClosing('x1') })
    expect(host.textContent).toBe('closing')
    await act(async () => root.render(createElement(SessionStateText, { id: 'x1', label: 'precisa de você', pt: true })))
    expect(host.textContent).toBe('encerrando')
  })
  test('every header that prints the state goes through it', () => {
    for (const f of ['./SessionPanel.tsx', '../../pages/SessionsPage.tsx', './SessionFacts.tsx', '../../App.tsx']) {
      expect(readFileSync(new URL(f, import.meta.url), 'utf8')).toContain('<SessionStateText')
    }
  })
})

describe('closing ring', () => {
  test('is 12px with a 2px stroke and a visible track', () => {
    const src = readFileSync(new URL('./ClosingRing.tsx', import.meta.url), 'utf8')
    expect(src).toContain('size = 12')
    expect(src).toContain("'2px solid color-mix(in srgb, var(--text-secondary) 45%")
  })
})

describe('sidebar row width', () => {
  test('an unpinned pin floats instead of reserving width, and the state word yields to it on hover', () => {
    const aside = readFileSync(new URL('../nav/SessionsAside.tsx', import.meta.url), 'utf8')
    expect(aside).toContain('ag-row-pin ag-row-pin-float')
    const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8')
    expect(css).toContain('.ag-row-pin-float { position: absolute !important;')
    expect(css).toContain('[data-row-tail] { visibility: hidden; }')
  })
})
