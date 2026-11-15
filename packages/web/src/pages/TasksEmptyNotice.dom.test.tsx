import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

let root: Root | undefined
let createRoot: typeof import('react-dom/client').createRoot
let Notice: typeof import('./TasksPage').EmptyNotice

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  Notice = (await import('./TasksPage')).EmptyNotice
})
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = '' })
afterAll(async () => GlobalRegistrator.unregister())

async function text(props: { lang: string; filtered?: boolean }) {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(createElement(Notice, { error: null, ...props })))
  return (host.textContent ?? '').trim()
}

test('empty board: no command, points to the create field (pt/en)', async () => {
  expect(await text({ lang: 'pt' })).toBe('Ainda não há tarefas. Crie a primeira no campo acima.')
  await act(async () => root?.unmount()); document.body.innerHTML = ''
  expect(await text({ lang: 'en' })).toBe('No tasks yet. Create your first one in the field above.')
})

test('board with tasks but a search/filter matching none says so (pt/en)', async () => {
  expect(await text({ lang: 'pt', filtered: true })).toBe('Nenhuma tarefa corresponde à busca ou aos filtros.')
  await act(async () => root?.unmount()); document.body.innerHTML = ''
  expect(await text({ lang: 'en', filtered: true })).toBe('No task matches the search or filters.')
})

test('the list passes `filtered` from the rows: tasks + no match → filter sentence; empty board → "no tasks yet"', async () => {
  const { ListEmpty } = await import('./TasksPage')
  const show = async (rows: unknown[], lang: string) => {
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root!.render(createElement(ListEmpty, { rows, error: null, lang })))
    const t = (host.textContent ?? '').trim()
    await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ''
    return t
  }
  expect(await show([{ id: 'a' }], 'pt')).toBe('Nenhuma tarefa corresponde à busca ou aos filtros.')
  expect(await show([], 'pt')).toBe('Ainda não há tarefas. Crie a primeira no campo acima.')
  expect(await show([{ id: 'a' }], 'en')).toBe('No task matches the search or filters.')
  expect(await show([], 'en')).toBe('No tasks yet. Create your first one in the field above.')
})
