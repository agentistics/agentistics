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
const originalFetch = globalThis.fetch
const originalEventSource = globalThis.EventSource
const originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
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
const rows = [row('live-pin', 'working'), row('live-folder', 'waiting'), row('live-hidden', 'unknown'), row('worker', 'working'), row('ended', 'exited')]

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 900 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.EventSource = class { close() {} addEventListener() {} removeEventListener() {} } as never
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
})

afterAll(async () => {
  globalThis.fetch = originalFetch
  globalThis.EventSource = originalEventSource
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
  await GlobalRegistrator.unregister()
})

for (const width of [1280, 390]) test(`leaders-only is flat and restores the normal aside at ${width}px`, async () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  window.matchMedia = (() => ({ matches: width < 768, addEventListener() {}, removeEventListener() {} })) as never
  await loadSharedPrefs()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  let opened: string | undefined
  const render = (fleet = rows, valueFilters = filters) => act(() => root.render(
    <MemoryRouter><SessionsAside lang="en" rows={fleet} filters={valueFilters} activeOnly={false}
      loading={false} unsupported={false} finishedTasks={[]} hideNew onOpenRow={s => { opened = s.id }} />
    </MemoryRouter>,
  ))
  const chip = () => host.querySelector<HTMLButtonElement>('[data-leaders-only]')!
  try {
    render()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(chip().textContent).toBe('3 leaders')
    expect(host.textContent).toContain('Pinned')
    expect(host.textContent).toContain('Visible folder marker')
    expect(host.textContent).toContain('Title ended')
    // Leave a summary filter selected: it must neither change the count nor cut the flat list.
    const needs = Array.from(host.querySelectorAll<HTMLButtonElement>('[aria-label="Sessions summary"] button'))
      .find(b => b.textContent?.includes('needs you'))!
    act(() => needs.click())
    expect(needs.getAttribute('aria-pressed')).toBe('true')
    const normal = host.textContent
    expect(chip().textContent).toBe('3 leaders')
    act(() => chip().click())
    const list = host.querySelector('[data-leaders-list]')!
    expect(list).toBeTruthy()
    expect(list.children).toHaveLength(3)
    for (const id of ['live-pin', 'live-folder', 'live-hidden']) expect(list.textContent).toContain(`Title ${id}`)
    for (const text of ['Pinned', 'Groups', 'Visible folder marker', 'Hidden folder marker', 'Title worker', 'Title ended', 'Inactive']) {
      expect(host.textContent).not.toContain(text)
    }
    expect(host.querySelectorAll('[aria-label="Sessions summary"] button')).toHaveLength(1)
    act(() => (list.children[0] as HTMLButtonElement).click())
    expect(opened).toBeDefined()
    act(() => chip().click())
    expect(host.querySelector('[data-leaders-list]')).toBeNull()
    expect(host.textContent).toBe(normal)
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>('[aria-label="Sessions summary"] button'))
      .find(b => b.textContent?.includes('needs you'))!.getAttribute('aria-pressed')).toBe('true')

    // Value filters affect both the count and list, including pinned and hidden-folder leaders.
    act(() => writePrefs({ leadersOnly: true }))
    render(rows, { ...filters, harnesses: ['claude'] })
    expect(chip().textContent).toBe('0 leaders')
    expect(host.querySelector('[data-leaders-list]')!.children).toHaveLength(0)
    expect(host.textContent).toContain('No active leaders')
    act(() => chip().click())
    expect(host.querySelector('[data-leaders-only]')).toBeNull()
    render(rows.filter(r => r.state === 'exited'))
    expect(host.querySelector('[data-leaders-only]')).toBeNull()
  } finally {
    act(() => root.unmount())
    writePrefs({ leadersOnly: false })
    host.remove()
  }
})

for (const width of [1280, 390]) for (const lang of ['en', 'pt'] as const) {
  test(`leaders-only explains an empty list despite raw pins (${lang}, ${width}px)`, async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    window.matchMedia = (() => ({ matches: width < 768, addEventListener() {}, removeEventListener() {} })) as never
    await loadSharedPrefs()
    act(() => writePrefs({ leadersOnly: true }))
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const emptyText = lang === 'pt' ? 'Nenhum líder ativo' : 'No active leaders'
    const render = (fleet: ControlSession[], valueFilters = filters, loading = false) => act(() => root.render(
      <MemoryRouter><SessionsAside lang={lang} rows={fleet} filters={valueFilters} activeOnly
        loading={loading} unsupported={false} finishedTasks={[]} hideNew />
      </MemoryRouter>,
    ))
    try {
      // A raw pinned worker or ended leader must never mask the leaders-only empty state.
      for (const fleet of [rows.filter(r => r.id === 'worker'), rows.filter(r => r.id === 'ended'), []]) {
        render(fleet)
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
        expect(host.querySelector('[data-leaders-list]')!.children).toHaveLength(0)
        expect(host.textContent).toContain(emptyText)
        expect(host.querySelector('[data-leaders-only]')!.textContent).toContain('0')
      }
      // The value filters hide every leader while pins still resolve from the raw fleet.
      render(rows, { ...filters, harnesses: ['claude'] })
      expect(host.querySelector('[data-leaders-list]')!.children).toHaveLength(0)
      expect(host.textContent).toContain(emptyText)
      // Loading takes precedence over a confident empty result.
      render([], filters, true)
      expect(host.textContent).not.toContain(emptyText)
      expect(host.textContent).toContain(lang === 'pt' ? 'Lendo as sessões' : 'Reading this machine')
      render(rows)
      expect(host.querySelector('[data-leaders-list]')!.children).toHaveLength(3)
      expect(host.textContent).not.toContain(emptyText)
    } finally {
      act(() => root.unmount())
      act(() => writePrefs({ leadersOnly: false }))
      host.remove()
    }
  })
}
