import { describe, expect, test } from 'bun:test'
import { applyLeadersOnly, countLeaders, leadersText } from './leadersFilter'
import { arrangeChangedCount, DEFAULT_ASIDE_GROUP_PREFS, parseAsideGroupPrefs } from './sessionsAsidePrefs'
import { countActiveFilters } from './activeFilterCount'
import { ACTIVE_STATES, filterSessions, type ControlSession } from '@agentistics/tui/control/session-fleet'
import { filterFleet } from './fleetFilter'
import type { Filters } from '@agentistics/core'
import type { SessionRole } from './sessionRoles'

type R = { id: string; state: string; role?: SessionRole }
const roleOf = (r: R) => r.role
const rows: R[] = [{ id: 'L1', state: 'working', role: 'leader' }, { id: 'W1', state: 'working', role: 'worker' }, { id: 'X', state: 'waiting' }, { id: 'L2', state: 'waiting', role: 'leader' }]

describe('leaders filter', () => {
  test('off leaves every row, on keeps only leaders (a row with no role is not one)', () => {
    expect(applyLeadersOnly(rows, false, roleOf).map(r => r.id)).toEqual(['L1', 'W1', 'X', 'L2'])
    expect(applyLeadersOnly(rows, true, roleOf).map(r => r.id)).toEqual(['L1', 'L2'])
  })
  test('the count and the words', () => {
    expect(countLeaders(rows, roleOf)).toBe(2)
    expect(leadersText(1, true)).toBe('1 líder')
    expect(leadersText(2, true)).toBe('2 líderes')
  })
  test('all live states count, while exited, closed and lost leaders never do', () => {
    const states = [...ACTIVE_STATES, 'exited', 'closed', 'lost']
    const fleet = states.map(state => ({ id: state, state, role: 'leader' as const }))
    expect(countLeaders(fleet, roleOf)).toBe(ACTIVE_STATES.length)
    expect(applyLeadersOnly(fleet, true, roleOf).map(r => r.state)).toEqual([...ACTIVE_STATES])
    expect(applyLeadersOnly(fleet, false, roleOf)).toEqual(fleet)
    expect(countLeaders([], roleOf)).toBe(0)
  })
  test('the count and selected rows use the same search and value filters', () => {
    const fleet = [
      { id: 'match', title: 'Release leader', state: 'working', harness: 'codex', project: 'app', repo: 'org/app', model: 'm1' },
      { id: 'ended', title: 'Release ended', state: 'exited', harness: 'codex', project: 'app', repo: 'org/app', model: 'm1' },
      { id: 'search', title: 'Other leader', state: 'waiting', harness: 'codex', project: 'app', repo: 'org/app', model: 'm1' },
      { id: 'harness', title: 'Release harness', state: 'working', harness: 'claude', project: 'app', repo: 'org/app', model: 'm1' },
      { id: 'project', title: 'Release project', state: 'working', harness: 'codex', project: 'other', repo: 'org/app', model: 'm1' },
      { id: 'repo', title: 'Release repo', state: 'working', harness: 'codex', project: 'app', repo: 'org/other', model: 'm1' },
      { id: 'model', title: 'Release model', state: 'working', harness: 'codex', project: 'app', repo: 'org/app', model: 'm2' },
    ].map(r => ({ ...r, searchFields: { name: r.title, folder: '', harness: '', note: '', task: '', prompt: '' } })) as ControlSession[]
    const filters = { harnesses: ['codex'], projects: ['app'], repos: ['org/app'], models: ['m1'] } as Filters
    const searched = filterSessions(filterFleet({ rows: fleet, filters, activeOnly: false }).rows, 'Release')
    const leader = () => 'leader' as const
    expect(countLeaders(searched, leader)).toBe(1)
    expect(applyLeadersOnly(searched, true, leader).map(r => r.id)).toEqual(['match'])
    expect(countLeaders(filterSessions(searched, 'absent'), leader)).toBe(0)
  })
})

describe('persistence and counting', () => {
  test('leadersOnly defaults to false and parses tolerantly', () => {
    expect(DEFAULT_ASIDE_GROUP_PREFS.leadersOnly).toBe(false)
    expect(parseAsideGroupPrefs({ leadersOnly: true }).leadersOnly).toBe(true)
    expect(parseAsideGroupPrefs({ leadersOnly: 'yes' }).leadersOnly).toBe(false)
    expect(parseAsideGroupPrefs({}).leadersOnly).toBe(false)
    expect(parseAsideGroupPrefs('junk').leadersOnly).toBe(false)
  })
  test('it counts as a FILTER, never as an arrangement change', () => {
    const f = { projects: [] } as never
    expect(countActiveFilters(f, false)).toBe(0)
    expect(countActiveFilters(f, false, true)).toBe(1)
    expect(countActiveFilters(f, true, true)).toBe(2)
    const d = DEFAULT_ASIDE_GROUP_PREFS
    expect(arrangeChangedCount({ groupBy: d.groupBy, sort: d.sort, cardColor: d.cardColor, order: [], hiddenFolders: 0 })).toBe(0)
  })
})
