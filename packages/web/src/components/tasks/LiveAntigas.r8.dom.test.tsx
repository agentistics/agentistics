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

test('one click: the dialog previews "N concluídas, M arquivadas" and a single confirm concludes the whole group', async () => {
  const sent: Record<string, unknown>[] = []
  globalThis.fetch = (async (_url, options) => {
    const body = JSON.parse(String(options?.body)); sent.push(body)
    if (body.preview) return Response.json({ ok: true, action: 'conclude', done: [], preview: { conclude: 1, archive: 1 } })
    return Response.json({ done: body.ids.map((id: string) => ({ subtaskId: id, ok: true, how: id === 's-a7e7d9df9f' ? 'concluded' : 'archived' })) })
  }) as typeof fetch
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(createElement(Antigas, {
    open: true, pt: true, mobile: true, onClose() {}, onOpen() {},
    items: [
      { key: 't-d9e9fff3f6', taskId: 't-d9e9fff3f6', subtaskId: null, title: 'Cold start' },
      { key: 't-e1dea7cd6f/s-a7e7d9df9f', taskId: 't-e1dea7cd6f', subtaskId: 's-a7e7d9df9f', title: 'REFS.1' },
    ],
  })))
  expect(document.querySelector('[data-live-antigas-all-publish]')).toBeNull()
  expect(document.querySelector('[data-live-antigas-all-archive]')).toBeNull()
  expect(document.querySelector('[data-live-antigas-all]')?.textContent).toContain('Todas (2)')
  await act(async () => { (document.querySelector('[data-live-antigas-all]') as HTMLElement).click(); await new Promise(r => setTimeout(r, 10)) })
  expect(sent[0]).toMatchObject({ action: 'conclude', preview: true })
  expect(document.body.textContent).toContain('1 concluída, 1 arquivada')
  const confirm = Array.from(document.querySelectorAll('button')).findLast(b => b.textContent === 'Concluir')
  expect(confirm).toBeDefined()
  await act(async () => { confirm!.click(); await new Promise(r => setTimeout(r, 10)) })
  expect(sent[1]).toEqual({ action: 'conclude', ids: ['t-d9e9fff3f6', 's-a7e7d9df9f'], expect: 2 })
  expect(sent).toHaveLength(2)
  expect(document.querySelectorAll('[data-live-archived]')).toHaveLength(0)
})

for (const pt of [true, false]) {
  test(`R4: with ONE piece the action is labelled for that piece, never "all" (${pt ? 'pt' : 'en'})`, async () => {
    globalThis.fetch = ((async () => Response.json({ ok: true, action: 'conclude', done: [], preview: { conclude: 1, archive: 0 } })) as unknown) as typeof fetch
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root!.render(createElement(Antigas, {
      open: true, pt, mobile: false, onClose() {}, onOpen() {},
      items: [{ key: 't-e1dea7cd6f/s-a7e7d9df9f', taskId: 't-e1dea7cd6f', subtaskId: 's-a7e7d9df9f', title: 'REFS.1' }],
    })))
    const label = document.querySelector('[data-live-antigas-all]')?.textContent ?? ''
    expect(label).toBe(pt ? 'Concluir esta peça' : 'Conclude this piece')
    expect(label).not.toMatch(/Todas|All|\(1\)/)
  })
}
