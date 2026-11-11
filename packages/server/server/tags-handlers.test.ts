import { test, expect } from 'bun:test'
import { stampLocalMachine, LOCAL_MACHINE_ID } from './tags-handlers'
import { resolveTagSessions, type TagSource } from './tags-resolve'
import type { SessionMeta } from '@agentistics/core'

// tags-handlers: there is exactly ONE machine, and `machine:local` is the only machine source the
// UI offers. Pure input → output, so no fs is involved.

function s(over: Partial<SessionMeta>): SessionMeta {
  return { session_id: 'x', project_path: '/p', harness: 'claude', ...over } as SessionMeta
}

const machineLocal: TagSource[] = [{ type: 'machine', value: LOCAL_MACHINE_ID }]

// Regression: the stamp used to be conditional (`s.memberId ? s : {...s, memberId: local}`), so a
// session revived from ~/.agentistics/sessions that still carried another machine's memberId was
// silently excluded from the tag.
test('every local session is attributed to the single local machine, even a pre-stamped one', () => {
  const sessions = [
    s({ session_id: 'fresh' }),
    s({ session_id: 'revived', memberId: 'a9f3oldmachinehash' }),
    s({ session_id: 'other-machine', memberId: 'deadbeefhash' }),
  ]
  const stamped = stampLocalMachine(sessions)
  expect(stamped.map(x => x.memberId)).toEqual([LOCAL_MACHINE_ID, LOCAL_MACHINE_ID, LOCAL_MACHINE_ID])

  // What actually broke: resolution against the only machine source solo mode offers.
  const matched = resolveTagSessions(stamped, machineLocal)
  expect(matched.map(x => x.session_id).sort()).toEqual(['fresh', 'other-machine', 'revived'])
})

test('stamping copies — the sessions /api/data serves are never mutated', () => {
  const original = s({ session_id: 'revived', memberId: 'a9f3oldmachinehash' })
  const [copy] = stampLocalMachine([original])
  expect(original.memberId).toBe('a9f3oldmachinehash')
  expect(copy).not.toBe(original)
  expect(copy!.memberId).toBe(LOCAL_MACHINE_ID)
  expect(copy!.project_path).toBe(original.project_path)
})

// --- the tag's period: what the API accepts ----------------------------------------------------

import { parseWindow } from './tags-handlers'

test('parseWindow distinguishes absent, cleared and set', () => {
  // Absent = leave whatever is stored alone; null = the caller explicitly removed the period.
  expect(parseWindow(undefined)).toEqual({ ok: true, value: undefined })
  expect(parseWindow(null)).toEqual({ ok: true, value: null })
  // Blank ends are how the UI drops one side without sending a different body shape; with both
  // blank there is no period left, which must collapse to null rather than a `{}` that reads as one.
  expect(parseWindow({})).toEqual({ ok: true, value: null })
  expect(parseWindow({ start: '', end: '' })).toEqual({ ok: true, value: null })
  expect(parseWindow({ start: '2026-07-04', end: '' })).toEqual({ ok: true, value: { start: '2026-07-04' } })
  expect(parseWindow({ end: '2026-07-18' })).toEqual({ ok: true, value: { end: '2026-07-18' } })
  expect(parseWindow({ start: '2026-07-04', end: '2026-07-18' }))
    .toEqual({ ok: true, value: { start: '2026-07-04', end: '2026-07-18' } })
})

test('parseWindow rejects a day that is not a real calendar day', () => {
  // The regex alone accepts this; `new Date` then rolls it to 3 March, silently widening the
  // period by up to three days against what was written.
  expect(parseWindow({ start: '2026-02-31' }).ok).toBe(false)
  expect(parseWindow({ start: '2026-13-01' }).ok).toBe(false)
  expect(parseWindow({ start: '04/07/2026' }).ok).toBe(false)
  expect(parseWindow({ start: '2026-7-4' }).ok).toBe(false)
  expect(parseWindow({ start: 20260704 }).ok).toBe(false)
  expect(parseWindow('2026-07-04').ok).toBe(false)
  expect(parseWindow(['2026-07-04']).ok).toBe(false)
  // A leap day that DOES exist must survive the same check.
  expect(parseWindow({ start: '2028-02-29' })).toEqual({ ok: true, value: { start: '2028-02-29' } })
})

test('parseWindow rejects an inverted period', () => {
  expect(parseWindow({ start: '2026-07-18', end: '2026-07-04' }).ok).toBe(false)
  // Same day at both ends is a one-day period, not an error.
  expect(parseWindow({ start: '2026-07-04', end: '2026-07-04' }).ok).toBe(true)
})
