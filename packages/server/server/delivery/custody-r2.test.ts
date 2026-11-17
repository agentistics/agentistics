/** S7a r2 — pure rules: the tie-break (M13), what counts as a semantic change, the board's activity facts, the stamp in the store write. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boardActivityOf, orphanMsOf, planCustody, semanticallyChanged, type CustodyPiece, type CustodySession } from './custody'
import { planOf } from './custody-tick'
import { createDeliveryStore } from './store'
import { newDelivery } from './machine'

const MIN = 60_000
const H = 3600_000
const N = orphanMsOf(undefined)
const T0 = Date.parse('2026-11-16T08:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const leader = (id: string, taskId: string): CustodySession => ({ id, alive: true, role: 'leader', taskId })
const piece = (key: string, o: Partial<CustodyPiece> = {}): CustodyPiece => ({ key, taskId: `t-${key}`, phase: 'revisao_lider', project: 'acme/app', stageSince: iso(T0 - H), ...o })

describe('M13 — a tie between two project leaders goes to the SMALLER session id, whatever the order they arrive in', () => {
  const orphan = piece('p1', { leaderSessionId: 'L0', leaderActivityBy: 'L0', leaderActivityAt: iso(T0), leaderAbsentSince: iso(T0) })
  const same = (id: string, at = T0 + N) => piece(`k-${id}`, { taskId: `t-${id}`, leaderSessionId: id, leaderActivityBy: id, leaderActivityAt: iso(at) })
  for (const order of [['A1', 'B2'], ['B2', 'A1']]) {
    test(`equal activity instants, candidates listed ${order.join(',')}: A1 is the custodian and the only one messaged`, () => {
      const plan = planCustody({ now: T0 + N + 10 * MIN, orphanMs: N, pieces: [orphan, ...order.map(id => same(id))], sessions: [{ id: 'L0', alive: false, role: 'leader', taskId: 't-p1' }, ...order.map(id => leader(id, `t-${id}`))] })
      expect(plan.patches.find(p => p.key === 'p1')?.custody).toMatchObject({ sessionId: 'A1' })
      expect(plan.assignments.map(a => a.sessionId)).toEqual(['A1'])
    })
  }
  test('the more RECENT activity beats the smaller id (the tie-break is only a tie-break)', () => {
    const plan = planCustody({ now: T0 + N + 10 * MIN, orphanMs: N, pieces: [orphan, same('A1', T0 + N), same('B2', T0 + N + MIN)], sessions: [{ id: 'L0', alive: false, role: 'leader', taskId: 't-p1' }, leader('A1', 't-A1'), leader('B2', 't-B2')] })
    expect(plan.patches.find(p => p.key === 'p1')?.custody).toMatchObject({ sessionId: 'B2' })
  })
})

describe('F3 — semanticallyChanged', () => {
  const base = { a: 1, updatedAt: 'x', leaderTouchedAt: 'y', nested: { b: [1, 2] } }
  test('a refreshed timestamp, or the same value written again, is not a change', () => {
    expect(semanticallyChanged(base, { ...base, updatedAt: 'z', leaderTouchedAt: 'w' })).toBe(false)
    expect(semanticallyChanged(base, { ...base, leaderActivityAt: 'q', leaderActivityBy: 'L1' })).toBe(false)
    expect(semanticallyChanged(base, structuredClone(base))).toBe(false)
  })
  test('any other field changing is one (positive control for the line above)', () => {
    expect(semanticallyChanged(base, { ...base, a: 2 })).toBe(true)
    expect(semanticallyChanged(base, { ...base, nested: { b: [1, 2, 3] } })).toBe(true)
    expect(semanticallyChanged(undefined, base)).toBe(true)
    expect(semanticallyChanged(base, undefined)).toBe(false)
  })
})

describe('F4 — boardActivityOf: only a verified leader-grade board record on THIS piece', () => {
  const piece1 = { key: 'p1', taskId: 't-1' }
  const c = (o: Record<string, unknown> = {}) => ({ taskId: 't-1', subtaskId: 'p1', threadId: 'th', role: 'session', sessionId: 'L1', kind: 'decision', createdAt: iso(T0), ...o }) as never
  test('positive: a decision and a block count; the latest wins', () => {
    expect(boardActivityOf(piece1, { comments: [c(), c({ kind: 'block', createdAt: iso(T0 + H), sessionId: 'L2' })], events: [] })).toEqual({ at: iso(T0 + H), by: 'L2' })
  })
  test('a task-level piece (key == task) is read from comments with no subtask', () => {
    expect(boardActivityOf({ key: 't-1', taskId: 't-1' }, { comments: [c({ subtaskId: undefined })], events: [] })).toEqual({ at: iso(T0), by: 'L1' })
    expect(boardActivityOf(piece1, { comments: [c({ subtaskId: undefined })], events: [] })).toBeNull()
  })
  for (const [name, o] of [
    ['no thread', { threadId: undefined }], ['a note', { kind: undefined }], ['a handback', { kind: 'handback' }], ['unverified (no role)', { role: undefined }],
    ['an owner post', { role: 'owner' }], ['no session id', { sessionId: undefined }], ['another task', { taskId: 't-2' }], ['another piece', { subtaskId: 'p2' }],
  ] as const) test(`control: ${name} is not activity`, () => expect(boardActivityOf(piece1, { comments: [c(o)], events: [] })).toBeNull())
  test('a status event counts for a session actor only — never the flow, the owner or another piece', () => {
    const e = (o: Record<string, unknown>) => ({ taskId: 't-1', subtaskId: 'p1', at: iso(T0 + MIN), actor: 'L1', kind: 'status', ...o }) as never
    expect(boardActivityOf(piece1, { comments: [], events: [e({})] })).toEqual({ at: iso(T0 + MIN), by: 'L1' })
    for (const o of [{ actor: 'flow:sweep' }, { actor: 'owner' }, { subtaskId: 'p2' }, { kind: 'comment' }]) expect(boardActivityOf(piece1, { comments: [], events: [e(o)] })).toBeNull()
  })
})

describe('F1 — planOf judges the documents it is GIVEN (the tick hands it the freshest) and skips pieces it knows no project for', () => {
  const rec = (key: string, o: Record<string, unknown> = {}) => ({ ...newDelivery({ subtaskId: key, taskId: `t-${key}`, at: iso(T0 - H) }), phase: 'revisao_lider', ...o }) as never
  test('a leader action on the record the plan reads keeps the piece with its leader; the stale copy would orphan it', () => {
    const fleet = [{ id: 'L1', alive: true, role: 'leader', taskId: 't-p1' }, leader('L2', 't-p2')]
    const projects = new Map([['p1', 'acme/app'], ['p2', 'acme/app']])
    const p2 = rec('p2', { leaderSessionId: 'L2', leaderActivityBy: 'L2', leaderActivityAt: iso(T0 + N) })
    const stale = rec('p1', { leaderSessionId: 'L1', leaderActivityBy: 'L1', leaderActivityAt: iso(T0), leaderAbsentSince: iso(T0) })
    const fresh = rec('p1', { leaderSessionId: 'L1', leaderActivityBy: 'L1', leaderActivityAt: iso(T0 + N + 20 * MIN), leaderAbsentSince: iso(T0) })
    const now = T0 + N + 21 * MIN
    expect(planOf({ now, orphanMs: N, records: [stale, p2], projects, board: null, fleet }).patches.find(p => p.key === 'p1')?.custody).toMatchObject({ sessionId: 'L2' })
    expect(planOf({ now, orphanMs: N, records: [fresh, p2], projects, board: null, fleet }).patches.find(p => p.key === 'p1')).toMatchObject({ absentSince: null })
  })
  test('a piece with no resolved project (born after the projects were read) is left for the next tick', () => {
    const r = rec('p9', { leaderSessionId: 'L9', leaderActivityBy: 'L9', leaderActivityAt: iso(T0) })
    expect(planOf({ now: T0 + N + MIN, orphanMs: N, records: [r], projects: new Map(), board: null, fleet: [{ id: 'L9', alive: false, role: 'leader', taskId: 't-p9' }] }).patches).toEqual([])
  })
})

describe('F4 — the stamp rides the action\'s own write', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'custody-r2-store-')) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))
  const open = () => {
    const path = join(root, 'deliveries.json')
    const r = newDelivery({ subtaskId: 'p1', taskId: 't-p1', at: iso(T0) })
    writeFileSync(path, JSON.stringify({ version: 1, deliveries: { p1: r } }))
    return { store: createDeliveryStore(path), path, read: () => JSON.parse(readFileSync(path, 'utf8')).deliveries.p1 }
  }
  test('a semantic change stamps in the same write; a timestamp-only update does not; a refusing `when` does not', async () => {
    const { store, read } = open()
    await store.update(doc => { doc.deliveries.p1!.updatedAt = iso(T0 + MIN) }, { stamp: { key: 'p1', actor: 'L1', at: iso(T0 + MIN) } })
    expect(read().leaderActivityAt).toBeUndefined()
    await store.update(doc => { doc.deliveries.p1!.versionTarget = '1.0.0' }, { stamp: { key: 'p1', actor: 'L1', at: iso(T0 + 2 * MIN), when: () => false } })
    expect(read().leaderActivityAt).toBeUndefined()
    await store.update(doc => { doc.deliveries.p1!.versionTarget = '2.0.0' }, { stamp: { key: 'p1', actor: 'L1', at: iso(T0 + 3 * MIN) } })
    expect(read()).toMatchObject({ versionTarget: '2.0.0', leaderActivityAt: iso(T0 + 3 * MIN), leaderActivityBy: 'L1' })
  })
  test('no stamp option = the write is byte for byte what it always was', async () => {
    const { store, read } = open()
    await store.update(doc => { doc.deliveries.p1!.versionTarget = '2.0.0' })
    expect('leaderActivityAt' in read()).toBe(false)
  })
})
