import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import type { Filters } from '@agentistics/core'
import type { Root } from 'react-dom/client'

let createRoot: typeof import('react-dom/client').createRoot
let MemoryRouter: typeof import('react-router-dom').MemoryRouter
let SessionsAside: typeof import('./SessionsAside').SessionsAside
let loadSharedPrefs: typeof import('../../lib/sharedPref').loadSharedPrefs
let writePrefs: typeof import('../../lib/sessionsAsidePrefs').writeAsideGroupPrefs
let readPrefs: typeof import('../../lib/sessionsAsidePrefs').readAsideGroupPrefs
let originalFetch: typeof globalThis.fetch
let originalEventSource: typeof globalThis.EventSource
let originalActEnvironment: boolean | undefined
let svgAnimate: PropertyDescriptor | undefined
const roles = { 'live-pin': 'leader', 'live-folder': 'leader', 'live-hidden': 'leader', ended: 'leader' }
const prefs = {
  sessionsAside: { leadersOnly: false },
  pinnedSessions: ['live-pin', 'worker', 'ended'],
  sessionGroups: { groups: [
    { id: 'visible', name: 'Visible folder marker', sessionKeys: ['live-folder'] },
    { id: 'hidden', name: 'Hidden folder marker', sessionKeys: ['live-hidden'], hidden: true },
  ] },
}
const filters = { dateRange: 'all', customStart: '', customEnd: '', projects: [], models: [] } as Filters
const row = (id: string, state: ControlSession['state']): ControlSession => ({
  id, title: `Title ${id}`, harness: 'codex', state, stateLabel: state, project: 'project-marker',
  cwd: '/project-marker', searchFields: { name: `Title ${id}`, folder: '', harness: 'codex', note: '', task: '', prompt: '' }, actionable: true, attached: false,
} as ControlSession)
const rows = [row('live-pin', 'working'), row('live-folder', 'waiting'), row('live-hidden', 'unknown'),
  { ...row('worker', 'working'), parentSessionId: 'live-folder' }, row('loose', 'working'), row('ended', 'exited')]

beforeAll(async () => {
  originalFetch = globalThis.fetch
  originalEventSource = globalThis.EventSource
  originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  GlobalRegistrator.register({ width: 1280, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.EventSource = class { close() {} addEventListener() {} removeEventListener() {} } as never
  // This suite checks rows and reopen actions, not Web Animations. Happy DOM rejects unfinished
  // animation promises on cancel; a busy loader must not leak those rejections into later tests.
  svgAnimate = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'animate')
  Object.defineProperty(SVGElement.prototype, 'animate', { configurable: true, value: undefined })
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method && init.method !== 'GET') return Response.json({ ok: true })
    if (url === '/api/user-prefs') return Response.json(prefs, { headers: { 'X-Prefs-Writable': 'false' } })
    if (url === '/api/session-roles') return Response.json({ roles })
    return Response.json({ rows: [], sessions: [] })
  }) as typeof fetch
  createRoot = (await import('react-dom/client')).createRoot
  MemoryRouter = (await import('react-router-dom')).MemoryRouter
  SessionsAside = (await import('./SessionsAside')).SessionsAside
  loadSharedPrefs = (await import('../../lib/sharedPref')).loadSharedPrefs
  writePrefs = (await import('../../lib/sessionsAsidePrefs')).writeAsideGroupPrefs
  readPrefs = (await import('../../lib/sessionsAsidePrefs')).readAsideGroupPrefs
})

afterAll(async () => {
  await new Promise(resolve => setTimeout(resolve, 50))
  if (svgAnimate) Object.defineProperty(SVGElement.prototype, 'animate', svgAnimate)
  else delete (SVGElement.prototype as unknown as { animate?: unknown }).animate
  globalThis.fetch = originalFetch
  globalThis.EventSource = originalEventSource
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
  await GlobalRegistrator.unregister()
})


