import { describe, test, expect } from 'bun:test'
import type { Filters } from '@agentistics/core'
import { countActiveFilters } from './activeFilterCount'

function emptyFilters(): Filters {
  return { dateRange: 'all', customStart: '', customEnd: '', projects: [], models: [] }
}

describe('countActiveFilters', () => {
  test('nothing active → 0', () => {
    expect(countActiveFilters(emptyFilters(), false)).toBe(0)
  })

  test('date range alone does NOT count — it is not a "+ Filtro" dimension', () => {
    const f: Filters = { ...emptyFilters(), dateRange: '7d' }
    expect(countActiveFilters(f, false)).toBe(0)
  })

  test('one dimension → 1', () => {
    expect(countActiveFilters({ ...emptyFilters(), projects: ['/a'] }, false)).toBe(1)
    expect(countActiveFilters({ ...emptyFilters(), models: ['claude-sonnet-5'] }, false)).toBe(1)
    expect(countActiveFilters({ ...emptyFilters(), harnesses: ['claude'] }, false)).toBe(1)
    expect(countActiveFilters({ ...emptyFilters(), repos: ['github.com/a/b'] }, false)).toBe(1)
    expect(countActiveFilters({ ...emptyFilters(), tags: ['t1'] }, false)).toBe(1)
    expect(countActiveFilters({ ...emptyFilters(), users: ['u1'] }, false)).toBe(1)
    expect(countActiveFilters({ ...emptyFilters(), teams: ['t1'] }, false)).toBe(1)
    expect(countActiveFilters({ ...emptyFilters(), machines: ['m1'] }, false)).toBe(1)
    expect(countActiveFilters({ ...emptyFilters(), presence: 'online' }, false)).toBe(1)
  })

  test('activeOnly counts as its own dimension', () => {
    expect(countActiveFilters(emptyFilters(), true)).toBe(1)
  })

  test('several dimensions at once sum', () => {
    const f: Filters = {
      ...emptyFilters(),
      projects: ['/a'],
      models: ['claude-sonnet-5'],
      harnesses: ['claude', 'codex'],
    }
    expect(countActiveFilters(f, true)).toBe(4)
  })

  test('an empty array is not an active dimension', () => {
    const f: Filters = { ...emptyFilters(), projects: [], models: [], harnesses: [], repos: [], tags: [], users: [], teams: [], machines: [] }
    expect(countActiveFilters(f, false)).toBe(0)
  })
})
