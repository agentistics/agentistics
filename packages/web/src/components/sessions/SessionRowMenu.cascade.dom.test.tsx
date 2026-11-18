/**
 * SESSAO.MENU-AGRUPADO (owner 2026-11-17: "opção A"): the row menu is a cascade by subject.
 * Pure grouping (`cascadeRowMenu`) + the DOM behaviour: hover / click / keyboard open, ← / Esc close,
 * flip at the viewport edge, every action of every row kind still reachable, End on every live row,
 * and the phone's nested sheet.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'

let createRoot: typeof import('react-dom/client').createRoot
let menuMod: typeof import('./SessionRowMenu')
let rowMenu: typeof import('../../lib/rowMenu')
let cascade: typeof import('../../lib/rowMenuCascade')
let team: typeof import('../../lib/teamMenu')
let notify: typeof import('../../lib/notifyMenu')
let bridge: typeof import('../../lib/nayDockBridge')

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  menuMod = await import('./SessionRowMenu')
  rowMenu = await import('../../lib/rowMenu')
  cascade = await import('../../lib/rowMenuCascade')
  team = await import('../../lib/teamMenu')
  notify = await import('../../lib/notifyMenu')
  bridge = await import('../../lib/nayDockBridge')
})
afterAll(async () => { await GlobalRegistrator.unregister() })
const mounted = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const cleanup of mounted) await cleanup()
  document.body.innerHTML = ''
})

type Verb = import('../../lib/rowMenu').RowVerb
type Entry = import('../../lib/rowMenu').MenuEntry

const forgetLive: Verb = { action: 'forget', label: 'Remover da lista', enabled: false, reason: 'Uma sessão viva fica na lista — encerre-a primeiro.' }
const forgetOk: Verb = { action: 'forget', label: 'Remover da lista', enabled: true }
const managed = (forget: Verb, interruptOn: boolean): Verb[] => [
  { action: 'rename', label: 'Renomear', enabled: true },
  { action: 'kill', label: 'Encerrar sessão', enabled: true },
  { action: 'resume', label: 'Reabrir', enabled: false },
  forget,
  { action: 'interrupt', label: 'Parar o que está fazendo', enabled: interruptOn, ...(interruptOn ? {} : { reason: 'Não está trabalhando agora.' }) },
]
const native: Verb[] = [
  { action: 'rename', label: 'Renomear', enabled: true },
  { action: 'kill', label: 'Encerrar sessão', enabled: true },
  { action: 'resume', label: 'Reabrir', enabled: false },
  { action: 'interrupt', label: 'Parar o que está fazendo', enabled: false, reason: 'Sessão nativa.' },
  { action: 'archive', label: 'Arquivar', enabled: false },
]
const external: Verb[] = [
  { action: 'rename', label: 'Renomear', enabled: false, reason: 'Iniciada fora do agentop.' },
  { action: 'kill', label: 'Encerrar sessão', enabled: true },
  { action: 'resume', label: 'Reabrir', enabled: false },
  forgetOk,
  { action: 'interrupt', label: 'Parar o que está fazendo', enabled: false },
]

interface Row { id: string; task?: string; inGroup: boolean; leader: boolean; inTeam: boolean; role?: 'leader' | 'worker'; muted?: boolean; desktop?: boolean }

/** The flat list SessionsAside builds (same builders, same order), then the cascade over it. */
function build(verbs: Verb[], state: string, row: Row, endedAt?: number): { flat: Entry[]; grouped: Entry[] } {
  const pt = true
  const extra: Entry[] = [
    ...(row.desktop === false ? [] : [{ action: cascade.OPEN_BESIDE, label: 'Abrir ao lado', enabled: true }]),
    ...rowMenu.taskMenuEntries(row.task, pt),
    { action: 'move-to-group', label: 'Mover para grupo…', enabled: true },
    ...(row.inGroup ? [{ action: 'remove-from-group', label: 'Remover do grupo', enabled: true }] : []),
    { action: cascade.PIN_TOGGLE, label: 'Fixar no topo', enabled: true },
    { action: 'session-role-label', label: 'Tipo', enabled: false },
    { action: 'session-role:', label: 'Automático', enabled: true, checked: row.role === undefined },
    { action: 'session-role:leader', label: 'Líder', enabled: true, checked: row.role === 'leader' },
    { action: 'session-role:worker', label: 'Worker', enabled: true, checked: row.role === 'worker' },
    ...team.teamMenuExtras({ id: row.id, title: 't', state, ...(row.inTeam ? { parentSessionId: 'p' } : {}) } as never, row.leader, [{ id: 'L2', title: 'other' } as never], pt),
    ...notify.notifyMenuExtras({ id: row.id }, row.muted ? [`${row.id}`] : [], pt),
  ]
  const base = rowMenu.rowMenuEntries(verbs, state, extra, endedAt)
  const flat = row.desktop === false ? base : bridge.withUndockEntry(base, pt, true) as Entry[]
  return { flat, grouped: cascade.cascadeRowMenu(flat, { pt, task: row.task, isLeader: row.leader }) }
}

