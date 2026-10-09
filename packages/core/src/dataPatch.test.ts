import { expect, it } from 'bun:test'
import { applyDataPatch, planDataPatch, type DataPatch } from './dataPatch'
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
it('rejects malformed patch sections and ignores prototype fields', () => {
  const previous = { sessions: [] }
  for (const patch of [null, { base: 'a', revision: 1, set: {}, remove: [] }, { base: 'a', revision: 'b', set: [], remove: [] }, { base: 'a', revision: 'b', set: {}, remove: [], sessions: {} }]) {
    expect(applyDataPatch(previous, 'a', patch as unknown as DataPatch)).toBeNull()
  }
  const patch = JSON.parse('{"base":"a","revision":"b","set":{"__proto__":{"polluted":true},"constructor":1},"remove":[]}')
  expect(applyDataPatch(previous, 'a', patch)).toEqual(previous)
  expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
})
for (const harness of ['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi', 'opencode', 'agentistics']) {
  it(`patches ${harness} facts without dropping its peers or another machine`, () => {
    const peer = { session_id: 'same', harness, memberId: 'other', user: 'peer' }
    const old = { sessions: [{ session_id: 'same', harness, total_cost: 1 }, peer] }
    const next = { sessions: [peer, { session_id: 'same', harness, total_cost: 2 }] }
    expect(applyDataPatch(old, 'a', planDataPatch(old, next, 'a', 'b'))).toEqual(next)
  })
}
