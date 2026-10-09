import { describe, expect, it } from 'bun:test'
import { applyFleetWire, expandFleetView } from './fleetStream'
const snapshot = { seq: 1, sessions: [{ id: 'a', state: 'working' }, { id: 'closed:old' }], rows: [{ id: 'a' }, { id: 'closed:old' }], unavailable: 'old', attention: 1 }
describe('fleet push reducer', () => {
  it('upserts, removes, reorders and deletes absent metadata without mutating the frame', () => {
    const held = applyFleetWire(null, 'snapshot', snapshot)
    const next = applyFleetWire(held, 'delta', { seq: 2, upsert: { sessions: [{ id: 'b' }], rows: [{ id: 'b' }] }, remove: ['a'], order: ['b'], meta: { unavailable: null, attention: 0 } })
    expect(next.sessions.map(s => s.id)).toEqual(['b', 'closed:old'])
    expect(next.rows.map(s => s.id)).toEqual(['b', 'closed:old'])
    expect(next.unavailable).toBeUndefined()
    expect(snapshot.unavailable).toBe('old')
  })
  it('requires a new snapshot after a missing delta or a reconnect', () => {
    expect(() => applyFleetWire(null, 'delta', { seq: 2 })).toThrow()
    expect(() => applyFleetWire(snapshot, 'delta', { seq: 3 })).toThrow()
    expect(applyFleetWire(snapshot, 'snapshot', { ...snapshot, seq: 1 })).toEqual(snapshot)
  })
  it('expands compact groups from the rows already held', () => {
    const expanded = expandFleetView({ ...snapshot, view: { groups: [{ key: 'g', ids: ['a', 'missing'] }] } })
    expect(expanded.view).toEqual({ groups: [{ key: 'g', rows: [{ id: 'a', state: 'working' }] }] })
  })
  for (const harness of ['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi', 'opencode', 'agentistics']) {
    it(`preserves ${harness} row facts without interpreting them`, () => {
      const row = { id: harness, harness, state: 'waiting-approval', actionable: false, reason: 'harness says so' }
      const next = applyFleetWire(snapshot, 'delta', { seq: 2, upsert: { sessions: [row], rows: [row] } })
      expect(next.rows.at(-1)).toBe(row)
    })
  }
})