const leaderRow: Row = { id: 'S1', task: 'Jarvis mode — voice call with Nay', inGroup: true, leader: true, inTeam: false, role: 'leader' }

/** Every leaf action (a submenu's children included). */
const leaves = (list: readonly Entry[]): string[] => list.flatMap(e => (e.children ? leaves(e.children) : [e.action]))

describe('cascadeRowMenu — the grouping', () => {
  test('the print row (live working leader) is the prototype: 9 rows, 4 cascades, End in red at the bottom', () => {
    const { grouped } = build(managed(forgetLive, true), 'working', leaderRow)
    expect(grouped.map(e => e.label)).toEqual([
      'Renomear', 'Abrir', 'Parar o que está fazendo', 'Tarefa', 'Organizar', 'Tipo', 'Silenciar notificações', 'Encerrar sessão', 'Remover da lista',
    ])
    expect(grouped.filter(e => e.children).map(e => e.label)).toEqual(['Abrir', 'Tarefa', 'Organizar', 'Tipo'])
    expect(grouped.find(e => e.label === 'Abrir')!.children!.map(e => e.label)).toEqual(['Abrir ao lado', 'Abrir desacoplada'])
    expect(grouped.find(e => e.label === 'Tarefa')!.hint).toBe(leaderRow.task!)
    expect(grouped.find(e => e.label === 'Tipo')!.hint).toBe('Líder')
    const end = grouped.find(e => e.label === 'Encerrar sessão')!
    expect(end.danger).toBe(true)
    expect(end.separatorBefore).toBe(true)
    expect(grouped.find(e => e.label === 'Tarefa')!.separatorBefore).toBe(true)
    // Organizar: pin | group | team, in that order, with separators between the three blocks.
    const org = grouped.find(e => e.label === 'Organizar')!.children!
    expect(org.map(e => e.label)).toEqual(['Fixar no topo', 'Mover para grupo…', 'Remover do grupo', 'Mover para a equipe de…', 'Tirar da equipe'])
    expect(org.map(e => !!e.separatorBefore)).toEqual([false, true, false, true, false])
    // A leader is told why the team rows are off.
    expect(org.slice(3).every(e => !e.enabled && e.reason === 'Um líder não entra em equipe.')).toBe(true)
    // Tarefa: open / move / unlink under the task's name.
    const tk = grouped.find(e => e.label === 'Tarefa')!
    expect(tk.children!.map(e => e.label)).toEqual(['Abrir a tarefa', 'Mover para outra tarefa…', 'Desvincular da tarefa'])
    expect(tk.heading).toBe(leaderRow.task!)
  })

  const KINDS: Array<[string, Verb[], string, number | undefined, boolean]> = [
    ['managed · working', managed(forgetLive, true), 'working', undefined, true],
    ['managed · waiting', managed(forgetLive, false), 'waiting', undefined, true],
    ['managed · waiting-approval', managed(forgetLive, false), 'waiting-approval', undefined, true],
    ['managed · lost, unread', managed(forgetOk, false), 'lost', undefined, true],
    ['native · working', native, 'working', undefined, true],
    ['external', external, 'unknown', undefined, true],
    ['managed · exited', managed(forgetOk, false), 'exited', undefined, false],
    ['managed · closed', managed(forgetOk, false), 'closed', undefined, false],
    ['managed · lost, confirmed', managed(forgetOk, false), 'lost', 1, false],
  ]
  const ROWS: Array<[string, Row]> = [
    ['unfiled worker in a team', { id: 'S2', inGroup: false, leader: false, inTeam: true, role: 'worker' }],
    ['filed leader in a group', leaderRow],
    ['unfiled, automatic, no group, muted', { id: 'S3', inGroup: false, leader: false, inTeam: false, muted: true, desktop: false }],
  ]
  for (const [kn, verbs, state, endedAt, live] of KINDS) {
    for (const [rn, row] of ROWS) {
      test(`${kn} × ${rn}: nothing lost, End on live rows only`, () => {
        const { flat, grouped } = build(verbs, state, row, endedAt)
        const have = new Set(leaves(grouped))
        for (const a of leaves(flat)) {
          if (a === 'session-role-label') continue // the heading the "Tipo" submenu replaces
          const f0 = flat.find(e => e.action === a)
          if (a === 'resume' && f0 && !f0.enabled && !f0.reason) continue // dropped on purpose (see cascade)
          expect(have.has(a)).toBe(true)
        }
        // Enabled-ness is untouched: a refused action stays refused, with its reason.
        const flatByAction = new Map(flat.map(e => [e.action, e]))
        const walk = (l: readonly Entry[]) => l.forEach(e => {
          if (e.children) return walk(e.children)
          const f = flatByAction.get(e.action)
          if (f && f.action !== rowMenu.LINK_TASK) expect(e.enabled).toBe(f.enabled)
        })
        walk(grouped)
        const end = grouped.find(e => e.action === 'kill')
        if (live) { expect(end).toBeDefined(); expect(end!.enabled).toBe(true); expect(end!.danger).toBe(true) } else expect(end).toBeUndefined()
        // Tall lists are gone: at most the prototype's 9 rows at the first level.
        expect(grouped.length).toBeLessThanOrEqual(10)
      })
    }
  }

  test('an unfiled row has the single "Vincular a uma tarefa…" under Tarefa and no hint', () => {
    const { grouped } = build(managed(forgetLive, false), 'waiting', { id: 'S3', inGroup: false, leader: false, inTeam: false })
    const tk = grouped.find(e => e.label === 'Tarefa')!
    expect(tk.hint).toBeUndefined()
    expect(tk.children!.map(e => e.label)).toEqual(['Vincular a uma tarefa…'])
  })

  test('an action the grouping does not know stays reachable at the top level', () => {
    const flat: Entry[] = [{ action: 'rename', label: 'Renomear', enabled: true }, { action: 'novel', label: 'Novo', enabled: true }]
    expect(leaves(cascade.cascadeRowMenu(flat, { pt: true }))).toContain('novel')
  })
})

