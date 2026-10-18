import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import type { Filters } from '@agentistics/core'

let createRoot: typeof import('react-dom/client').createRoot
let MemoryRouter: typeof import('react-router-dom').MemoryRouter
let SessionsAside: typeof import('./SessionsAside').SessionsAside
let loadSharedPrefs: typeof import('../../lib/sharedPref').loadSharedPrefs
let writePrefs: typeof import('../../lib/sessionsAsidePrefs').writeAsideGroupPrefs
let readPrefs: typeof import('../../lib/sessionsAsidePrefs').readAsideGroupPrefs
let groups: typeof import('../../lib/sessionUserGroups')
let originalFetch: typeof fetch
let originalEventSource: typeof EventSource
let originalAct: boolean | undefined
let svgAnimate: PropertyDescriptor | undefined
const filters = { dateRange: 'all', customStart: '', customEnd: '', projects: [], models: [] } as Filters
const prefs = {
  sessionsAside: { leadersOnly: false, collapsedUserGroups: [], expandedEndedGroups: [] },
  pinnedSessions: ['pin-ended'],
  fellDismissed: [],
  sessionGroups: { groups: [
    { id: 'parent', name: 'Active parent', sessionKeys: ['parent-live', 'parent-ended'] },
    { id: 'active-child', name: 'Active child', parentId: 'parent', sessionKeys: ['child-live'] },
    { id: 'idle-child', name: 'Finished child', parentId: 'parent', sessionKeys: ['child-ended'] },
    { id: 'unknown-child', name: 'Unknown child with a full title that must wrap', parentId: 'parent', sessionKeys: ['child-unknown'] },
    { id: 'empty-child', name: 'Empty child', parentId: 'parent', sessionKeys: [] },
    { id: 'archived', name: 'Archived parent', sessionKeys: ['archived-direct'] },
    { id: 'archived-child', name: 'Archived child', parentId: 'archived', sessionKeys: ['archived-nested'] },
    { id: 'hidden', name: 'Hidden folder', hidden: true, sessionKeys: ['hidden-live'] },
  ] },
}
const row = (id: string, state: ControlSession['state']) => ({
  id, title: `Title ${id}`, harness: 'codex', state, stateLabel: state, cwd: '/p', project: 'p',
  searchFields: { name: `Title ${id}`, folder: '', harness: 'codex', note: '', task: '', prompt: '' },
  actionable: true, attached: false,
}) as ControlSession
const fleet = [row('parent-live', 'working'), row('parent-ended', 'exited'), row('child-live', 'waiting'),
  row('child-ended', 'closed'), row('child-unknown', 'unknown'), row('archived-direct', 'closed'),
  row('archived-nested', 'exited'), row('hidden-live', 'working'), row('loose', 'waiting'), row('pin-ended', 'closed')]

