import { test, expect } from 'bun:test'
import {
  sessionMatchesTagSources, selectedTagSources, makeTagFilter,
  type TagDef, type TagSource,
} from './tagMatch'
import type { SessionMeta } from '@agentistics/core'

function s(over: Partial<SessionMeta>): SessionMeta {
  return {
    session_id: 'x', project_path: '/p', harness: 'claude',
    ...over,
  } as SessionMeta
}


function tag(id: string, sources: TagSource[]): TagDef {
  return { _id: id, name: id, sources }
}

test('repo and project sources match their session fields', () => {
  const repo: TagSource[] = [{ type: 'repo', value: 'github.com/org/a' }]
  expect(sessionMatchesTagSources(s({ git_remote: 'github.com/org/a' }), repo)).toBe(true)
  expect(sessionMatchesTagSources(s({ git_remote: 'github.com/org/b' }), repo)).toBe(false)
  expect(sessionMatchesTagSources(s({}), repo)).toBe(false)

  const proj: TagSource[] = [{ type: 'project', value: '/home/me/app' }]
  expect(sessionMatchesTagSources(s({ project_path: '/home/me/app' }), proj)).toBe(true)
  expect(sessionMatchesTagSources(s({ project_path: '/home/me/other' }), proj)).toBe(false)
})

test('harness matches session.harness, defaulting to claude for legacy sessions with none', () => {
  const src: TagSource[] = [{ type: 'harness', value: 'codex' }]
  expect(sessionMatchesTagSources(s({ harness: 'codex' }), src)).toBe(true)
  expect(sessionMatchesTagSources(s({ harness: 'claude' }), src)).toBe(false)
  const claudeSrc: TagSource[] = [{ type: 'harness', value: 'claude' }]
  expect(sessionMatchesTagSources(s({ harness: undefined }), claudeSrc)).toBe(true)
})

test('model matches session.model exactly; a session with no model matches nothing', () => {
  const src: TagSource[] = [{ type: 'model', value: 'claude-opus-4-8' }]
  expect(sessionMatchesTagSources(s({ model: 'claude-opus-4-8' }), src)).toBe(true)
  expect(sessionMatchesTagSources(s({ model: 'claude-sonnet-4-6' }), src)).toBe(false)
  expect(sessionMatchesTagSources(s({}), src)).toBe(false)
})

test('sources are an OR union', () => {
  const sources: TagSource[] = [
    { type: 'repo', value: 'github.com/org/a' },
    { type: 'machine', value: 'hash1' },
  ]
  expect(sessionMatchesTagSources(s({ git_remote: 'github.com/org/a' }), sources)).toBe(true)
  expect(sessionMatchesTagSources(s({ memberId: 'hash1' }), sources)).toBe(true)
  expect(sessionMatchesTagSources(s({ memberId: 'hash9' }), sources)).toBe(false)
})

test('selectedTagSources flattens only the selected tags and ignores unknown ids', () => {
  const tags = [
    tag('t1', [{ type: 'repo', value: 'r1' }]),
    tag('t2', [{ type: 'repo', value: 'github.com/org/t2' }, { type: 'project', value: '/p2' }]),
  ]
  expect(selectedTagSources(['t2'], tags)).toEqual([
    { type: 'repo', value: 'github.com/org/t2' }, { type: 'project', value: '/p2' },
  ])
  expect(selectedTagSources(['t1', 'ghost'], tags)).toEqual([{ type: 'repo', value: 'r1' }])
  expect(selectedTagSources([], tags)).toEqual([])
})

test('makeTagFilter is inert (null) when nothing selectable resolves', () => {
  const tags = [tag('t1', [{ type: 'repo', value: 'r1' }])]
  expect(makeTagFilter([], tags)).toBeNull()
  expect(makeTagFilter(['ghost'], tags)).toBeNull()
  // A selected tag with no sources cannot narrow anything either.
  expect(makeTagFilter(['empty'], [tag('empty', [])])).toBeNull()
})

test('makeTagFilter keeps sessions matching ANY source of ANY selected tag', () => {
  const tags = [
    tag('t1', [{ type: 'repo', value: 'github.com/org/a' }]),
    tag('t2', [{ type: 'machine', value: 'hash1' }]),
  ]
  const keep = makeTagFilter(['t1', 't2'], tags)!
  const sessions = [
    s({ session_id: '1', git_remote: 'github.com/org/a' }),
    s({ session_id: '2', memberId: 'hash1' }),
    s({ session_id: '3', memberId: 'hash9' }),
  ]
  expect(sessions.filter(keep).map(x => x.session_id)).toEqual(['1', '2'])
})

// --- the tag's period, and agreement with the server copy --------------------------------------

