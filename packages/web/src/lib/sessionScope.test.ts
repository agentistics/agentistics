import { expect, test } from 'bun:test'
import type { Filters } from '@agentistics/core'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { readFileSync } from 'node:fs'
import { filterFleet } from './fleetFilter'
import { dockActiveOnly } from './nayDock'
import { SESSION_LIST_FILTERS } from './sessionScope'

const rows = [
  { id: 'codex', harness: 'codex', state: 'working', cwd: '/app', project: 'app', model: 'gpt-5' },
  { id: 'claude', harness: 'claude', state: 'waiting', cwd: '/other', project: 'other', model: 'opus' },
  { id: 'ended', harness: 'claude', state: 'closed', cwd: '/other', project: 'other', model: 'opus' },
] as ControlSession[]

test('session scope is independent of the metric header state in App', () => {
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
  expect(app.includes('useState<Filters>(SESSION_LIST_FILTERS)')).toBe(true)
  expect(app.includes('const sessionsFilters = listFilters')).toBe(true)
  expect(app.includes('useState(inSessionsWorkspace)')).toBe(true)
})

for (const surface of ['Sessions', 'floating chat'] as const) {
  test(`${surface} keeps its sessions when metric header filters are set`, () => {
    const scope = { filters: SESSION_LIST_FILTERS, activeOnly: surface === 'Sessions' ? true : dockActiveOnly(false, false) }
    const visible = () => filterFleet({ rows, ...scope }).rows.map(r => r.id)
    const before = visible()
    expect(before).toEqual(['codex', 'claude'])
    let metricFilters: Filters = { ...SESSION_LIST_FILTERS }
    for (const patch of [
      { harnesses: ['gemini'] }, { projects: ['/missing'] }, { models: ['missing'] },
      { repos: ['org/missing'] }, { dateRange: '7d' }, { users: ['someone'], tags: ['a-tag'] },
    ] as Partial<Filters>[]) {
      metricFilters = { ...metricFilters, ...patch }
      expect(filterFleet({ rows, filters: metricFilters, activeOnly: false }).rows).toHaveLength(0)
      expect(visible()).toEqual(before)
    }
    expect(SESSION_LIST_FILTERS.harnesses).toBeUndefined()
    expect(SESSION_LIST_FILTERS.projects).toEqual([])
  })
}