beforeAll(async () => {
  originalFetch = globalThis.fetch
  originalEventSource = globalThis.EventSource
  originalAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  GlobalRegistrator.register({ width: 1280, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.EventSource = class { close() {} addEventListener() {} removeEventListener() {} } as never
  svgAnimate = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'animate')
  Object.defineProperty(SVGElement.prototype, 'animate', { configurable: true, value: undefined })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') return Response.json({ ok: true })
    if (String(input) === '/api/user-prefs') return Response.json(prefs, { headers: { 'X-Prefs-Writable': 'false' } })
    if (String(input) === '/api/session-roles') return Response.json({ roles: {} })
    return Response.json({ rows: [], sessions: [] })
  }) as typeof fetch
  createRoot = (await import('react-dom/client')).createRoot
  MemoryRouter = (await import('react-router-dom')).MemoryRouter
  SessionsAside = (await import('./SessionsAside')).SessionsAside
  loadSharedPrefs = (await import('../../lib/sharedPref')).loadSharedPrefs
  const asidePrefs = await import('../../lib/sessionsAsidePrefs')
  writePrefs = asidePrefs.writeAsideGroupPrefs
  readPrefs = asidePrefs.readAsideGroupPrefs
  groups = await import('../../lib/sessionUserGroups')
})
afterAll(async () => {
  await new Promise(resolve => setTimeout(resolve, 50))
  if (svgAnimate) Object.defineProperty(SVGElement.prototype, 'animate', svgAnimate)
  else delete (SVGElement.prototype as unknown as { animate?: unknown }).animate
  globalThis.fetch = originalFetch
  globalThis.EventSource = originalEventSource
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalAct
  await GlobalRegistrator.unregister()
})
let host: HTMLDivElement
let root: Root
beforeEach(async () => {
  await loadSharedPrefs()
  act(() => writePrefs({ leadersOnly: false, foldedPinned: false, foldedGroupsSection: false, collapsedUserGroups: [], expandedEndedGroups: [] }))
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})
const render = async (rows = fleet, width = 1280, lang: 'en' | 'pt' = 'en', valueFilters = filters, activeOnly = false, fellCount = 0, sleepingActions = false) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  window.matchMedia = ((q: string) => ({ matches: q.includes('max-width') && width < 768, addEventListener() {}, removeEventListener() {} })) as never
  const fallen = new Map(Array.from({ length: fellCount }, (_, i) => {
    const session = { id: `fell-${i}`, title: `Fallen ${i}`, fell: true, verbs: [{ action: 'resume', label: 'Reopen', enabled: true }] }
    return [session.id, session] as const
  }))
  if (sleepingActions) fallen.set('pin-ended', { id: 'pin-ended', title: 'Maestro', fell: false, verbs: [{ action: 'resume', label: 'Reabrir', enabled: true }] } as never)
  await act(async () => root.render(<MemoryRouter><SessionsAside rows={rows} lang={lang} filters={valueFilters} activeOnly={activeOnly}
    loading={false} unsupported={false} finishedTasks={[]} hideNew={fellCount === 0} rowsById={fallen}
    {...(fellCount > 0 || sleepingActions ? { act: async () => ({ ok: true, message: '' }) } : {})} /></MemoryRouter>))
}
const folder = (id: string) => host.querySelector<HTMLElement>(`[data-session-folder="${id}"]`)
const ended = (id: string) => host.querySelector<HTMLButtonElement>(`[data-ended-folders="${id}"]`)!
const click = async (button: HTMLElement) => { await act(async () => button.click()) }

for (const width of [1280, 390]) for (const lang of ['en', 'pt'] as const) {
  test(`idle folders collect once at the end of their parent and the list (${lang}, ${width}px)`, async () => {
    document.documentElement.dataset.theme = lang === 'pt' ? 'light' : 'dark'
    await render(fleet, width, lang)
    expect(folder('active-child')).not.toBeNull()
    for (const id of ['idle-child', 'unknown-child', 'empty-child', 'archived', 'archived-child', 'hidden']) expect(folder(id)).toBeNull()
    expect(ended('parent').textContent).toContain(lang === 'pt' ? '3 pastas' : '3 folders')
    expect(ended('parent').textContent).toContain(lang === 'pt' ? '1 sessão' : '1 session')
    expect(ended('parent').getAttribute('aria-expanded')).toBe('false')
    expect(ended('root').textContent).toContain(lang === 'pt' ? '1 grupo' : '1 group')
    expect(host.querySelector('[data-ended-root-folders]')!.parentElement!.lastElementChild).toBe(host.querySelector('[data-ended-root-folders]'))
    expect(host.textContent).toContain(lang === 'pt' ? 'Dormindo' : 'Sleeping')
    await click(ended('parent'))
    expect(folder('idle-child')).not.toBeNull()
    expect(folder('unknown-child')?.textContent).toContain('Unknown child with a full title that must wrap')
    expect(folder('parent')?.querySelectorAll('[data-ended-folders]')).toHaveLength(1)
    expect(folder('idle-child')?.textContent).toContain('Title child-ended')
    const parent = folder('parent')!
    expect(parent.querySelector('[data-ended-folders]')!.compareDocumentPosition(parent.querySelector('[title="Title parent-live"]')!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    await click(ended('root'))
    expect(folder('archived')?.contains(folder('archived-child'))).toBe(true)
    expect(folder('archived')?.textContent).toContain('Title archived-direct')
    expect(folder('archived')?.textContent).toContain('Title archived-nested')
    expect(folder('archived')?.querySelector('[data-ended-folders]')).toBeNull()
    expect(folder('archived')?.querySelector('[title="Drag to reorder"], [title="Arrastar para reordenar"]')?.getAttribute('draggable')).toBe('true')
    expect(folder('idle-child')?.querySelector('[draggable="true"]')).not.toBeNull()
    expect(readPrefs().expandedEndedGroups).toContain('parent')
    await act(async () => root.unmount())
    root = createRoot(host)
    await render(fleet, width, lang)
    expect(ended('parent').getAttribute('aria-expanded')).toBe('true')
    expect(ended('root').getAttribute('aria-expanded')).toBe('true')
  })
}

test('new activity restores a child and its root to the original tree and order', async () => {
  await render()
  const resumed = fleet.map(r => r.id === 'child-ended' || r.id === 'archived-nested' ? { ...r, state: 'waiting-approval' as const } : r)
  await render(resumed)
  expect(folder('parent')?.contains(folder('idle-child'))).toBe(true)
  expect(folder('idle-child')?.contains(ended('parent'))).toBe(false)
  expect(ended('parent').textContent).toContain('2 folders')
  expect(folder('archived')?.contains(folder('archived-child'))).toBe(true)
  expect(host.querySelector('[data-ended-root-folders]')).toBeNull()
  expect(Array.from(host.querySelectorAll('[data-session-folder]')).map(el => el.getAttribute('data-session-folder')))
    .toEqual(['parent', 'active-child', 'idle-child', 'archived', 'archived-child'])
  expect(groups.getSessionGroups().groups.map(g => g.id)).toEqual(prefs.sessionGroups.groups.map(g => g.id))
})

test('filters never reclassify live folders; ended results can still be found with search', async () => {
  await render(fleet, 390, 'en', { ...filters, harnesses: ['claude'] })
  expect(folder('parent')).not.toBeNull()
  expect(folder('archived')).toBeNull()
  await render()
  const search = host.querySelector<HTMLInputElement>('input[type="search"], input[placeholder*="Search"]')!
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setValue.call(search, 'archived-nested'); search.dispatchEvent(new window.Event('input', { bubbles: true })) })
  expect(ended('root').getAttribute('aria-expanded')).toBe('true')
  expect(folder('archived-child')?.textContent).toContain('Title archived-nested')
})

