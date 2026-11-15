import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import fixture from '../components/tasks/ptSweep.fixture.json'

/**
 * The task page (`/tasks/<id>`) and the status/type editor, rendered in pt: none of the English literals
 * their code used to hard-code may reach a pt reader, and en keeps them. Same list-based guard as
 * `TasksPtLiterals.dom.test.tsx`. Session/board DATA (a status name, a comment body) is never on a list.
 */

let root: Root | undefined
let createRoot: typeof import('react-dom/client').createRoot
let rr: typeof import('react-router-dom')
let Page: typeof import('./TasksPage').default
let Modal: typeof import('../components/tasks/ManageStatusesModal').ManageStatusesModal
let realFetch: typeof fetch

const DETAIL = {
  task: {
    ...fixture.tasks[0]!.task,
    id: 't-detail',
    title: 'Task detail',
    status: 'todo',
    detail: 'A described task',
    claim: undefined,
  },
  attempts: [],
  rollup: fixture.tasks[0]!.rollup,
  stats: {
    models: [], harnesses: [], tokens: null, agentRuns: null, filesModified: null, linesAdded: null,
    linesRemoved: null, commits: null, toolErrors: null, deliveryMs: null, firstSessionAt: null, lastSessionAt: null,
  },
  sessions: [], comments: [], subtasks: [], files: [], subtaskRollups: [],
}

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  rr = await import('react-router-dom')
  Page = (await import('./TasksPage')).default
  Modal = (await import('../components/tasks/ManageStatusesModal')).ManageStatusesModal
  ;(Element.prototype as { animate?: unknown }).animate = () => ({ cancel() {}, finish() {}, finished: new Promise(() => {}), onfinish: null })
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  realFetch = globalThis.fetch
  ;(globalThis as { EventSource?: unknown }).EventSource = class { close() {} addEventListener() {} removeEventListener() {} onerror = null; onmessage = null }
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/tasks/statuses')) return Response.json({ statuses: fixture.statuses.statuses.map(s => ({ ...s, usageCount: 0 })) })
    if (url.includes('/api/tasks/types')) return Response.json({ types: [] })
    if (/\/api\/tasks\/t-detail/.test(url)) return Response.json({ task: DETAIL })
    return new Response('{}', { status: 503 })
  }) as unknown as typeof fetch
})
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = '' })
afterAll(async () => { globalThis.fetch = realFetch; GlobalRegistrator.unregister() })

function textOf(): string {
  const attrs = Array.from(document.querySelectorAll('[title],[aria-label],[placeholder]'))
    .flatMap(e => ['title', 'aria-label', 'placeholder'].map(a => e.getAttribute(a) ?? ''))
  const nodes: string[] = []
  const walk = document.createTreeWalker(document.body, 4)
  for (let n = walk.nextNode(); n; n = walk.nextNode()) nodes.push(n.textContent ?? '')
  return `${nodes.join('\n')}\n${attrs.join('\n')}`
}

/** Whole-word match: `Close` must not be found inside a pt word. */
const has = (text: string, lit: string) => new RegExp(`(^|[^\\p{L}])${lit.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}($|[^\\p{L}])`, 'u').test(text)

async function settle(until: string) {
  for (let i = 0; i < 400; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 25)) })
    if ((document.body.textContent ?? '').includes(until)) break
  }
  await act(async () => { await new Promise(r => setTimeout(r, 100)) })
}

async function detailText(tab: string, lang: 'pt' | 'en'): Promise<string> {
  const ctx = { lang, filters: {}, theme: 'dark' } as never
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const { MemoryRouter, Routes, Route, Outlet } = rr
  await act(async () => {
    root!.render(createElement(MemoryRouter, { initialEntries: [`/tasks/t-detail?tab=${tab}`] },
      createElement(Routes, null,
        createElement(Route, { element: createElement(Outlet, { context: ctx }) },
          createElement(Route, { path: '/tasks/:id', element: createElement(Page) })))))
  })
  await settle('Task detail')
  return textOf()
}

async function modalText(lang: 'pt' | 'en'): Promise<string> {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(createElement(Modal, { lang, onClose() {} })) })
  await settle(lang === 'pt' ? 'Status e tipos' : 'Statuses and types')
  // Open the new-status colour picker so its own labels are on screen too.
  const color = document.querySelector<HTMLElement>(`button[title="${lang === 'pt' ? 'Cor' : 'Colour'}"]:last-of-type`)
  await act(async () => { color?.click() })
  return textOf()
}

const DETAIL_ENGLISH: Record<string, string[]> = {
  files: ['No files yet', 'Attach', 'Grid', 'List', '0 files'],
  about: ['Edit description'],
}
const DETAIL_KEEP: Record<string, string[]> = {
  files: ['No files yet', 'Attach', 'Grid', '0 files'],
  about: ['Edit description'],
}
for (const tab of Object.keys(DETAIL_ENGLISH)) {
  test(`/tasks/<id> ?tab=${tab}: pt carries no hard-coded English`, async () => {
    const text = await detailText(tab, 'pt')
    expect(text).toContain('Task detail')
    for (const lit of DETAIL_ENGLISH[tab]!) expect({ tab, lit, found: has(text, lit) }).toEqual({ tab, lit, found: false })
  }, 30000)
  test(`/tasks/<id> ?tab=${tab}: en still reads English`, async () => {
    const text = await detailText(tab, 'en')
    for (const lit of DETAIL_KEEP[tab]!) expect({ tab, lit, found: has(text, lit) }).toEqual({ tab, lit, found: true })
  }, 30000)
}

test('ManageStatusesModal: pt carries no hard-coded English', async () => {
  const text = await modalText('pt')
  expect(text).toContain('Status e tipos')
  for (const lit of ['Close', 'Custom colour', 'Colour', 'Reorder', 'Search', 'Create', 'New status', 'Loading']) {
    expect({ lit, found: has(text, lit) }).toEqual({ lit, found: false })
  }
}, 30000)
test('ManageStatusesModal: en still reads English', async () => {
  const text = await modalText('en')
  for (const lit of ['Close', 'Custom colour', 'Search', 'Create', 'New status']) expect({ lit, found: has(text, lit) }).toEqual({ lit, found: true })
}, 30000)
