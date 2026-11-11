import { test, expect } from 'bun:test'
import { filtersToTagDraft, canCreateTagFromFilters } from './filtersToTag'
import type { Filters } from '@agentistics/core'

function baseFilters(over: Partial<Filters> = {}): Filters {
  return {
    dateRange: 'all', customStart: '', customEnd: '',
    projects: [], models: [],
    ...over,
  }
}

test('a single active dimension becomes sources, with no filters', () => {
  const draft = filtersToTagDraft(baseFilters({ projects: ['/home/me/app'] }))
  expect(draft.sources).toEqual([{ type: 'project', value: '/home/me/app' }])
  expect(draft.filters).toEqual([])
})

test('multiple values of one dimension all become sources (OR within the type)', () => {
  const draft = filtersToTagDraft(baseFilters({ projects: ['/a', '/b'] }))
  expect(draft.sources).toEqual([{ type: 'project', value: '/a' }, { type: 'project', value: '/b' }])
})

test('project leads over repo when both are active', () => {
  const draft = filtersToTagDraft(baseFilters({ projects: ['/a'], repos: ['github.com/o/r'] }))
  expect(draft.sources).toEqual([{ type: 'project', value: '/a' }])
  expect(draft.filters).toEqual([{ type: 'repo', value: 'github.com/o/r' }])
})

test('nothing is dropped: project + harness + model all survive, only one becomes sources', () => {
  const draft = filtersToTagDraft(baseFilters({
    projects: ['/a'], harnesses: ['codex'], models: ['claude-opus-4-8'],
  }))
  expect(draft.sources).toEqual([{ type: 'project', value: '/a' }])
  expect(draft.filters).toEqual([
    { type: 'harness', value: 'codex' },
    { type: 'model', value: 'claude-opus-4-8' },
  ])
})

test('with no project/repo, harness leads and model narrows', () => {
  const draft = filtersToTagDraft(baseFilters({ harnesses: ['codex'], models: ['claude-opus-4-8'] }))
  expect(draft.sources).toEqual([{ type: 'harness', value: 'codex' }])
  expect(draft.filters).toEqual([{ type: 'model', value: 'claude-opus-4-8' }])
})

test('the single-harness legacy field is used when the multi-select array is empty', () => {
  const draft = filtersToTagDraft(baseFilters({ harness: 'gemini' }))
  expect(draft.sources).toEqual([{ type: 'harness', value: 'gemini' }])
})

test('a date-only filter (nothing else active) maps to no sources — there is no tag to build', () => {
  const draft = filtersToTagDraft(baseFilters({ dateRange: '30d' }))
  expect(draft.sources).toEqual([])
  expect(canCreateTagFromFilters(baseFilters({ dateRange: '30d' }))).toBe(false)
})

test('canCreateTagFromFilters is true once anything mappable is active', () => {
  expect(canCreateTagFromFilters(baseFilters())).toBe(false)
  expect(canCreateTagFromFilters(baseFilters({ projects: ['/a'] }))).toBe(true)
})

// --- the period ----------------------------------------------------------------------------------

test('all-time with no custom dates maps to no window', () => {
  const draft = filtersToTagDraft(baseFilters({ projects: ['/a'] }))
  expect(draft.window).toBeUndefined()
})

test('a custom range is passed through as the literal yyyy-MM-dd strings', () => {
  const draft = filtersToTagDraft(
    baseFilters({ projects: ['/a'], dateRange: 'all', customStart: '2026-07-01', customEnd: '2026-07-31' }),
  )
  expect(draft.window).toEqual({ start: '2026-07-01', end: '2026-07-31' })
})

test('a one-sided custom range keeps only the side that was set', () => {
  const draft = filtersToTagDraft(
    baseFilters({ projects: ['/a'], dateRange: 'all', customStart: '2026-07-01', customEnd: '' }),
  )
  expect(draft.window).toEqual({ start: '2026-07-01' })
})

test('a preset range (7d/30d/90d) becomes an inclusive window ending today', () => {
  const draft = filtersToTagDraft(baseFilters({ projects: ['/a'], dateRange: '7d' }))
  expect(draft.window?.start).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(draft.window?.end).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(draft.window!.start! < draft.window!.end!).toBe(true)
})
