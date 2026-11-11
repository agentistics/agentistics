import { test, expect } from 'bun:test'
import { sessionMatchesTag, resolveTagSessions, type TagSource } from './tags-resolve'
import type { SessionMeta } from '@agentistics/core'

function s(over: Partial<SessionMeta>): SessionMeta {
  return {
    session_id: 'x', project_path: '/p', harness: 'claude',
    ...over,
  } as SessionMeta
}

test('repo and project sources match their session fields', () => {
  const src: TagSource[] = [{ type: 'repo', value: 'github.com/org/a' }]
  expect(sessionMatchesTag(s({ git_remote: 'github.com/org/a' }), src)).toBe(true)
  expect(sessionMatchesTag(s({ git_remote: 'github.com/org/b' }), src)).toBe(false)
  expect(sessionMatchesTag(s({}), src)).toBe(false)

  const proj: TagSource[] = [{ type: 'project', value: '/home/me/app' }]
  expect(sessionMatchesTag(s({ project_path: '/home/me/app' }), proj)).toBe(true)
  expect(sessionMatchesTag(s({ project_path: '/home/me/other' }), proj)).toBe(false)
})

test('machine matches memberId', () => {
  const mach: TagSource[] = [{ type: 'machine', value: 'hash1' }]
  expect(sessionMatchesTag(s({ memberId: 'hash1' }), mach)).toBe(true)
  expect(sessionMatchesTag(s({ memberId: 'hash2' }), mach)).toBe(false)
})

test('harness matches session.harness, defaulting to claude for legacy sessions with none', () => {
  const src: TagSource[] = [{ type: 'harness', value: 'codex' }]
  expect(sessionMatchesTag(s({ harness: 'codex' }), src)).toBe(true)
  expect(sessionMatchesTag(s({ harness: 'claude' }), src)).toBe(false)
  const claudeSrc: TagSource[] = [{ type: 'harness', value: 'claude' }]
  expect(sessionMatchesTag(s({ harness: undefined }), claudeSrc)).toBe(true)
})

test('model matches session.model exactly; a session with no model matches nothing', () => {
  const src: TagSource[] = [{ type: 'model', value: 'claude-opus-4-8' }]
  expect(sessionMatchesTag(s({ model: 'claude-opus-4-8' }), src)).toBe(true)
  expect(sessionMatchesTag(s({ model: 'claude-sonnet-4-6' }), src)).toBe(false)
  expect(sessionMatchesTag(s({}), src)).toBe(false)
})

test('sources are an OR union and a session matching two sources is returned ONCE', () => {
  const sessions = [
    s({ session_id: '1', git_remote: 'github.com/org/a', memberId: 'hash1' }), // matches both
    s({ session_id: '2', git_remote: 'github.com/org/a' }),
    s({ session_id: '3', memberId: 'hash9' }),
  ]
  const sources: TagSource[] = [
    { type: 'repo', value: 'github.com/org/a' },
    { type: 'machine', value: 'hash1' },
  ]
  const out = resolveTagSessions(sessions, sources)
  expect(out.map(x => x.session_id)).toEqual(['1', '2'])
})

test('a tag with no sources resolves to no sessions', () => {
  expect(resolveTagSessions([s({ git_remote: 'r' })], [])).toEqual([])
})

// --- filters: narrow the union, never widen it --------------------------------------------------

function sess(over: Partial<SessionMeta>): SessionMeta {
  return { session_id: 'x', project_path: '', harness: 'claude', ...over } as SessionMeta
}

test('filters of one type are an OR', () => {
  const sessions = [
    sess({ session_id: 'a', git_remote: 'host/o/r', project_path: '/c' }),
    sess({ session_id: 'b', git_remote: 'host/o/r', project_path: '/d' }),
    sess({ session_id: 'e', git_remote: 'host/o/r', project_path: '/other' }),
  ]
  const out = resolveTagSessions(sessions, [{ type: 'repo', value: 'host/o/r' }],
    [{ type: 'project', value: '/c' }, { type: 'project', value: '/d' }])
  expect(out.map(s => s.session_id)).toEqual(['a', 'b'])
})

test('filters of different types are an AND', () => {
  // "only machine m1, and only in /c" — a session must satisfy both to survive.
  const sessions = [
    sess({ session_id: 'both', git_remote: 'host/o/r', project_path: '/c', memberId: 'm1' }),
    sess({ session_id: 'wrong-path', git_remote: 'host/o/r', project_path: '/z', memberId: 'm1' }),
    sess({ session_id: 'wrong-machine', git_remote: 'host/o/r', project_path: '/c', memberId: 'm2' }),
  ]
  const out = resolveTagSessions(sessions, [{ type: 'repo', value: 'host/o/r' }],
    [{ type: 'machine', value: 'm1' }, { type: 'project', value: '/c' }])
  expect(out.map(s => s.session_id)).toEqual(['both'])
})

test('a filter can only remove sessions, never add one outside the union', () => {
  const sessions = [
    sess({ session_id: 'in', git_remote: 'host/o/r', project_path: '/c' }),
    sess({ session_id: 'out', git_remote: 'host/o/other', project_path: '/c' }),
  ]
  // /c also names a session of a repo that is NOT a source; it must stay out.
  const out = resolveTagSessions(sessions, [{ type: 'repo', value: 'host/o/r' }],
    [{ type: 'project', value: '/c' }])
  expect(out.map(s => s.session_id)).toEqual(['in'])
})

