import { describe, expect, test } from 'bun:test'
import { applyLeadersOnly, countLeaders, leadersBanner, leadersText } from './leadersFilter'
import { arrangeChangedCount, DEFAULT_ASIDE_GROUP_PREFS, parseAsideGroupPrefs } from './sessionsAsidePrefs'
import { countActiveFilters } from './activeFilterCount'
import { resolvePinnedRows } from './pinnedSessions'
import { folderFold } from './folderFold'
import { folderSessionCount } from './sessionUserGroups'
import type { SessionRole } from './sessionRoles'

type R = { id: string; role?: SessionRole }
const roleOf = (r: R) => r.role
const rows: R[] = [{ id: 'L1', role: 'leader' }, { id: 'W1', role: 'worker' }, { id: 'X' }, { id: 'L2', role: 'leader' }]

describe('leaders filter', () => {
  test('off leaves every row, on keeps only leaders (a row with no role is not one)', () => {
    expect(applyLeadersOnly(rows, false, roleOf).map(r => r.id)).toEqual(['L1', 'W1', 'X', 'L2'])
    expect(applyLeadersOnly(rows, true, roleOf).map(r => r.id)).toEqual(['L1', 'L2'])
  })
  test('the count and the words', () => {
    expect(countLeaders(rows, roleOf)).toBe(2)
    expect(leadersText(1, true)).toBe('1 líder')
    expect(leadersText(2, true)).toBe('2 líderes')
    expect(leadersBanner(3, true)).toBe('Mostrando só líderes · 3 sessões ocultas')
    expect(leadersBanner(1, false)).toBe('Showing leaders only · 1 session hidden')
  })
  test('the pinned band is resolved from the unfiltered rows, so a pinned worker stays', () => {
    const shown = applyLeadersOnly(rows, true, roleOf)
    expect(resolvePinnedRows(['W1'], rows, r => r.id).map(r => r.id)).toEqual(['W1'])
    expect(shown.some(r => r.id === 'W1')).toBe(false)
  })
  test('a folder with no leader left keeps its place, dimmed and not removed — the search rule', () => {
    const groups = [
      { group: { id: 'g1', name: 'Líderes', sessionKeys: ['L1'] }, rows: [{ id: 'L1' }] },
      { group: { id: 'g2', name: 'Workers', sessionKeys: ['W1'] }, rows: [{ id: 'W1' }] },
    ]
    const keep = new Set(applyLeadersOnly(rows, true, roleOf).map(r => r.id))
    const shown = groups.map(e => ({ ...e, rows: e.rows.filter(r => keep.has(r.id)) }))
    expect(shown).toHaveLength(2)
    const n1 = folderSessionCount('g1', shown as never)
    const n2 = folderSessionCount('g2', shown as never)
    const fold = (n: number) => folderFold({ storedFolded: false, openedDimmed: false, narrowing: true, searching: false, shownCount: n })
    expect([n1, n2]).toEqual([1, 0])
    expect(fold(n1).dimmed).toBe(false)
    expect(fold(n2).dimmed).toBe(true)
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
