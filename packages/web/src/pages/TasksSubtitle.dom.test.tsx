import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

/** The Agentask page header: the subtitle (and the mobile sheet's view names) follow the UI language. */

let root: Root | undefined
let createRoot: typeof import('react-dom/client').createRoot
let rr: typeof import('react-router-dom')
let Page: typeof import('./TasksPage').default
let realFetch: typeof fetch

const SUB_PT = 'Quanto custou cada trabalho, em quantas rodadas e em quantas sessões.'
const SUB_EN = 'What each piece of work cost, in how many rounds and across how many sessions.'


beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  rr = await import('react-router-dom')
  Page = (await import('./TasksPage')).default
  // happy-dom rejects a cancelled Web Animation on unmount; the page's own animations are not under test.
  ;(Element.prototype as { animate?: unknown }).animate = () => ({ cancel() {}, finish() {}, finished: new Promise(() => {}), onfinish: null })
  realFetch = globalThis.fetch
  ;(globalThis as { EventSource?: unknown }).EventSource = class { close() {} addEventListener() {} removeEventListener() {} onerror = null; onmessage = null }
  globalThis.fetch = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch
})
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = '' })
afterAll(async () => { globalThis.fetch = realFetch; GlobalRegistrator.unregister() })

async function header(lang: 'pt' | 'en') {
  const ctx = { lang, filters: {}, theme: 'dark' } as never
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const { MemoryRouter, Routes, Route, Outlet } = rr
  await act(async () => {
    root!.render(createElement(MemoryRouter, { initialEntries: ['/tasks'] },
      createElement(Routes, null,
        createElement(Route, { element: createElement(Outlet, { context: ctx }) },
          createElement(Route, { path: '/tasks/*', element: createElement(Page) })))))
  })
  await act(async () => { await new Promise(r => setTimeout(r, 50)) })
  return document.body.textContent ?? ''
}

test('Agentask subtitle is Portuguese in pt and English in en', async () => {
  const pt = await header('pt')
  expect(pt).toContain(SUB_PT)
  expect(pt).not.toContain(SUB_EN)
  await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ''
  const en = await header('en')
  expect(en).toContain(SUB_EN)
  expect(en).not.toContain(SUB_PT)
})

test('mobile sheet view names come from the desktop toolbar table (no second copy)', async () => {
  const { viewNames } = await import('../components/tasks/AgentaskToolbar')
  const p = viewNames('pt'), e = viewNames('en')
  expect([p.metrics, p.board, p.table, p.live]).toEqual(['Métricas', 'Quadro', 'Tabela', 'Esteira de entregas'])
  expect([e.metrics, e.board, e.table, e.live]).toEqual(['Metrics', 'Board', 'Table', 'Live Delivery'])
  const { mobileBoardCopy } = await import('../components/tasks/boardCopyThreads')
  expect(mobileBoardCopy('pt').subtitle).toBe(SUB_PT)
  expect(mobileBoardCopy('en').subtitle).toBe(SUB_EN)
})
