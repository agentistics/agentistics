import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

let root: Root | undefined
let createRoot: typeof import('react-dom/client').createRoot
let Antigas: typeof import('./LiveAntigas').LiveAntigas
const realFetch = globalThis.fetch
beforeAll(async () => {
  GlobalRegistrator.register({ width: 390, height: 844 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  Antigas = (await import('./LiveAntigas')).LiveAntigas
})
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.innerHTML = ''; root = undefined; globalThis.fetch = realFetch
})
afterAll(() => GlobalRegistrator.unregister())

test('task and subtask cards count and act through the same dialog', async () => {
  const sent: object[] = []
  globalThis.fetch = (async (_url, options) => {
    const body = JSON.parse(String(options?.body)); sent.push(body)
    return Response.json({ done: body.ids.map((id: string) => ({ subtaskId: id, ok: true })) })
  }) as typeof fetch
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(createElement(Antigas, {
    open: true, pt: true, mobile: true, onClose() {}, onOpen() {},
    items: [
      { key: 't-d9e9fff3f6', taskId: 't-d9e9fff3f6', subtaskId: null, title: 'Cold start' },
      { key: 't-e1dea7cd6f/s-a7e7d9df9f', taskId: 't-e1dea7cd6f', subtaskId: 's-a7e7d9df9f', title: 'REFS.1' },
    ],
  })))
  expect(document.querySelector('[data-live-antigas-all-publish]')?.textContent).toContain('Todas (2)')
  expect(document.querySelector('[data-live-antiga-publish="t-d9e9fff3f6"]')).not.toBeNull()
  await act(async () => (document.querySelector('[data-live-antigas-all-publish]') as HTMLElement).click())
  expect(document.body.textContent).toContain('Concluído · sem prova de release')
  // The confirmation is a real UI action, with no HTTP server behind the fetch stub.
  const confirm = Array.from(document.querySelectorAll('button')).findLast(b => b.textContent === 'Marcar concluído')
  expect(confirm).toBeDefined()
  await act(async () => { confirm!.click(); await new Promise(r => setTimeout(r, 10)) })
  expect(sent).toEqual([{ action: 'publish', ids: ['t-d9e9fff3f6', 's-a7e7d9df9f'], expect: 2 }])
  expect(document.querySelectorAll('[data-live-archived]')).toHaveLength(0)
})