import { sessionInTagWindow, type TagWindow } from './tagMatch'
import { sessionInWindow, sessionMatchesTag } from '../../../server/server/tags-resolve'

const dated = (day: string, over: Partial<SessionMeta> = {}) =>
  s({ start_time: `${day}T12:00:00.000Z`, ...over })

function windowed(id: string, sources: TagSource[], window?: TagWindow): TagDef {
  return { _id: id, name: id, sources, ...(window ? { window } : {}) }
}

test('sessionInTagWindow: inclusive both ends, each side optional, undated belongs nowhere', () => {
  const w: TagWindow = { start: '2026-07-04', end: '2026-07-18' }
  expect(sessionInTagWindow(dated('2026-07-03'), w)).toBe(false)
  expect(sessionInTagWindow(dated('2026-07-04'), w)).toBe(true)
  expect(sessionInTagWindow(dated('2026-07-18'), w)).toBe(true)
  expect(sessionInTagWindow(dated('2026-07-19'), w)).toBe(false)
  expect(sessionInTagWindow(dated('2026-07-19'), { start: '2026-07-04' })).toBe(true)
  expect(sessionInTagWindow(dated('2026-07-03'), { end: '2026-07-18' })).toBe(true)
  expect(sessionInTagWindow(dated('2026-07-10'))).toBe(true)
  expect(sessionInTagWindow(s({}), w)).toBe(false)
})

test('makeTagFilter applies EACH tag its own period, not one flattened union', () => {
  // Two tags over the same repo, different months. A session in July belongs to the July tag only,
  // and flattening the sources first would have let the August tag admit it.
  const july = windowed('july', [{ type: 'repo', value: 'r1' }], { start: '2026-07-01', end: '2026-07-31' })
  const august = windowed('aug', [{ type: 'repo', value: 'r1' }], { start: '2026-08-01', end: '2026-08-31' })

  const inJuly = dated('2026-07-10', { git_remote: 'r1' })
  const inAugust = dated('2026-08-10', { git_remote: 'r1' })
  const inSeptember = dated('2026-09-10', { git_remote: 'r1' })

  const onlyJuly = makeTagFilter(['july'], [july, august])!
  expect(onlyJuly(inJuly)).toBe(true)
  expect(onlyJuly(inAugust)).toBe(false)

  // Selecting both is a union of the two periods — and still excludes what neither covers.
  const both = makeTagFilter(['july', 'aug'], [july, august])!
  expect(both(inJuly)).toBe(true)
  expect(both(inAugust)).toBe(true)
  expect(both(inSeptember)).toBe(false)
})

test('makeTagFilter: a tag with no period still covers everything from its sources', () => {
  const allTime = windowed('all', [{ type: 'repo', value: 'r1' }])
  const keep = makeTagFilter(['all'], [allTime])!
  expect(keep(dated('2020-01-01', { git_remote: 'r1' }))).toBe(true)
  expect(keep(s({ git_remote: 'r1' }))).toBe(true)          // undated: no period to fail
  expect(keep(dated('2026-07-10', { git_remote: 'other' }))).toBe(false)
})

test('the browser mirror and the server resolver agree, session for session', () => {
  // The two copies are hand-kept in sync (the web bundle cannot import from packages/server at
  // runtime). This is the test that fails when only one of them is updated.
  const w: TagWindow = { start: '2026-07-04', end: '2026-07-18' }
  const sources: TagSource[] = [
    { type: 'repo', value: 'r1' }, { type: 'machine', value: 'm1' },
    { type: 'harness', value: 'codex' }, { type: 'model', value: 'claude-opus-4-8' },
  ]
  const tagDef = windowed('t', sources, w)
  const filter = makeTagFilter(['t'], [tagDef])!

  const corpus: SessionMeta[] = [
    dated('2026-07-03', { git_remote: 'r1' }),
    dated('2026-07-04', { git_remote: 'r1' }),
    dated('2026-07-18', { memberId: 'm1' }),
    dated('2026-07-19', { memberId: 'm1' }),
    dated('2026-07-10', { git_remote: 'other' }),
    dated('2026-07-10', { git_remote: 'other', harness: 'codex' }),
    dated('2026-07-10', { git_remote: 'other', model: 'claude-opus-4-8' }),
    dated('2026-07-10', { git_remote: 'other', harness: 'gemini' }),
    s({ git_remote: 'r1' }),
    s({ git_remote: 'r1', start_time: 'garbage' }),
  ]
  for (const session of corpus) {
    expect(filter(session)).toBe(sessionMatchesTag(session, sources, [], w))
    expect(sessionInTagWindow(session, w)).toBe(sessionInWindow(session, w))
  }
})