describe('submenuPlacement — never off screen', () => {
  const P = (left: number, right: number, top: number, h = 200) => menuMod.submenuPlacement({ left, right, top }, 232, h, 1280, 800)
  test('fits on the right', () => expect(P(300, 536, 300)).toEqual({ left: 538, top: 295, flipped: false }))
  test('flips to the left at the right edge', () => {
    const p = P(1000, 1236, 300)
    expect(p.flipped).toBe(true)
    expect(p.left + 232).toBeLessThanOrEqual(1000)
  })
  test('shifts up at the bottom edge', () => {
    const p = P(300, 536, 700, 300)
    expect(p.top + 300).toBeLessThanOrEqual(800 - 4)
  })
  test('never above the top or left of the viewport', () => {
    const p = menuMod.submenuPlacement({ left: 4, right: 20, top: 0 }, 232, 100, 300, 200)
    expect(p.left).toBeGreaterThanOrEqual(8)
    expect(p.top).toBeGreaterThanOrEqual(4)
  })
})

// ---- DOM ----------------------------------------------------------------------------------------

async function mount(entries: Entry[], x = 40, y = 40) {
  const picked: string[] = []
  let closed = 0
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  const cleanup = async () => { if (!mounted.delete(cleanup)) return; await act(async () => { root.unmount() }); host.remove() }
  mounted.add(cleanup)
  await act(async () => {
    root.render(createElement(menuMod.SessionRowMenu, { x, y, entries, onPick: (a: string) => { picked.push(a) }, onClose: () => { closed++ } }))
  })
  return {
    picked, closed: () => closed,
    menus: () => Array.from(document.querySelectorAll('[role="menu"]')) as HTMLElement[],
    sub: () => document.querySelector('[data-submenu]') as HTMLElement | null,
    root: () => document.querySelector('[role="menu"]:not([data-submenu])') as HTMLElement,
    item: (label: string, within?: HTMLElement | null) => Array.from((within ?? document).querySelectorAll('[role="menuitem"]')).find(b => b.querySelector('[data-menu-title]')?.textContent === label) as HTMLButtonElement,
    cleanup,
  }
}
const hover = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
const key = (el: Element, k: string) => act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })) })
const click = (el: Element) => act(async () => { (el as HTMLElement).click() })

