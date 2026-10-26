/**
 * Ending a session in a real DOM (happy-dom): Ending… from the kill until it settles, the
 * conversation kept mounted underneath (so a refused kill restores it, draft included).
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import { fileURLToPath } from 'node:url'
import type { Root } from 'react-dom/client'

let createRoot: typeof import('react-dom/client').createRoot
let SessionEndingGate: typeof import('./SessionEnding').SessionEndingGate
let ending: typeof import('../../lib/endingSessions')
let originalActEnvironment: boolean | undefined

beforeAll(async () => {
  originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  GlobalRegistrator.register({ width: 1200, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // The loader animates through the Web Animations API; happy-dom rejects a cancelled animation. It skips itself when absent.
  Object.defineProperty(Element.prototype, 'animate', { value: undefined, configurable: true })
  createRoot = (await import('react-dom/client')).createRoot
  SessionEndingGate = (await import('./SessionEnding')).SessionEndingGate
  ending = await import('../../lib/endingSessions')
})
afterAll(async () => {
  await new Promise(resolve => setTimeout(resolve, 50))
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
  await GlobalRegistrator.unregister()
})

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); ending.resetEnding() })

const show = (id: string, lang: 'pt' | 'en') => act(() => {
  root.render(createElement(SessionEndingGate, { id, lang, children: createElement('textarea', { 'data-composer': '', defaultValue: 'draft' }) }))
})
const overlay = () => host.querySelector('[data-session-ending]')
const composer = () => host.querySelector('[data-composer]') as HTMLTextAreaElement

test('Ending… shows from the kill until it settles; the composer stays mounted, hidden, then returns', () => {
  show('s1', 'en')
  expect(overlay()).toBeNull()
  act(() => ending.markEnding('s1'))
  expect(overlay()).not.toBeNull()
  expect(overlay()!.textContent).toContain('Ending…')
  expect(composer().value).toBe('draft')
  expect((composer().parentElement as HTMLElement).style.display).toBe('none')
  act(() => ending.unmarkEnding('s1'))
  expect(overlay()).toBeNull()
  expect(composer().value).toBe('draft')
  expect((composer().parentElement as HTMLElement).style.display).toBe('contents')
})

test('another session ending does not touch this one; Portuguese copy', () => {
  show('s1', 'pt')
  act(() => ending.markEnding('s2'))
  expect(overlay()).toBeNull()
  act(() => ending.markEnding('s1'))
  expect(overlay()!.textContent).toContain('Encerrando…')
})


test("the aside row says 'Ending…' beside the title while its session is being ended, like the reopening status", async () => {
  const { SessionLine } = await import('../nav/SessionLine')
  const session = { id: 'row1', title: 'T', harness: 'claude', cwd: '/x', project: 'x', state: 'waiting', stateLabel: 'needs you', actionable: true, attachCommand: '', verbs: [] } as never
  act(() => root.render(createElement(SessionLine, { session, selected: false, onOpen: () => {}, lang: 'en' })))
  expect(host.querySelector('[data-row-ending]')).toBeNull()
  act(() => ending.markEnding('row1'))
  expect(host.querySelector('[data-row-ending]')!.textContent).toContain('Ending…')
  // The title keeps one line (truncated) while the label takes the trailing room.
  expect((host.querySelector('[data-line-title]') as HTMLElement).style.whiteSpace).toBe('nowrap')
  act(() => ending.unmarkEnding('row1'))
  expect(host.querySelector('[data-row-ending]')).toBeNull()
  expect((host.querySelector('[data-line-title]') as HTMLElement).style.whiteSpace).toBe('normal')
})

for (const lang of ['pt', 'en'] as const) {
  test(`fast successful kill holds the view, title and aside until the minimum (${lang})`, async () => {
    const { SessionLine } = await import('../nav/SessionLine')
    const session = { id: 'fast', title: 'Fast session', harness: 'claude', cwd: '/x', project: 'x', state: 'waiting', stateLabel: 'needs you', actionable: true, attachCommand: '', verbs: [] } as never
    act(() => root.render(createElement('div', {},
      createElement(SessionLine, { session, selected: true, onOpen: () => {}, lang }),
      createElement(SessionEndingGate, { id: 'fast', lang, title: 'Fast session', children: createElement('textarea', { 'data-composer': '', defaultValue: 'draft' }) }))))
    let navigated = false
    let completion!: Promise<void>
    await act(async () => { completion = ending.withEnding('fast', async () => ({ ok: true }), async () => {}).then(() => { navigated = true }) })
    await act(async () => { await Bun.sleep(50) })
    expect(navigated).toBe(false)
    expect(overlay()!.textContent).toContain('Fast session')
    expect(overlay()!.textContent).toContain(lang === 'pt' ? 'Encerrando…' : 'Ending…')
    expect(host.querySelector('[data-row-ending]')!.textContent).toContain(lang === 'pt' ? 'Encerrando…' : 'Ending…')
    expect(composer().parentElement!.style.display).toBe('none')
    await act(async () => { await completion })
    expect(navigated).toBe(true)
    expect(overlay()).toBeNull()
  })
}

test('success waits beyond the minimum until the session leaves Active', async () => {
  show('slow', 'en')
  let leaveActive!: () => void
  const inactive = new Promise<void>(resolve => { leaveActive = resolve })
  let completion!: Promise<{ ok: boolean }>
  await act(async () => { completion = ending.withEnding('slow', async () => ({ ok: true }), () => inactive) })
  await act(async () => { await Bun.sleep(ending.ENDING_MIN_MS + 30) })
  expect(overlay()).not.toBeNull()
  await act(async () => { leaveActive(); await completion })
  expect(overlay()).toBeNull()
})

test('refused fast kill restores the existing draft immediately without waiting for the fleet', async () => {
  show('refused', 'en')
  composer().value = 'unsent draft'
  let waited = false
  let result!: { ok: boolean; message: string }
  await act(async () => { result = await ending.withEnding('refused', async () => ({ ok: false, message: 'Kill refused' }), async () => { waited = true }) })
  expect(result).toEqual({ ok: false, message: 'Kill refused' })
  expect(waited).toBe(false)
  expect(overlay()).toBeNull()
  expect(composer().value).toBe('unsent draft')
  expect(composer().parentElement!.style.display).toBe('contents')
})

test('useFleet kill waits for the real shared fleet snapshot to leave Active before returning', async () => {
  // Other DOM suites mock the fleet module process-wide. Exercise its real transport in a fresh
  // process so this regression runs identically alone and among the affected tests.
  if (!process.env.ENDING_FLEET_ISOLATED) {
    const child = Bun.spawn([process.execPath, 'test', fileURLToPath(import.meta.url), '--test-name-pattern', 'useFleet kill waits for the real'], {
      env: { ...process.env, ENDING_FLEET_ISOLATED: '1' }, stdout: 'ignore', stderr: 'pipe',
    })
    const errors = await new Response(child.stderr).text()
    expect(await child.exited, errors).toBe(0)
    return
  }
  const { useFleet } = await import('../../lib/fleet')
  const previousFetch = globalThis.fetch
  let active = true
  let state!: ReturnType<typeof useFleet>
  const row = { id: 'fleet-ending', title: 'Fleet session', harness: 'claude', cwd: '/x', project: 'x', state: 'waiting', stateLabel: 'needs you', actionable: true, attachCommand: '', verbs: [] }
  globalThis.fetch = (async (url: string) => {
    if (url.startsWith('/api/fleet/act')) return Response.json({ ok: true, message: 'Ended' })
    if (url.startsWith('/api/fleet?')) return Response.json({ sessions: active ? [row] : [], rows: [], attention: 0, tasks: [], finishedTasks: [] })
    return new Response(null, { status: 404 })
  }) as typeof fetch
  function Driver() {
    state = useFleet('en', false)
    return createElement(SessionEndingGate, { id: row.id, lang: 'en', title: row.title, children: createElement('textarea', { 'data-composer': '', defaultValue: 'draft' }) })
  }
  try {
    await act(async () => { root.render(createElement(Driver)) })
    await act(async () => { state.refresh(); await Bun.sleep(20) })
    let returned = false
    let completion!: ReturnType<typeof state.act>
    await act(async () => { completion = state.act({ id: row.id, action: 'kill' }).then(out => { returned = true; return out }) })
    await act(async () => { await Bun.sleep(ending.ENDING_MIN_MS + 30) })
    expect(returned).toBe(false)
    expect(overlay()!.textContent).toContain(row.title)
    expect(composer().parentElement!.style.display).toBe('none')
    active = false
    await act(async () => { state.refresh(); await completion })
    expect(returned).toBe(true)
    expect(overlay()).toBeNull()
  } finally { globalThis.fetch = previousFetch }
})

for (const replacement of [false, true]) test(`a fast fleet ${replacement ? 'replacement' : 'removal'} holds through a deferred navigation without flashing the chat`, async () => {
  let present = true
  let route = 'selected'
  function SelectedView() {
    const { row, ending: holding } = ending.useEndingSelection(route, present ? { id: 'selected', title: 'Selected session' } : replacement ? { id: 'closed-conversation', title: 'Closed session' } : undefined)
    return row ? createElement(SessionEndingGate, { id: row.id, ending: holding, title: row.title, lang: 'en', children: createElement('textarea', { 'data-composer': '', defaultValue: 'draft' }) }) : createElement('div', {}, 'Overview')
  }
  act(() => root.render(createElement(SelectedView)))
  let completion!: Promise<{ ok: boolean }>
  await act(async () => { completion = ending.withEnding('selected', async () => ({ ok: true }), async () => {}) })
  present = false
  act(() => root.render(createElement(SelectedView)))
  expect(overlay()!.textContent).toContain('Selected session')
  expect(host.textContent).not.toContain('Overview')
  expect(composer().parentElement!.style.display).toBe('none')
  await act(async () => { await completion })
  expect(ending.isEnding('selected')).toBe(false)
  // The request settled, but React Router has not committed the next route yet.
  await act(async () => { await Bun.sleep(100) })
  expect(overlay()!.textContent).toContain('Selected session')
  expect(composer().parentElement!.style.display).toBe('none')
  present = false
  route = 'overview'
  act(() => root.render(createElement(SelectedView)))
  expect(overlay()).toBeNull()
})

test('a refused attempt releases the selected view and retains the draft on the same route', async () => {
  function SelectedView() {
    const { row, ending: holding } = ending.useEndingSelection('refused', { id: 'refused', title: 'Refused session' })
    return createElement(SessionEndingGate, { id: row!.id, ending: holding, lang: 'en', children: createElement('textarea', { 'data-composer': '', defaultValue: 'draft' }) })
  }
  act(() => root.render(createElement(SelectedView)))
  let settle!: (out: { ok: boolean }) => void
  let completion!: Promise<{ ok: boolean }>
  await act(async () => { completion = ending.withEnding('refused', () => new Promise(resolve => { settle = resolve }), async () => {}) })
  expect(overlay()).not.toBeNull()
  await act(async () => { settle({ ok: false }); await completion })
  expect(overlay()).toBeNull()
  expect(composer().value).toBe('draft')
  expect(composer().parentElement!.style.display).toBe('contents')
})

test('each identical refused kill shows a toast even when the bell already has that refusal', async () => {
  if (!process.env.ENDING_REFUSAL_ISOLATED) {
    const child = Bun.spawn([process.execPath, 'test', fileURLToPath(import.meta.url), '--test-name-pattern', 'each identical refused kill'], {
      env: { ...process.env, ENDING_REFUSAL_ISOLATED: '1' }, stdout: 'ignore', stderr: 'pipe',
    })
    const errors = await new Response(child.stderr).text()
    expect(await child.exited, errors).toBe(0)
    return
  }
  // The action menu subscribes to task changes; this test has no event server.
  const previousEventSource = globalThis.EventSource
  globalThis.EventSource = class { addEventListener() {} removeEventListener() {} close() {} } as unknown as typeof EventSource
  const { SessionActions } = await import('./SessionActions')
  const { NotificationToasts } = await import('../NotificationToasts')
  const { refreshNotifications } = await import('../../lib/notifications')
  const previousFetch = globalThis.fetch
  const message = 'Kill refused'
  const notes = [{ id: 'historical', type: 'error', title: 'End session', message, ts: 1, read: false }] as Array<Record<string, unknown>>
  const keys = new Set<string>(['End session:Kill refused'])
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/notifications')) {
      if (init?.method === 'POST') {
        const n = JSON.parse(init.body as string)
        const key = n.meta?.notificationKey ?? `${n.title}:${n.message}`
        if (!keys.has(key)) { keys.add(key); notes.unshift({ ...n, id: `attempt-${keys.size}`, ts: Date.now(), read: false }) }
      }
      return Response.json(notes)
    }
    return new Response(null, { status: 404 })
  }) as typeof fetch
  try {
    await refreshNotifications()
    const row = { id: 'refused', title: 'Refused session', harness: 'claude', cwd: '/x', project: 'x', state: 'waiting', stateLabel: 'needs you', actionable: true, attachCommand: '', verbs: [{ action: 'kill', label: 'Stop session', enabled: true }] } as never
    const refuse = () => ending.withEnding('refused', async () => ({ ok: false, message }), async () => {})
    const { MemoryRouter } = await import('react-router-dom')
    // The toasts can render the bell (burst summary), which navigates: give them a router.
    act(() => root.render(createElement(MemoryRouter, {}, createElement('div', {},
      createElement(SessionActions, { row, lang: 'en', act: refuse }),
      createElement(NotificationToasts, { lang: 'en' })))))
    const click = (label: string) => {
      const button = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)
      expect(button, label).toBeDefined()
      act(() => button!.click())
    }
    expect(host.querySelector('[role="status"]')).toBeNull()
    for (let i = 0; i < 2; i++) {
      click('Session actions'); click('Stop session')
      await act(async () => { click('End'); await Bun.sleep(30) })
      expect(host.querySelector('[role="status"]')?.textContent).toContain(message)
      click('dismiss')
      await act(async () => { await Bun.sleep(280) })
      expect(host.querySelector('[role="status"]')).toBeNull()
    }
    expect(notes).toHaveLength(3)
    expect(keys.size).toBe(3)
  } finally { globalThis.fetch = previousFetch; globalThis.EventSource = previousEventSource }
})

test('timeout: the spinner leaves, the outcome and a retry are shown; retry clears it', async () => {
  show('s9', 'pt')
  let retried = 0
  act(() => root.render(createElement(ending_gate(), { id: 's9', lang: 'pt', onRetry: () => { retried++ }, children: createElement('i') })))
  const run = ending.withEnding('s9', async () => ({ ok: true }), () => new Promise<void>(() => {}), () => true, 30, 'x')
  await act(async () => { await run })
  const o = overlay()!
  expect(o.hasAttribute('data-session-ending-timeout')).toBe(true)
  expect(o.textContent).toContain('Ainda aparece em execução')
  expect(o.getAttribute('aria-busy')).toBe('false')
  act(() => (o.querySelector('[data-ending-retry]') as HTMLButtonElement).click())
  expect(retried).toBe(1)
  expect(overlay()).toBeNull()
})

test('timeout with the session already inactive just settles; ANY terminal state frees the overlay', async () => {
  show('s8', 'en')
  await act(async () => { await ending.withEnding('s8', async () => ({ ok: true }), () => new Promise<void>(() => {}), () => false, 20) })
  expect(ending.isEndingTimedOut('s8')).toBe(false)
  expect(ending.isEnding('s8')).toBe(false)
})

function ending_gate() { return SessionEndingGate }

test('an unconfirmed kill is reported as NOT done, so the caller does not navigate away', async () => {
  const r = await ending.withEnding('s7', async () => ({ ok: true as boolean, message: '' }), () => new Promise<void>(() => {}), () => true, 20, 'still running')
  expect(r.ok).toBe(false)
  expect(r.message).toBe('still running')
  expect(ending.isEndingTimedOut('s7')).toBe(true)
})