test('an archived folder grip still reorders through the original drag handler', async () => {
  await render()
  await click(ended('root'))
  const grip = folder('archived')!.querySelector('[title="Drag to reorder"]')!
  const data = new window.DataTransfer()
  const event = (type: string) => {
    const e = new window.Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(e, 'dataTransfer', { value: data })
    return e
  }
  await act(async () => { grip.dispatchEvent(event('dragstart')) })
  await act(async () => { folder('parent')!.firstElementChild!.dispatchEvent(event('drop')) })
  const roots = groups.getSessionGroups().groups.filter(g => !g.parentId).map(g => g.id)
  expect(roots.indexOf('archived')).toBeLessThan(roots.indexOf('parent'))
  expect(groups.getSessionGroups().groups.find(g => g.id === 'archived-child')?.parentId).toBe('archived')
})


test('ended trees remain readable while Active only is on, and their expansion starts collapsed', async () => {
  await render(fleet, 390, 'en', filters, true)
  expect(ended('root').getAttribute('aria-expanded')).toBe('false')
  await click(ended('root'))
  const archived = folder('archived')!
  const heading = archived.querySelector<HTMLButtonElement>('button[aria-expanded]')!
  await click(heading)
  expect(archived.textContent).toContain('Title archived-direct')
  const child = folder('archived-child')!
  await click(child.querySelector<HTMLButtonElement>('button[aria-expanded]')!)
  expect(child.textContent).toContain('Title archived-nested')
})