describe('the cascade, in the DOM (desktop)', () => {
  const entries = () => build(managed(forgetLive, true), 'working', leaderRow).grouped

  test('hover opens the submenu, hovering a plain row drops it, hovering another cascade swaps it', async () => {
    const m = await mount(entries())
    expect(m.sub()).toBeNull()
    await hover(m.item('Organizar'))
    expect(m.sub()?.dataset.submenu).toBe('Organizar')
    await hover(m.item('Tipo'))
    expect(m.sub()?.dataset.submenu).toBe('Tipo')
    await hover(m.item('Renomear'))
    expect(m.sub()).toBeNull()
    await m.cleanup()
  })

  test('click opens it (touch / mouse), and picking a child acts and closes the menu', async () => {
    const m = await mount(entries())
    await click(m.item('Tarefa'))
    expect(m.sub()).not.toBeNull()
    expect(m.picked).toEqual([]) // opening is not picking
    await click(m.item('Desvincular da tarefa', m.sub()))
    expect(m.picked).toEqual([rowMenu.UNLINK_TASK])
    expect(m.closed()).toBe(1)
    await m.cleanup()
  })

  test('Enter / → open it and focus the first child; ← closes it back to the parent; Esc closes only the submenu', async () => {
    const m = await mount(entries())
    const parent = m.item('Organizar')
    await act(async () => { parent.focus() })
    await key(m.root(), 'ArrowRight')
    expect(m.sub()?.dataset.submenu).toBe('Organizar')
    expect(document.activeElement).toBe(m.item('Fixar no topo', m.sub()))
    await key(m.sub()!, 'ArrowDown')
    expect(document.activeElement).toBe(m.item('Mover para grupo…', m.sub()))
    await key(m.sub()!, 'ArrowLeft')
    expect(m.sub()).toBeNull()
    expect(document.activeElement).toBe(parent)
    // Enter on a focused parent (a click on a button) opens it.
    await act(async () => { parent.focus() })
    await click(parent)
    expect(m.sub()).not.toBeNull()
    // Esc: first the submenu, then the whole menu.
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(m.sub()).toBeNull()
    expect(m.closed()).toBe(0)
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(m.closed()).toBe(1)
    await m.cleanup()
  })

  test('arrow keys walk the root list, skipping disabled rows', async () => {
    const m = await mount(entries())
    await act(async () => { m.item('Renomear').focus() })
    await key(m.root(), 'ArrowDown')
    expect(document.activeElement).toBe(m.item('Abrir'))
    await key(m.root(), 'ArrowUp')
    expect(document.activeElement).toBe(m.item('Renomear'))
    await key(m.root(), 'End')
    // "Remover da lista" is disabled on a live row, so End lands on "Encerrar sessão".
    expect(document.activeElement).toBe(m.item('Encerrar sessão'))
    await m.cleanup()
  })

  test('the submenu flips to the left when its parent row is at the right edge', async () => {
    const m = await mount(entries(), 1000, 40)
    const parent = m.item('Organizar')
    const rect = { left: 1010, right: 1236, top: 120, bottom: 150, width: 226, height: 30, x: 1010, y: 120, toJSON() {} }
    parent.getBoundingClientRect = () => rect as DOMRect
    await hover(parent)
    const sub = m.sub()!
    const left = parseFloat(sub.style.left)
    expect(left + 232).toBeLessThanOrEqual(1010)
    expect(left).toBeGreaterThanOrEqual(8)
    await m.cleanup()
  })

  test('the submenu stays inside the viewport at the bottom edge', async () => {
    const m = await mount(entries(), 40, 40)
    const parent = m.item('Organizar')
    const bottomRect = { left: 50, right: 276, top: window.innerHeight - 20, bottom: window.innerHeight + 10, width: 226, height: 30, x: 50, y: window.innerHeight - 20, toJSON() {} }
    parent.getBoundingClientRect = () => bottomRect as DOMRect
    await hover(parent)
    const sub = m.sub()!
    const top = parseFloat(sub.style.top)
    expect(top).toBeGreaterThanOrEqual(4)
    expect(top).toBeLessThanOrEqual(window.innerHeight - 4)
    await m.cleanup()
  })

  test('measured root and every submenu fit near the bottom in desktop viewports', async () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    const width = window.innerWidth, height = window.innerHeight
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() {
      if (this.hasAttribute('data-submenu')) return this.dataset.submenu === 'Organizar' ? 230 : 160
      return this.getAttribute('role') === 'menu' ? 340 : 30
    } })
    try {
      for (const [vw, vh] of [[1280, 800], [1024, 600], [1280, 720]] as const) {
        Object.assign(window, { innerWidth: vw, innerHeight: vh })
        const m = await mount(entries(), 40, vh - 10)
        expect(parseFloat(m.root().style.top) + 340).toBeLessThanOrEqual(vh)
        for (const label of ['Abrir', 'Tarefa', 'Organizar', 'Tipo']) {
          const parent = m.item(label)
          parent.getBoundingClientRect = () => ({ left: 40, right: 276, top: vh - 20 }) as DOMRect
          await hover(parent)
          const sub = m.sub()!
          expect(parseFloat(sub.style.top) + sub.offsetHeight).toBeLessThanOrEqual(vh)
          expect(parseFloat(sub.style.top)).toBeGreaterThanOrEqual(0)
        }
        await m.cleanup()
      }
    } finally {
      Object.assign(window, { innerWidth: width, innerHeight: height })
      if (original) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', original)
      else delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight
    }
  })

  test('the footer note of each level carries that level\'s own reason', async () => {
    const m = await mount(entries())
    expect(m.root().querySelector('[data-menu-note]')?.textContent).toContain('encerre-a primeiro')
    await hover(m.item('Organizar'))
    expect(m.sub()!.querySelector('[data-menu-note]')?.textContent).toBe('Um líder não entra em equipe.')
    await m.cleanup()
  })

  test('an outside press closes the menu; a press inside the submenu does not', async () => {
    const m = await mount(entries())
    await hover(m.item('Organizar'))
    await act(async () => { m.sub()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(m.closed()).toBe(0)
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(m.closed()).toBe(1)
    await m.cleanup()
  })

  test('every inventory action of the print row is pickable through the DOM', async () => {
    const list = entries()
    const want = leaves(list).filter(a => a !== 'forget') // forget is disabled on a live row
    for (const a of want) {
      const m = await mount(entries())
      const parent = list.findIndex(e => e.children?.some(c => c.action === a))
      if (parent >= 0) await click(m.item(list[parent]!.label))
      const scope = parent >= 0 ? m.sub() : m.root()
      const btn = (Array.from(scope!.querySelectorAll('[role="menuitem"]')) as HTMLButtonElement[]).find((b, idx) => {
        const src = parent >= 0 ? list[parent]!.children![idx] : list.filter(e => true)[idx]
        return src?.action === a
      })
      if (btn && !btn.disabled) { await click(btn); expect(m.picked).toEqual([a]) }
      await m.cleanup()
    }
  })
})

