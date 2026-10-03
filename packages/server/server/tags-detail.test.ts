import { test, expect } from 'bun:test'
import { aggregateTagDetail } from './tags-detail'
import type { SessionMeta } from '@agentistics/core'

function s(over: Partial<SessionMeta>): SessionMeta {
  return {
    session_id: 'x', project_path: '/p', harness: 'claude',
    input_tokens: 100, output_tokens: 10,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    ...over,
  } as SessionMeta
}

test('empty input yields empty distributions and a null window', () => {
  const d = aggregateTagDetail([])
  expect(d.projects).toEqual([])
  expect(d.daily).toEqual([])
  expect(d.firstSessionDate).toBeNull()
  expect(d.lastSessionDate).toBeNull()
  expect(d.sessionsWithoutModel).toBe(0)
})

test('buckets count sessions and sum tokens per key', () => {
  const d = aggregateTagDetail([
    s({ project_path: '/a', model: 'claude-opus-4-6' }),
    s({ project_path: '/a', model: 'claude-opus-4-6' }),
    s({ project_path: '/b', model: 'claude-sonnet-4-6' }),
  ])
  const a = d.projects.find(p => p.key === '/a')!
  expect(a.sessions).toBe(2)
  expect(a.tokens).toBe(220)
  expect(d.projects.find(p => p.key === '/b')!.sessions).toBe(1)
  expect(d.models.map(m => m.key).sort()).toEqual(['claude-opus-4-6', 'claude-sonnet-4-6'])
})

test('buckets rank by cost, highest first', () => {
  const d = aggregateTagDetail([
    s({ project_path: '/cheap', output_tokens: 1, model: 'claude-opus-4-6' }),
    s({ project_path: '/pricey', output_tokens: 100000, model: 'claude-opus-4-6' }),
  ])
  expect(d.projects[0]!.key).toBe('/pricey')
})

test('repos, harnesses and members bucket only when the field is present', () => {
  const d = aggregateTagDetail([
    s({ git_remote: 'github.com/org/a', memberId: 'hash1', harness: 'claude' }),
    s({ memberId: 'hash1' }),               // no repo
    s({ git_remote: 'github.com/org/a' }),  // no member
  ])
  expect(d.repos).toHaveLength(1)
  expect(d.repos[0]!.sessions).toBe(2)
  expect(d.members).toHaveLength(1)
  expect(d.members[0]!.sessions).toBe(2)
})

test('daily series is sorted and the window spans first to last active day', () => {
  const d = aggregateTagDetail([
    s({ start_time: '2026-03-05T10:00:00Z' }),
    s({ start_time: '2026-01-02T10:00:00Z' }),
    s({ start_time: '2026-03-05T18:00:00Z' }),
  ])
  expect(d.daily.map(p => p.date)).toEqual(['2026-01-02', '2026-03-05'])
  expect(d.daily[1]!.sessions).toBe(2)
  expect(d.firstSessionDate).toBe('2026-01-02')
  expect(d.lastSessionDate).toBe('2026-03-05')
})

test('sessions without a model are counted separately, not dropped from totals', () => {
  const d = aggregateTagDetail([s({ model: 'claude-opus-4-6' }), s({}), s({})])
  expect(d.sessionsWithoutModel).toBe(2)
  expect(d.models).toHaveLength(1)
  // They still contribute to the project bucket — only the model attribution is missing.
  expect(d.projects[0]!.sessions).toBe(3)
})

test('a malformed start_time does not create a bogus day bucket', () => {
  const d = aggregateTagDetail([s({ start_time: 'not-a-date' })])
  expect(d.daily).toEqual([])
  expect(d.firstSessionDate).toBeNull()
})

test('counts distinct members and machines, not sessions', () => {
  const d = aggregateTagDetail([
    s({ user: 'vini', memberId: 'machA' }),
    s({ user: 'vini', memberId: 'machA' }),   // same person, same machine
    s({ user: 'vini', memberId: 'machB' }),   // same person, second machine
    s({ user: 'bryan', memberId: 'machC' }),
    s({}),                                     // neither → counted in neither set
  ])
  expect(d.distinctMembers).toBe(2)
  expect(d.distinctMachines).toBe(3)
})

test('an empty tag reports zero members and machines', () => {
  const d = aggregateTagDetail([])
  expect(d.distinctMembers).toBe(0)
  expect(d.distinctMachines).toBe(0)
})

test('users rank people, not machines — one person on two machines is a single row', () => {
  const d = aggregateTagDetail([
    s({ user: 'vini', memberId: 'machA' }),
    s({ user: 'vini', memberId: 'machB' }),
    s({ user: 'bryan', memberId: 'machC' }),
  ])
  expect(d.users.map(u => u.key).sort()).toEqual(['bryan', 'vini'])
  expect(d.users.find(u => u.key === 'vini')!.sessions).toBe(2)
  // The machine ranking still has three rows — the two views answer different questions.
  expect(d.members).toHaveLength(3)
})
