import { expect, it } from 'bun:test'
import { applyDataPatch, planDataPatch } from './dataPatch'
it('roundtrips changed sessions, order, removals and top-level sections', () => {
  const previous = { sessions: [{ session_id: 'a', harness: 'codex', text: 'old' }, { session_id: 'gone', harness: 'kimi' }], projects: [], partial: true }
  const next = { sessions: [{ session_id: 'b', harness: 'gemini' }, { session_id: 'a', harness: 'codex', text: 'new' }], projects: [{ path: '/p' }] }
  const patch = planDataPatch(previous, next, 'v1', 'v2')
  expect(applyDataPatch<object>(previous, 'v1', patch)).toEqual(next)
  expect(previous.sessions[0]?.text).toBe('old')
  expect(applyDataPatch(previous, 'wrong', patch)).toBeNull()
})
it('keeps harnesses and machines with the same session id separate', () => {
  const previous = { sessions: [{ session_id: 'a', harness: 'codex', memberId: '1' }, { session_id: 'a', harness: 'kimi' }] }
  const next = { sessions: [previous.sessions[1]!] }
  expect(applyDataPatch(previous, 'a', planDataPatch(previous, next, 'a', 'b'))).toEqual(next)
})
it('preserves live fields outside the build and recovers after an unknown row', () => {
  const patch = planDataPatch({ sessions: [] }, { sessions: [] }, 'a', 'b')
  expect(applyDataPatch({ sessions: [], liveSessionIds: ['live'] }, 'a', patch)).toEqual({ sessions: [], liveSessionIds: ['live'] })
  expect(applyDataPatch({ sessions: [] }, 'a', { ...patch, sessions: { upsert: [], remove: [], order: ['unknown'] } })).toBeNull()
})