for (const width of [1280, 390]) for (const lang of ['pt', 'en'] as const) for (const count of [1, 4, 128]) {
  test(`reopen-fell stays on one line beside its fixed dismiss control (${lang}, ${count}, ${width}px)`, async () => {
    host.style.width = width === 390 ? '390px' : '288px'
    await render(fleet, width, lang, filters, false, count)
    const banner = host.querySelector<HTMLElement>('[data-fell-banner]')!
    const button = banner.querySelector<HTMLButtonElement>('[data-fell-reopen]')!
    const dismiss = banner.querySelector<HTMLButtonElement>('[data-fell-dismiss]')!
    const label = lang === 'pt' ? (count === 1 ? 'Reabrir 1 que caiu' : `Reabrir ${count} que caíram`) : `Reopen ${count} that fell`
    const sentence = lang === 'pt' ? (count === 1 ? 'Reabrir 1 sessão que caiu' : `Reabrir ${count} sessões que caíram`)
      : (count === 1 ? 'Reopen 1 session that fell' : `Reopen ${count} sessions that fell`)
    expect(button.textContent).toBe(label)
    expect(button.title).toBe(sentence)
    expect(button.getAttribute('aria-label')).toBe(sentence)
    expect(getComputedStyle(button).whiteSpace).toBe('nowrap')
    expect(getComputedStyle(button).textOverflow).not.toBe('ellipsis')
    expect(button.querySelector('svg')!.style.flexShrink).toBe('0')
    expect(dismiss.parentElement).toBe(banner)
    expect(button.nextElementSibling).toBe(dismiss)
    expect(getComputedStyle(dismiss).flexShrink).toBe('0')
    expect(dismiss.style.width).toBe(width === 390 ? '44px' : '30px')
    expect(dismiss.style.minWidth).toBe(width === 390 ? '44px' : '30px')
    expect(dismiss.querySelector('svg')).not.toBeNull()
    await click(dismiss)
    expect(host.querySelector('[data-fell-banner]')).toBeNull()
  })
}

for (const width of [1280, 390]) test(`sleeping and pinned leader names wrap, badges stay intact, and row buttons are siblings (${width}px)`, async () => {
  const { SessionRow } = await import('./SessionsAside')
  const { markReopening, clearReopening } = await import('../../lib/reopeningStore')
  const name = 'Agentistics Side Tasks — revisão de todas as correções'
  const session = { ...row('leader-row', 'closed'), title: `[ LÍDER ] - ${name}`, task: 'Perfis de sessão + modus operandi', model: 'claude-opus-5-5' }
  ;(window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height: 900 })
  let opened = 0, pinned = 0, resumed = 0
  try {
    for (const compact of [false, true]) {
      await act(async () => root.render(<SessionRow session={session} compact={compact} selected={false} pinned cardColor="wash" lang="pt"
        onOpen={() => { opened++ }} onPin={() => { pinned++ }} onReopen={() => { resumed++ }}
        reopenVerb={{ action: 'resume', label: 'Reabrir', enabled: true }} />))
      const card = host.querySelector<HTMLElement>('[data-session-row]')!
      const open = card.querySelector<HTMLButtonElement>('[data-session-open]')!
      const pin = card.querySelector<HTMLButtonElement>('[aria-label="Desafixar"]')!
      expect(open.textContent).toContain(name)
      expect(open.textContent).not.toContain('[ LÍDER ]')
      expect(open.textContent).toContain('Líder')
      expect(pin.tagName).toBe('BUTTON')
      expect(pin.parentElement).toBe(open.parentElement)
      expect(card.querySelector('button button, button [role="button"]')).toBeNull()
      for (const el of Array.from(card.querySelectorAll<HTMLElement>('*'))) expect(el.style.textOverflow).not.toBe('ellipsis')
      await click(pin)
      expect(opened).toBe(compact ? 1 : 0)
      await click(open)
      const resume = Array.from(card.querySelectorAll('button')).find(el => el.getAttribute('aria-label') === 'Reabrir')!
      await click(resume)
      await act(async () => markReopening(session.id))
      expect(open.textContent).toContain('Reabrindo…')
      const badge = Array.from(open.querySelectorAll<HTMLElement>('span')).find(el => el.textContent === 'Líder' && el.style.whiteSpace === 'nowrap')!
      expect(badge.style.flexShrink).toBe('0')
      expect(card.style.flexWrap).toBe(compact ? 'nowrap' : 'wrap')
      await act(async () => clearReopening(session.id))
    }
    expect(opened).toBe(2); expect(pinned).toBe(2); expect(resumed).toBe(2)
  } finally { await act(async () => clearReopening(session.id)) }
})

for (const width of [1280, 390]) test(`ended-only groups suppress the false empty message and names wrap at words (${width}px)`, async () => {
  await act(async () => { groups.renameSessionGroup('archived', 'Agentistics Side Tasks') })
  await render(fleet.filter(r => r.id.startsWith('archived-')), width, 'pt')
  expect(host.textContent).not.toContain('Nenhuma sessão nesta máquina ainda.')
  await click(ended('root'))
  const heading = folder('archived')!.querySelector<HTMLButtonElement>('button[aria-expanded]')!
  const name = Array.from(heading.querySelectorAll<HTMLElement>('span')).find(el => el.textContent === 'Agentistics Side Tasks')!
  expect(name.style.overflowWrap).toBe('normal')
  expect(heading.querySelector('[data-folder-count]')).toBeNull()
})

