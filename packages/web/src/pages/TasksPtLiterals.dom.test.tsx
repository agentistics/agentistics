import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import fixture from '../components/tasks/ptSweep.fixture.json'

/**
 * The four Agentask views, rendered in pt: none of the English literals the code used to hard-code may
 * reach a pt reader, and en keeps them. A list-based guard — a new hard-coded English label in one of
 * these views is added to the list, not argued about.
 *
 * Seeded, user-editable status names ("To do", "In progress"…) are DATA, not literals, and are not on it.
 */

let root: Root | undefined
let createRoot: typeof import('react-dom/client').createRoot
let rr: typeof import('react-router-dom')
let Page: typeof import('./TasksPage').default
let realFetch: typeof fetch
let boardPrefs: typeof import('../components/tasks/boardPrefs')

/** Alpha's claim in the fixture is long expired; a clone of it (same status, so same visible group) holds a LIVE one. */
function liveClaim(tasks: typeof fixture.tasks) {
  const at = new Date().toISOString()
  const alpha = tasks[0]!
  const live = { ...alpha, task: { ...alpha.task, id: 't-live-claim', title: 'Task delta', claim: { by: 'claude:live', at, expiresAt: new Date(Date.now() + 2 * 3600_000 + 60_000).toISOString(), sessionId: 'live', note: '' } } }
  return [...tasks, live]
}

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  rr = await import('react-router-dom')
  Page = (await import('./TasksPage')).default
  boardPrefs = await import('../components/tasks/boardPrefs')
  ;(Element.prototype as { animate?: unknown }).animate = () => ({ cancel() {}, finish() {}, finished: new Promise(() => {}), onfinish: null })
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  realFetch = globalThis.fetch
  ;(globalThis as { EventSource?: unknown }).EventSource = class { close() {} addEventListener() {} removeEventListener() {} onerror = null; onmessage = null }
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/tasks/statuses')) return Response.json({ statuses: fixture.statuses })
    if (/\/api\/tasks(\?|$)/.test(url)) return Response.json({ tasks: liveClaim(fixture.tasks), overview: fixture.overview, excludedByFilter: 0, total: fixture.tasks.length })
    return new Response('{}', { status: 503 })
  }) as unknown as typeof fetch
})
// The arrangement store is process-wide: another test file in the same process may have left columns/groups
// picked, which would hide the Priority column here. Start from the defaults and leave them as found.
beforeEach(() => { boardPrefs.writeBoardPrefs({ ...boardPrefs.DEFAULT_PREFS }) })
afterEach(async () => { boardPrefs.writeBoardPrefs({ ...boardPrefs.DEFAULT_PREFS }); await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = '' })
afterAll(async () => { globalThis.fetch = realFetch; GlobalRegistrator.unregister() })

/** Text that only exists once the fixture's list has rendered. */
const READY: Record<string, string> = { '/tasks/metrics': '142', '/tasks/board': 'Task alpha', '/tasks/table': 'Task alpha' }

async function visibleText(path: string, lang: 'pt' | 'en'): Promise<string> {
  const ctx = { lang, filters: {}, theme: 'dark' } as never
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const { MemoryRouter, Routes, Route, Outlet } = rr
  await act(async () => {
    root!.render(createElement(MemoryRouter, { initialEntries: [path] },
      createElement(Routes, null,
        createElement(Route, { element: createElement(Outlet, { context: ctx }) },
          createElement(Route, { path: '/tasks/*', element: createElement(Page) })))))
  })
  // Wait for the data to be ON SCREEN, not for a fixed time: under the whole suite the table takes far longer than alone.
  const ready = READY[path]
  for (let i = 0; i < 400; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 25)) })
    if (!ready || (document.body.textContent ?? '').includes(ready)) break
  }
  await act(async () => { await new Promise(r => setTimeout(r, 100)) })
  const attrs = Array.from(document.querySelectorAll('[title],[aria-label],[placeholder]'))
    .flatMap(e => ['title', 'aria-label', 'placeholder'].map(a => e.getAttribute(a) ?? ''))
  const nodes: string[] = []
  const walk = document.createTreeWalker(document.body, 4)
  for (let n = walk.nextNode(); n; n = walk.nextNode()) nodes.push(n.textContent ?? '')
  return `${nodes.join('\n')}\n${attrs.join('\n')}`
}

/** Whole-word match: `Urgent` must not be found inside the pt `Urgente`. */
const has = (text: string, lit: string) => new RegExp(`(^|[^\\p{L}])${lit.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}($|[^\\p{L}])`, 'u').test(text)

/** English literals that used to be hard-coded in each view (a seeded status NAME is never on this list). */
const OLD_ENGLISH: Record<string, string[]> = {
  '/tasks/metrics': [
    'In flight', 'Delivered', 'Avg delivery time', 'Avg cost / task', 'Total spent', 'Rounds / task',
    'Sessions / task', 'Sessions filed', 'Top models across tasks', 'Open work', 'Tasks marked done',
    'Mean spend', 'Overlay All', 'Axes', 'Legend', 'on the board', 'Ranked by tokens',
  ],
  '/tasks/board': ['Urgent', 'High', 'Medium', 'attempts', 'cost covers', 'over WIP', 'subtasks', 'live right now', 'lease expired', 'left'],
  '/tasks/table': ['Urgent', 'High', 'Medium', 'Drag to reorder column', 'Clear the selection', 'Move to…', 'lease expired', 'left'],
  '/tasks/live': ['Could not read the deliveries right now', 'Loading…'],
}
/** What en must still say, so a guard that "passes" because the page rendered empty cannot go unnoticed. */
const KEEP_ENGLISH: Record<string, string[]> = {
  '/tasks/metrics': ['In flight', 'Overlay All', 'Total spent'],
  '/tasks/board': ['Urgent', 'lapsed'],
  '/tasks/table': ['Urgent', 'lease expired', 'left'],
  '/tasks/live': ['Could not read the deliveries'],
}

for (const path of Object.keys(OLD_ENGLISH)) {
  test(`${path}: pt carries no hard-coded English`, async () => {
    const text = await visibleText(path, 'pt')
    expect(text.length).toBeGreaterThan(200)
    for (const lit of OLD_ENGLISH[path]!) expect({ path, lit, found: has(text, lit) }).toEqual({ path, lit, found: false })
  })
  test(`${path}: en still reads English`, async () => {
    const text = await visibleText(path, 'en')
    for (const lit of KEEP_ENGLISH[path]!) expect({ path, lit, found: has(text, lit) }).toEqual({ path, lit, found: true })
  })
}

/** The claim cell sits in the narrow Trabalhando column: a wrapped "faltam 1 h" doubled the row's height (QA r3). */
test('/tasks/table: the claim pill and its remaining time never wrap', async () => {
  for (const lang of ['pt', 'en'] as const) {
    await visibleText('/tasks/table', lang)
    const cells = Array.from(document.querySelectorAll<HTMLElement>('[data-claim-cell]'))
    expect(cells.length).toBeGreaterThan(1)
    for (const cell of cells) {
      expect(cell.style.whiteSpace).toBe('nowrap')
      for (const part of Array.from(cell.querySelectorAll<HTMLElement>('[data-claim-pill],[data-claim-left]'))) expect(part.style.whiteSpace).toBe('nowrap')
    }
    await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ''
  }
})
