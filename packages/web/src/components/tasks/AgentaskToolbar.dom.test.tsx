import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { TaskStatusDef } from '@agentistics/core'
import { defaultVisibleStatuses } from './statusDefaults'

const def = (id: string, label: string, order: number) =>
  ({ id, label, color: '#999', order, protected: false } as unknown as TaskStatusDef)
const LIST = [def('backlog', 'Backlog', 0), def('todo', 'To do', 1), def('in_progress', 'In progress', 2),
  def('blocked', 'Blocked', 3), def('in_review', 'In review', 4), def('done', 'Done', 5), def('abandoned', 'Abandoned', 6)]

let createRoot: typeof import('react-dom/client').createRoot
let ViewPanel: typeof import('./AgentaskToolbar').ViewPanel
let AgentaskToolbar: typeof import('./AgentaskToolbar').AgentaskToolbar
let oldAct: boolean | undefined
beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  oldAct = (globalThis as any).IS_REACT_ACT_ENVIRONMENT
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  ;({ ViewPanel, AgentaskToolbar } = await import('./AgentaskToolbar'))
})
afterAll(async () => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = oldAct; await GlobalRegistrator.unregister() })

const items = LIST.map(s => ({ id: s.id, label: s.label, color: '#999', count: 0 }))
const mkState = (shown: string[], over: Record<string, unknown> = {}) => ({
  view: 'board' as const, items, shown, shownIsDefault: true, groupBy: 'status' as const, lanes: 'none' as const,
  sort: { key: 'manual', dir: 'asc' } as never, wip: {}, hideEmpty: false, compose: true, ...over,
})
const noop = () => {}
const mkActions = (log: string[]) => ({
  onShown: (n: string[]) => log.push(`shown:${n.join(',')}`), onGroupBy: noop, onLanes: noop, onSort: noop, onWip: noop,
  onHideEmpty: (v: boolean) => log.push(`hideEmpty:${v}`), onCompose: noop,
  onManage: () => log.push('manage'), onRestore: () => log.push('restore'),
})

async function mount(node: React.ReactElement, width = 1280) {
  ;(window as any).happyDOM.setViewport({ width, height: 900 })
  window.matchMedia = ((q: string) => ({ matches: q.includes('max-width') && width < 768, addEventListener() {}, removeEventListener() {} })) as never
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(node) })
  return { host, unmount: () => act(async () => { root.unmount(); host.remove() }) }
}

for (const lang of ['pt', 'en'] as const) {
  test(`panel: default shows 5 statuses in order, the rest hidden and re-showable (${lang})`, async () => {
    const shown = defaultVisibleStatuses(LIST)
    expect(shown).toEqual(['blocked', 'todo', 'in_progress', 'in_review', 'done'])
    const log: string[] = []
    const { host, unmount } = await mount(<ViewPanel lang={lang} statuses={LIST} state={mkState(shown)} actions={mkActions(log)} />)
    const rows = Array.from(host.querySelectorAll('[data-visible-list] [data-status-row]')).map(e => e.getAttribute('data-status-row'))
    expect(rows).toEqual(shown)
    const hidden = Array.from(host.querySelectorAll('[data-hidden-list] [data-hidden-row]')).map(e => e.getAttribute('data-hidden-row'))
    expect(hidden).toEqual(['backlog', 'abandoned'])
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-show="backlog"]')!.click() })
    expect(log).toContain(`shown:${shown.join(',')},backlog`)
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-hide="done"]')!.click() })
    expect(log).toContain('shown:blocked,todo,in_progress,in_review')
    await unmount()
  })

  test(`panel: restore default, manage and hide-empty fire (${lang})`, async () => {
    const log: string[] = []
    const { host, unmount } = await mount(<ViewPanel lang={lang} statuses={LIST} state={mkState(defaultVisibleStatuses(LIST))} actions={mkActions(log)} />)
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-restore]')!.click() })
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-manage]')!.click() })
    await act(async () => { host.querySelector<HTMLInputElement>('[data-opt="hideEmpty"]')!.click() })
    expect(log).toEqual(['restore', 'manage', 'hideEmpty:true'])
    await unmount()
  })
}

test('toolbar: one row, search + view button + switcher + new task; chips are removable', async () => {
  const cleared: string[] = []
  const state = mkState(['todo', 'done'], { shownIsDefault: false, hideEmpty: true })
  const { host, unmount } = await mount(
    <AgentaskToolbar lang="en" q="" onQ={noop} state={state} actions={mkActions([])} statuses={LIST}
      onView={noop} onNew={noop} onOpenSheet={noop} onClearChip={id => cleared.push(id)} />)
  expect(host.querySelectorAll('[data-toolbar]').length).toBe(1)
  expect(host.querySelector('input[placeholder="Search"]')).not.toBeNull()
  expect(host.querySelectorAll('[data-view]').length).toBe(4)
  expect(host.querySelector('[data-chip="visible"]')!.textContent).toContain('5 hidden')
  await act(async () => { host.querySelector<HTMLButtonElement>('[data-chip="hideEmpty"] button')!.click() })
  expect(cleared).toEqual(['hideEmpty'])
  await unmount()
})

test('toolbar on a phone is a single line with a 44px filters button that asks for the sheet', async () => {
  let asked = 0
  const { host, unmount } = await mount(
    <AgentaskToolbar lang="pt" q="" onQ={noop} state={mkState(defaultVisibleStatuses(LIST))} actions={mkActions([])} statuses={LIST}
      onView={noop} onNew={noop} onOpenSheet={() => { asked++ }} onClearChip={noop} />, 390)
  const btn = host.querySelector<HTMLButtonElement>('button[aria-label="Visualização"]')!
  expect(btn.style.height).toBe('44px')
  await act(async () => { btn.click() })
  expect(asked).toBe(1)
  expect(host.querySelectorAll('[data-view]').length).toBe(0)
  await unmount()
})