describe('the cascade on a phone (390): a nested sheet, never off screen', () => {
  test('a cascading row drills into its children with a back row; 44px targets', async () => {
    const prevW = window.innerWidth
    ;(window as unknown as { innerWidth: number }).innerWidth = 390
    const m = await mount(build(managed(forgetLive, true), 'working', leaderRow).grouped)
    expect(m.root().querySelector('[data-menu-back]')).toBeNull()
    await click(m.item('Organizar'))
    expect(m.sub()).toBeNull() // no side cascade on a phone
    const back = m.root().querySelector('[data-menu-back]') as HTMLButtonElement
    expect(back).not.toBeNull()
    expect(back.style.minHeight).toBe('44px')
    expect(m.item('Fixar no topo')).toBeDefined()
    expect(m.item('Fixar no topo').style.minHeight).toBe('44px')
    expect(m.item('Renomear')).toBeUndefined() // the list was REPLACED by the submenu
    // The menu itself fits the width.
    expect(parseFloat(m.root().style.left) + parseFloat(m.root().style.width)).toBeLessThanOrEqual(390)
    await click(m.item('Fixar no topo'))
    expect(m.picked).toEqual([cascade.PIN_TOGGLE])
    await m.cleanup()
    // Back returns to the top list.
    const m2 = await mount(build(managed(forgetLive, true), 'working', leaderRow).grouped)
    await click(m2.item('Tipo'))
    await click(m2.root().querySelector('[data-menu-back]')!)
    expect(m2.item('Renomear')).toBeDefined()
    await m2.cleanup()
    ;(window as unknown as { innerWidth: number }).innerWidth = prevW
  })
})