interface Mount { host: HTMLDivElement; root: Root; opened: string[]; actions: unknown[]; render: (fleet?: ControlSession[], valueFilters?: Filters) => void }
async function mount(width: number, lang: 'en' | 'pt' = 'en'): Promise<Mount> {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  window.matchMedia = (() => ({ matches: width < 768, addEventListener() {}, removeEventListener() {} })) as never
  await loadSharedPrefs()
  act(() => writePrefs({ leadersOnly: false, tab: 'active', foldedTeams: [] }))
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  const m: Mount = {
    host, root, opened: [], actions: [],
    render: (fleet = rows, valueFilters = filters) => act(() => m.root.render(
      <MemoryRouter><SessionsAside lang={lang} rows={fleet} filters={valueFilters} activeOnly={false}
        loading={false} unsupported={false} finishedTasks={[]} hideNew onOpenRow={s => { m.opened.push(s.id) }}
        rowsById={new Map([['ended', { verbs: [{ action: 'resume', enabled: true, label: 'Reopen' }] }]])}
        act={async req => { m.actions.push(req); return { ok: true, message: 'Opened' } }} />
      </MemoryRouter>,
    )),
  }
  m.render()
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return m
}
async function unmount(m: Mount) {
  await act(async () => m.root.unmount())
  act(() => writePrefs({ leadersOnly: false, tab: 'active', foldedTeams: [] }))
  m.host.remove()
}
const teamOf = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-team="${id}"]`)

for (const width of [1280, 390]) test(`Ativas: one card per leader with its team, pinned leader first, nothing drawn twice (${width}px)`, async () => {
  const m = await mount(width)
  try {
    const body = m.host.querySelector<HTMLElement>('[data-tab-body="active"]')!
    const teams = Array.from(body.querySelectorAll<HTMLElement>('[data-team]')).map(t => t.dataset.team)
    expect(teams[0]).toBe('live-pin')
    expect(teams.sort()).toEqual(['live-folder', 'live-hidden', 'live-pin'])
    expect(teamOf(body, 'live-folder')!.querySelector('[data-team-members]')!.textContent).toContain('Title worker')
    expect(body.querySelector('[data-team-loose]')!.textContent).toContain('Title loose')
    // A pinned session is never drawn a second time, and there is no separate pinned band.
    for (const id of ['live-pin', 'live-folder', 'live-hidden', 'worker', 'loose']) {
      expect(body.querySelectorAll(`[title="Title ${id}"]`)).toHaveLength(1)
    }
    expect(m.host.textContent).not.toContain('Pinned')
    expect(body.textContent).not.toContain('Title ended')
    // The old top furniture is gone: no counters line, no fell banner.
    expect(m.host.querySelector('[aria-label="Sessions summary"]')).toBeNull()
    expect(m.host.querySelector('[data-fell-banner]')).toBeNull()
    for (const el of Array.from(m.host.querySelectorAll<HTMLElement>('[data-tab-body] *'))) expect(el.style.textOverflow).not.toBe('ellipsis')
  } finally { await unmount(m) }
})

for (const width of [1280, 390]) test(`the chevron folds; a folded leader only unfolds, an open one opens; a member that starts waiting unfolds it (${width}px)`, async () => {
  const m = await mount(width)
  try {
    const team = () => teamOf(m.host, 'live-folder')!
    const open = () => team().querySelector<HTMLButtonElement>('[data-session-open]')!
    act(() => team().querySelector<HTMLButtonElement>('[data-team-fold]')!.click())
    expect(team().querySelector('[data-team-members]')).toBeNull()
    expect(team().querySelector('[data-team-summary]')!.textContent).toBe('1 in the team')
    expect(readPrefs().foldedTeams).toEqual(['live-folder'])
    act(() => open().click())
    expect(m.opened).toEqual([])
    expect(team().querySelector('[data-team-members]')).not.toBeNull()
    act(() => open().click())
    expect(m.opened).toEqual(['live-folder'])
    // Fold again, then the worker starts waiting on the person: the team opens by itself.
    act(() => team().querySelector<HTMLButtonElement>('[data-team-fold]')!.click())
    m.render(rows.map(r => r.id === 'worker' ? { ...r, state: 'waiting' as const } : r))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(readPrefs().foldedTeams).toEqual([])
    expect(team().querySelector('[data-team-members]')!.textContent).toContain('Title worker')
  } finally { await unmount(m) }
})

for (const width of [1280, 390]) for (const lang of ['en', 'pt'] as const) test(`leaders-only (overflow menu) hides teams and loose rows and explains an empty list (${lang}, ${width}px)`, async () => {
  const m = await mount(width, lang)
  try {
    act(() => writePrefs({ leadersOnly: true }))
    m.render()
    expect(m.host.querySelector('[data-team-members]')).toBeNull()
    expect(m.host.querySelector('[data-team-loose]')).toBeNull()
    expect(m.host.querySelectorAll('[data-team]')).toHaveLength(3)
    m.render(rows.filter(r => r.id === 'worker' || r.id === 'ended'))
    expect(m.host.textContent).toContain(lang === 'pt' ? 'Nenhum líder ativo' : 'No active leaders')
    // The overflow menu carries the switch, checked.
    act(() => m.host.querySelector<HTMLButtonElement>('[data-aside-overflow]')!.click())
    const entry = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(b => b.textContent?.includes(lang === 'pt' ? 'líder' : 'leader'))
    expect(entry?.textContent).toContain('✓')
  } finally { await unmount(m) }
})

for (const width of [1280, 390]) test(`Encerradas: a stopped pinned leader sleeps with its reopen; the tab is remembered (${width}px)`, async () => {
  const m = await mount(width)
  try {
    act(() => m.host.querySelector<HTMLButtonElement>('[data-segment="ended"]')!.click())
    expect(readPrefs().tab).toBe('ended')
    const sleeping = m.host.querySelector<HTMLElement>('[data-ended-section="sleeping"]')!
    expect(sleeping.textContent).toContain('Title ended')
    await act(async () => {
      Array.from(sleeping.querySelectorAll<HTMLButtonElement>('button')).find(b => b.getAttribute('aria-label') === 'Reopen')!.click()
    })
    expect(m.actions).toEqual([{ id: 'ended', action: 'resume' }])
    await act(async () => m.root.unmount())
    m.root = createRoot(m.host)
    m.render()
    expect(m.host.querySelector('[data-segment="ended"]')!.getAttribute('aria-selected')).toBe('true')
    expect(m.host.querySelector('[data-tab-body="ended"]')).not.toBeNull()
  } finally { await unmount(m) }
})