test('action feedback uses the session title, reserves space, and can be dismissed', async () => {
  const session = { ...row('b4f46fa8d9-session', 'waiting'), title: '[ LÍDER ] - Maestro' }
  await act(async () => root.render(<MemoryRouter><SessionsAside rows={[session]} lang="pt" filters={filters} activeOnly={false}
    loading={false} unsupported={false} finishedTasks={[]} hideNew={false}
    rowsById={new Map([[session.id, { verbs: [{ action: 'kill', label: 'Encerrar', enabled: true }] }]])}
    act={async () => ({ ok: true, message: 'b4f46fa8d9 encerrada.' })} /></MemoryRouter>))
  const card = host.querySelector<HTMLElement>('[data-session-row]')!
  await act(async () => card.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })))
  const kill = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(el => el.textContent === 'Encerrar')!
  await click(kill)
  const notice = Array.from(host.querySelectorAll<HTMLElement>('[role="status"]')).find(el => el.textContent === 'Maestro encerrada.')!
  expect(notice).toBeDefined()
  expect(notice.closest<HTMLElement>('[data-action-notice]')!.style.position).toBe('')
  expect(notice.textContent).not.toContain('b4f46fa8d9')
  await click(host.querySelector<HTMLElement>('[aria-label="Fechar aviso"]')!)
  expect(notice.isConnected).toBe(false)
}, 10000)

for (const width of [1440, 390]) test(`pinned intent survives active/status filters and search narrows sleeping pins at ${width}px`, async () => {
  await render(fleet, width, 'pt', { ...filters, harnesses: ['claude'] }, true)
  const sleeping = () => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === 'Dormindo1')!
  expect(sleeping()).toBeDefined()
  expect(sleeping().getAttribute('aria-expanded')).toBe('false')
  const status = Array.from(host.querySelectorAll<HTMLButtonElement>('[aria-label] button')).find(b => b.textContent?.includes('trabalhando'))
  if (status) await click(status)
  expect(sleeping()).toBeDefined()
  await click(sleeping())
  expect(host.textContent).toContain('Title pin-ended')
  const input = host.querySelector<HTMLInputElement>('input[type="search"], input[placeholder]')!
  const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    nativeSet.call(input, 'no-such-title')
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    input.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  expect(host.textContent).not.toContain('Title pin-ended')
  expect(sleeping()).toBeUndefined()
})

test('ended folders hide totals even for pinned or not-yet-loaded members', async () => {
  await act(async () => {
    groups.addSessionToGroup('archived', 'pin-ended')
  })
  await render(fleet.filter(r => r.id !== 'archived-direct'), 1440, 'en', filters, true)
  await click(ended('root'))
  const header = folder('archived')!.querySelector('button[aria-expanded]')!
  // Two direct memberships (one deferred, one pinned) plus the nested ended member.
  expect(header.querySelector('[data-folder-count]')).toBeNull()
  expect(folder('parent')?.querySelector('[data-folder-count]')).not.toBeNull()
  expect(folder('archived')!.querySelector('[title="Title pin-ended"]')).toBeNull()
})

for (const sidebar of [288, 220, 390]) test(`ended folders omit counters and summary separators trail their unit (${sidebar}px)`, async () => {
  await act(async () => groups.renameSessionGroup('archived', 'Agentistics Side Tasks'))
  const rows = fleet.map(r => r.id === 'pin-ended' ? { ...r, title: '[ LÍDER ] - Maestro (superskill)' } : r)
  await render(rows, sidebar === 390 ? 390 : 1440, 'pt', filters, true, 0, true)
  await click(ended('root'))
  expect(folder('archived')!.querySelector('[data-folder-count]')).toBeNull()
  expect(folder('parent')!.querySelector('[data-folder-count]')).not.toBeNull()
  const units = host.querySelectorAll('[aria-label="Resumo das sessões"] > span')
  for (const unit of Array.from(units)) expect(unit.firstElementChild?.tagName).toBe('BUTTON')
  const sleeping = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === 'Dormindo1')!
  await click(sleeping)

})
