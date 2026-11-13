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
  Object.defineProperty(SVGElement.prototype, 'animate', { configurable: true, writable: true, value: undefined })
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



async function paint(props: { loading: boolean; closedTotal?: number; historyLoading?: boolean; tab?: 'active' | 'ended' }) {
  await loadSharedPrefs()
  act(() => writePrefs({ leadersOnly: false, tab: props.tab ?? 'active', foldedTeams: [] }))
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  act(() => root.render(
    <MemoryRouter><SessionsAside lang="pt" rows={[]} filters={filters} activeOnly={false}
      loading={props.loading} historyLoading={props.historyLoading} {...(props.closedTotal ? { closedTotal: props.closedTotal } : {})}
      unsupported={false} finishedTasks={[]} hideNew rowsById={new Map()} act={async () => ({ ok: true, message: '' })} />
    </MemoryRouter>,
  ))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return { host, done: async () => { await act(async () => root.unmount()); host.remove() } }
}

test('no data yet: the aside says it is reading, never "no sessions"', async () => {
  const m = await paint({ loading: true })
  try {
    expect(m.host.textContent).toContain('Lendo as sessões')
    expect(m.host.textContent).not.toContain('Nenhuma sessão nesta máquina ainda')
  } finally { await m.done() }
})

test('live view empty but the machine holds ended conversations: never "no sessions on this machine"', async () => {
  const m = await paint({ loading: false, closedTotal: 85 })
  try {
    expect(m.host.textContent).toContain('85 conversas estão em Encerradas')
    expect(m.host.textContent).not.toContain('Nenhuma sessão nesta máquina ainda')
  } finally { await m.done() }
})


// G (owner, 2026-11-06): the "rest of the history is still loading" caveat is NOT on the Sessions
// list. It is a quick notice raised once when Encerradas is entered, and only if still loading.
const loadingNotice = () => Array.from(document.body.querySelectorAll('[data-action-notice]')).find(el => el.textContent?.includes('Carregando o resto das sessões'))

test('partial history says nothing on the active tab, and never claims that search found nothing', async () => {
  const m = await paint({ loading: false, historyLoading: true })
  try {
    expect(m.host.textContent).not.toContain('Carregando o resto das sessões')
    expect(loadingNotice()).toBeUndefined()
    expect(m.host.textContent).not.toContain('Nenhuma sessão nesta máquina ainda')
  } finally { await m.done() }
})

test('entering Encerradas while the history still loads raises ONE quick notice; loaded, nothing', async () => {
  const m = await paint({ loading: false, historyLoading: true, tab: 'ended' })
  try {
    const notice = loadingNotice()
    expect(notice).toBeDefined()
    expect(notice!.hasAttribute('data-transient')).toBe(true) // the 2 s bottom toast, not a standing banner
    expect(notice!.textContent).toContain('parciais')
    expect(m.host.textContent).not.toContain('Carregando o resto das sessões')
  } finally { await m.done() }
  const loaded = await paint({ loading: false, historyLoading: false, tab: 'ended' })
  try { expect(loadingNotice()).toBeUndefined() } finally { await loaded.done() }
})
