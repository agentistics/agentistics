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
  act(() => ending.unmarkEnding('row1'))
  expect(host.querySelector('[data-row-ending]')).toBeNull()
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

for (const replacement of [false, true]) test(`a fast fleet ${replacement ? 'replacement' : 'removal'} retains the selected view and title until ending completes`, async () => {
  let present = true
  function SelectedView() {
    const { row } = ending.useEndingSelection('selected', present ? { id: 'selected', title: 'Selected session' } : replacement ? { id: 'closed-conversation', title: 'Closed session' } : undefined)
    return row ? createElement(SessionEndingGate, { id: row.id, title: row.title, lang: 'en', children: createElement('textarea', { 'data-composer': '', defaultValue: 'draft' }) }) : createElement('div', {}, 'Overview')
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
  expect(overlay()).toBeNull()
  if (!replacement) expect(host.textContent).toBe('Overview')
  else expect(composer()).not.toBeNull()
})
