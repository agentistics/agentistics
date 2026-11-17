/**
 * SESSAO.MENU-ENCERRAR (owner 2026-11-17, print 6e73db22): the right-click menu of a LIVE session
 * sometimes had no "Encerrar sessão" while its own footer said "Uma sessão viva fica na lista —
 * encerre-a primeiro". Cause: `rowMenuEntries` swapped End for "Parar o que está fazendo" whenever
 * the row was `working` (and on a native row that one is disabled). One DOM render per row kind ×
 * state: every row that may still be running shows an ENABLED "Encerrar sessão" that picks `kill`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'

let createRoot: typeof import('react-dom/client').createRoot
let menuMod: typeof import('./SessionRowMenu')
let rowMenu: typeof import('../../lib/rowMenu')

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  menuMod = await import('./SessionRowMenu')
  rowMenu = await import('../../lib/rowMenu')
})
afterAll(async () => { await GlobalRegistrator.unregister() })

type Verb = import('../../lib/rowMenu').RowVerb
const forgetLive: Verb = { action: 'forget', label: 'Remover da lista', enabled: false, reason: 'Uma sessão viva fica na lista — encerre-a primeiro.' }
const forgetOk: Verb = { action: 'forget', label: 'Remover da lista', enabled: true }
/** The verbs `fleet-row.ts` builds for a managed (pane or structured) row. */
const managed = (forget: Verb, interruptOn: boolean): Verb[] => [
  { action: 'rename', label: 'Renomear', enabled: true },
  { action: 'kill', label: 'Encerrar sessão', enabled: true },
  // No reason here, as in the print: the footer then carries Remove's "encerre-a primeiro".
  { action: 'resume', label: 'Reabrir', enabled: false },
  forget,
  { action: 'interrupt', label: 'Parar o que está fazendo', enabled: interruptOn, ...(interruptOn ? {} : { reason: 'Não está trabalhando agora.' }) },
]
/** The verbs a NATIVE row carries (`nativeFleetRow.ts` / `nativeActions`): no forget, interrupt dimmed. */
const native: Verb[] = [
  { action: 'rename', label: 'Renomear', enabled: true },
  { action: 'kill', label: 'Encerrar sessão', enabled: true },
  { action: 'resume', label: 'Reabrir', enabled: false },
  { action: 'interrupt', label: 'Parar o que está fazendo', enabled: false, reason: 'Sessão nativa.' },
  { action: 'archive', label: 'Arquivar', enabled: false },
]
/** An EXTERNAL row with a pid: the server enables kill for cleanup. */
const external: Verb[] = [
  { action: 'rename', label: 'Renomear', enabled: false, reason: 'Iniciada fora do agentop.' },
  { action: 'kill', label: 'Encerrar sessão', enabled: true },
  { action: 'resume', label: 'Reabrir', enabled: false },
  forgetOk,
  { action: 'interrupt', label: 'Parar o que está fazendo', enabled: false },
]

const LIVE: Array<[string, Verb[], string, number | undefined]> = [
  ['managed · working (the print: a busy leader)', managed(forgetLive, true), 'working', undefined],
  ['managed · waiting', managed(forgetLive, false), 'waiting', undefined],
  ['managed · waiting-approval', managed(forgetLive, false), 'waiting-approval', undefined],
  ['managed · idle', managed(forgetLive, false), 'idle', undefined],
  ['managed · lost, backend unread', managed(forgetOk, false), 'lost', undefined],
  ['native · working', native, 'working', undefined],
  ['native · waiting', native, 'waiting', undefined],
  ['external · unknown (with a pid)', external, 'unknown', undefined],
]

async function render(verbs: Verb[], state: string, endedAt: number | undefined, extra: Verb[] = []) {
  const picked: string[] = []
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(menuMod.SessionRowMenu, {
      x: 10, y: 10, entries: rowMenu.rowMenuEntries(verbs, state, extra, endedAt),
      onPick: (a: string) => { picked.push(a) }, onClose: () => {},
    }))
  })
  const menus = document.querySelectorAll('[role="menu"]')
  expect(menus.length).toBe(1) // the previous render's portal is gone
  const menu = menus[0]!
  const items = Array.from(menu.querySelectorAll('[role="menuitem"]')) as HTMLButtonElement[]
  const cleanup = async () => { await act(async () => { root.unmount() }); host.remove() }
  return { items, picked, cleanup, menu }
}

describe('the session row menu always offers "Encerrar sessão" on a live row', () => {
  for (const [name, verbs, state, endedAt] of LIVE) {
    test(name, async () => {
      // Group/task/pin extras are part of the real menu too; End must survive among them.
      const extra: Verb[] = [
        { action: 'link-task', label: 'Vincular a uma tarefa…', enabled: true },
        { action: 'move-to-group', label: 'Mover para grupo…', enabled: true },
        { action: '__pin__', label: 'Fixar no topo', enabled: true },
      ]
      const r = await render(verbs, state, endedAt, extra)
      const end = r.items.find(b => b.textContent?.includes('Encerrar sessão'))
      expect(end).toBeDefined()
      expect(end!.disabled).toBe(false)
      await act(async () => { end!.click() })
      expect(r.picked).toEqual(['kill'])
      await r.cleanup()
    })
  }

  test('a busy row ALSO offers "Parar o que está fazendo", just above End', async () => {
    const r = await render(managed(forgetLive, true), 'working', undefined)
    const labels = r.items.map(b => b.textContent ?? '')
    const stop = labels.findIndex(l => l.includes('Parar o que está fazendo'))
    const end = labels.findIndex(l => l.includes('Encerrar sessão'))
    expect(stop).toBeGreaterThanOrEqual(0)
    expect(end).toBe(stop + 1)
    await r.cleanup()
  })

  test('the footer never says "encerre-a primeiro" without an enabled End in the same menu', async () => {
    for (const state of ['working', 'waiting', 'waiting-approval', 'idle']) {
      const r = await render(managed(forgetLive, state === 'working'), state, undefined)
      expect(r.menu.textContent).toContain('encerre-a primeiro')
      expect(r.items.some(b => b.textContent?.includes('Encerrar sessão') && !b.disabled)).toBe(true)
      await r.cleanup()
    }
  })

  test('an ended row offers no End (Reopen applies) — exited, closed, and a confirmed loss', async () => {
    for (const [state, endedAt] of [['exited', undefined], ['closed', undefined], ['lost', 1]] as const) {
      const r = await render(managed(forgetOk, false), state, endedAt)
      expect(r.items.some(b => b.textContent?.includes('Encerrar sessão'))).toBe(false)
      await r.cleanup()
    }
  })
})