test('no filters means no constraint', () => {
  const sessions = [sess({ session_id: 'a', git_remote: 'host/o/r' })]
  expect(resolveTagSessions(sessions, [{ type: 'repo', value: 'host/o/r' }], []).length).toBe(1)
  expect(resolveTagSessions(sessions, [{ type: 'repo', value: 'host/o/r' }], ).length).toBe(1)
})

test('an untouched type places no constraint even when other types are filtered', () => {
  const sessions = [sess({ session_id: 'a', git_remote: 'host/o/r', project_path: '/c', memberId: 'm9' })]
  // Filtering only on project must not require a machine filter to match too.
  const out = resolveTagSessions(sessions, [{ type: 'repo', value: 'host/o/r' }],
    [{ type: 'project', value: '/c' }])
  expect(out.length).toBe(1)
})

// --- the tag's period -------------------------------------------------------------------------

import { sessionInWindow, tagSessionDay, type TagWindow } from './tags-resolve'

const repoSrc: TagSource[] = [{ type: 'repo', value: 'github.com/org/a' }]
const inRepo = (day?: string) =>
  s({ git_remote: 'github.com/org/a', ...(day ? { start_time: `${day}T12:00:00.000Z` } : {}) })

test('sessionInWindow: absent or empty window accepts everything', () => {
  expect(sessionInWindow(inRepo('2026-07-04'))).toBe(true)
  expect(sessionInWindow(inRepo('2026-07-04'), {})).toBe(true)
  // A session with no date passes only because there is no period to fail.
  expect(sessionInWindow(inRepo())).toBe(true)
})

test('sessionInWindow: both ends are INCLUSIVE', () => {
  const w: TagWindow = { start: '2026-07-04', end: '2026-07-18' }
  expect(sessionInWindow(inRepo('2026-07-03'), w)).toBe(false)
  expect(sessionInWindow(inRepo('2026-07-04'), w)).toBe(true)   // first day counts
  expect(sessionInWindow(inRepo('2026-07-11'), w)).toBe(true)
  expect(sessionInWindow(inRepo('2026-07-18'), w)).toBe(true)   // last day counts
  expect(sessionInWindow(inRepo('2026-07-19'), w)).toBe(false)
})

test('sessionInWindow: each end is independently optional', () => {
  expect(sessionInWindow(inRepo('2026-07-03'), { start: '2026-07-04' })).toBe(false)
  expect(sessionInWindow(inRepo('2026-09-01'), { start: '2026-07-04' })).toBe(true)
  expect(sessionInWindow(inRepo('2026-01-01'), { end: '2026-07-18' })).toBe(true)
  expect(sessionInWindow(inRepo('2026-07-19'), { end: '2026-07-18' })).toBe(false)
})

test('sessionInWindow: an undated session belongs to NO period', () => {
  // The alternative — admitting it — would place it in every window at once, so a frozen cost
  // would silently include sessions nobody can date.
  expect(sessionInWindow(inRepo(), { start: '2026-07-04' })).toBe(false)
  expect(sessionInWindow(inRepo(), { end: '2026-07-18' })).toBe(false)
  expect(sessionInWindow(s({ git_remote: 'x', start_time: 'garbage' }), { start: '2026-07-04' })).toBe(false)
})

test('tagSessionDay reads the leading day, matching tags-detail rather than the local clock', () => {
  expect(tagSessionDay(s({ start_time: '2026-07-04T23:30:00.000Z' }))).toBe('2026-07-04')
  expect(tagSessionDay(s({}))).toBeNull()
  expect(tagSessionDay(s({ start_time: 'nope' }))).toBeNull()
})

test('the period is an AND over the source union, never a way to widen it', () => {
  const w: TagWindow = { start: '2026-07-04', end: '2026-07-18' }
  // Right source, wrong period.
  expect(sessionMatchesTag(inRepo('2026-08-01'), repoSrc, [], w)).toBe(false)
  // Right period, wrong source — the window cannot pull in what the sources never covered.
  expect(sessionMatchesTag(
    s({ git_remote: 'github.com/org/other', start_time: '2026-07-10T00:00:00Z' }),
    repoSrc, [], w,
  )).toBe(false)
  expect(sessionMatchesTag(inRepo('2026-07-10'), repoSrc, [], w)).toBe(true)
})

test('resolveTagSessions narrows to the period, and composes with filters', () => {
  const sessions = [
    s({ git_remote: 'github.com/org/a', project_path: '/keep', start_time: '2026-07-01T00:00:00Z' }),
    s({ git_remote: 'github.com/org/a', project_path: '/keep', start_time: '2026-07-10T00:00:00Z' }),
    s({ git_remote: 'github.com/org/a', project_path: '/drop', start_time: '2026-07-10T00:00:00Z' }),
    s({ git_remote: 'github.com/org/a', project_path: '/keep', start_time: '2026-08-01T00:00:00Z' }),
  ]
  const w: TagWindow = { start: '2026-07-04', end: '2026-07-18' }
  expect(resolveTagSessions(sessions, repoSrc, [], w)).toHaveLength(2)
  expect(resolveTagSessions(sessions, repoSrc, [{ type: 'project', value: '/keep' }], w))
    .toHaveLength(1)
  // Without the period the same tag is the whole history — that is the number it must differ from.
  expect(resolveTagSessions(sessions, repoSrc)).toHaveLength(4)
})
