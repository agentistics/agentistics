/**
 * S7a — custody clocks, the PURE half (spec §5.1, §5.2, §5.4.1–5 and .9–.12). Injected clock, no store, no fleet.
 * Every NEGATIVE control runs after a POSITIVE has established custody in the same fixture, so a planner that never
 * assigns anything fails the positive first and cannot pass a "no custody" assertion by doing nothing.
 */
import { describe, expect, test } from 'bun:test'
import {
  applyCustodyPatch, custodyView, planCustody, type Custody, type CustodyPiece, type CustodySession,
} from './custody'

const MIN = 60_000
const H = 3600_000
const N = 4 * H
const T0 = Date.parse('2026-11-16T08:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const P = 'github.com/acme/app'

const piece = (key: string, o: Partial<CustodyPiece> = {}): CustodyPiece => ({
  key, taskId: `task-${key}`, phase: 'revisao_lider', project: P, stageSince: iso(T0 - H),
  leaderSessionId: 'L1', leaderActivityBy: 'L1', leaderActivityAt: iso(T0), ...o,
})
const sess = (id: string, o: Partial<CustodySession> = {}): CustodySession => ({ id, alive: true, role: 'leader', taskId: `task-${id}`, ...o })

interface Fixture { pieces: CustodyPiece[]; sessions: CustodySession[] | null }
/** One tick at `now`: plan, apply every patch to the pieces (the persisted state), return what was planned. */
function tick(f: Fixture, now: number) {
  const plan = planCustody({ now, orphanMs: N, pieces: f.pieces, sessions: f.sessions })
  f.pieces = f.pieces.map(p => { const patch = plan.patches.find(x => x.key === p.key); return patch ? applyCustodyPatch(p, patch, iso(now)) : p })
  return plan
}
/** Ticks every minute from `from` to `to` (inclusive), returning the last plan. */
function run(f: Fixture, from: number, to: number) {
  let last = tick(f, from)
  for (let t = from + MIN; t <= to; t += MIN) last = tick(f, t)
  return last
}
const get = (f: Fixture, key: string) => f.pieces.find(p => p.key === key)!
/** The record as a restarted server reads it back. */
const reload = (f: Fixture): Fixture => ({ pieces: JSON.parse(JSON.stringify(f.pieces)), sessions: f.sessions })

/**
 * The fixture's POSITIVE (§5.4.1): L1 filed on pA, acted at T0 and died. L2 is a live leader of the SAME project with
 * recent piece activity on another task. Returns the fixture at N+1 min with custody established on pA.
 */
function positive(extra: { pieces?: CustodyPiece[]; sessions?: CustodySession[] } = {}): Fixture {
  const f: Fixture = {
    pieces: [
      piece('pA'),
      piece('pL2', { taskId: 'task-L2', leaderSessionId: 'L2', leaderActivityBy: 'L2', leaderActivityAt: iso(T0 + N), project: P }),
      ...(extra.pieces ?? []),
    ],
    sessions: [sess('L1', { alive: false }), sess('L2', { taskId: 'task-L2' }), ...(extra.sessions ?? [])],
  }
  run(f, T0 + MIN, T0 + N - MIN)
  expect(custodyView(get(f, 'pA'), T0 + N - MIN, N)).toBe('no-leader')
  expect(get(f, 'pA').custody).toBeUndefined()
  const last = run(f, T0 + N, T0 + N + MIN)
  expect(get(f, 'pA').custody).toMatchObject({ sessionId: 'L2', via: 'project-leader', project: P })
  expect(last.assignments.some(a => a.sessionId === 'L2' && a.keys.includes('pA'))).toBe(true)
  return f
}

describe('§5.4.1 positive — a dead leader, a live project leader', () => {
  test('N−1 min: "Sem líder"; N+1 min: custody = the live same-project leader, message planned, view says orphan', () => {
    const f: Fixture = { pieces: [piece('pA'), piece('pL2', { taskId: 'task-L2', leaderSessionId: 'L2', leaderActivityBy: 'L2', leaderActivityAt: iso(T0 + N), project: P })], sessions: [sess('L1', { alive: false }), sess('L2', { taskId: 'task-L2' })] }
    run(f, T0 + MIN, T0 + N - MIN)
    expect(get(f, 'pA').leaderAbsentSince).toBe(iso(T0))
    expect(custodyView(get(f, 'pA'), T0 + N - MIN, N)).toBe('no-leader')
    expect(get(f, 'pA').custody).toBeUndefined()
    const at = run(f, T0 + N, T0 + N + MIN)
    expect(get(f, 'pA').custody).toMatchObject({ sessionId: 'L2', since: iso(T0 + N + MIN), via: 'project-leader', project: P })
    expect(custodyView(get(f, 'pA'), T0 + N + MIN, N)).toBe('orphan')
    expect(at.assignments).toEqual([{ sessionId: 'L2', project: P, keys: ['pA'] }])
  })
  test('the piece action stamps nothing here — the clocks are only moved by the tick (set and cleared only by it)', () => {
    const f = positive()
    expect(get(f, 'pA').leaderActivityAt).toBe(iso(T0))
  })
})

describe('§5.4.2 zombie — alive, heartbeat refreshed, no piece action', () => {
  test('custody is assigned although the row is alive and its heartbeat is fresh every minute', () => {
    const f = positive({ pieces: [piece('pZ', { taskId: 'task-Z', leaderSessionId: 'Z', leaderActivityBy: 'Z', leaderActivityAt: iso(T0) })], sessions: [sess('Z', { taskId: 'task-Z', status: 'waiting' })] })
    // positive established custody on pA above. Now the zombie: refresh its heartbeat every minute from T0 on.
    for (let t = T0; t <= T0 + N + 2 * MIN; t += MIN) { f.sessions = f.sessions!.map(s => (s.id === 'Z' ? { ...s, lastSeenMs: t, lastTranscriptAt: iso(t) } : s)); tick(f, t) }
    expect(get(f, 'pZ').custody).toMatchObject({ sessionId: 'L2', via: 'project-leader' })
    expect(get(f, 'pZ').leaderAbsentSince).toBe(iso(T0))
  })
  test('just under N the zombie is still led (the clock is the piece action, not the row)', () => {
    const f = positive({ pieces: [piece('pZ', { taskId: 'task-Z', leaderSessionId: 'Z', leaderActivityBy: 'Z', leaderActivityAt: iso(T0 + 10 * MIN) })], sessions: [sess('Z', { taskId: 'task-Z', lastSeenMs: T0 + N + MIN })] })
    expect(custodyView(get(f, 'pZ'), T0 + N + MIN, N)).toBe('led')
    expect(get(f, 'pZ').custody).toBeUndefined()
  })
})

describe('§5.4.3 keep-alive cheats — each after the positive', () => {
  test('(a) plain comments on the same piece every hour do not reset absence (they are not an input at all)', () => {
    const f = positive({ pieces: [piece('pK', { taskId: 'task-K', leaderSessionId: 'K', leaderActivityBy: 'K', leaderActivityAt: iso(T0) })], sessions: [sess('K', { taskId: 'task-K' })] })
    // a comment is not a piece action: nothing stamps `leaderActivityAt` (the e2e test posts real comments); the planner
    // has no comment input, so the only thing to show here is that the clock is untouched by the passage of hours.
    run(f, T0 + N + 3 * MIN, T0 + N + 10 * MIN)
    expect(get(f, 'pK').custody).toMatchObject({ sessionId: 'L2' })
  })
  test('(b) transcript writes about ANOTHER task do not reset absence', () => {
    const f = positive({ pieces: [piece('pK', { taskId: 'task-K', leaderSessionId: 'K', leaderActivityBy: 'K', leaderActivityAt: iso(T0) })], sessions: [sess('K', { taskId: 'task-K', lastTranscriptAt: iso(T0 + N) })] })
    run(f, T0 + N + 3 * MIN, T0 + N + 6 * MIN)
    expect(get(f, 'pK').custody).toMatchObject({ sessionId: 'L2' })
  })
  test('(c) a heartbeat-only zombie does not reset absence', () => {
    const f = positive({ pieces: [piece('pK', { taskId: 'task-K', leaderSessionId: 'K', leaderActivityBy: 'K', leaderActivityAt: iso(T0) })], sessions: [sess('K', { taskId: 'task-K', lastSeenMs: T0 + N })] })
    run(f, T0 + N + 3 * MIN, T0 + N + 6 * MIN)
    expect(get(f, 'pK').custody).toMatchObject({ sessionId: 'L2' })
  })
  test('(d) a real authorized piece action by the original leader resets absence AND returns custody', () => {
    const f = positive({ pieces: [piece('pK', { taskId: 'task-K', leaderSessionId: 'K', leaderActivityBy: 'K', leaderActivityAt: iso(T0) })], sessions: [sess('K', { taskId: 'task-K' })] })
    run(f, T0 + N + 2 * MIN, T0 + N + 5 * MIN)
    expect(get(f, 'pK').custody).toMatchObject({ sessionId: 'L2' })
    // the filed leader acts again on the piece (the store hook stamps it)
    f.pieces = f.pieces.map(p => (p.key === 'pK' ? { ...p, leaderActivityAt: iso(T0 + N + 6 * MIN), leaderActivityBy: 'K' } : p))
    const plan = tick(f, T0 + N + 7 * MIN)
    expect(get(f, 'pK').custody).toBeUndefined()
    expect(get(f, 'pK').leaderAbsentSince).toBeNull()
    expect(get(f, 'pK').custodyLog?.at(-1)).toMatchObject({ event: 'ended', sessionId: 'L2' })
    expect(plan.actions.join(' ')).toContain('custody-ended pK')
  })
  test('(d) an action by an actor that is neither the filed leader, a custodian nor a live leader of the task resets nothing', () => {
    const f = positive({ pieces: [piece('pK', { taskId: 'task-K', leaderSessionId: 'K', leaderActivityBy: 'K', leaderActivityAt: iso(T0) })], sessions: [sess('K', { taskId: 'task-K', alive: false })] })
    f.pieces = f.pieces.map(p => (p.key === 'pK' ? { ...p, leaderActivityAt: iso(T0 + N + 6 * MIN), leaderActivityBy: 'stranger' } : p))
    run(f, T0 + N + 7 * MIN, T0 + N + 9 * MIN)
    expect(get(f, 'pK').custody).toMatchObject({ sessionId: 'L2' })
  })
})

describe('§5.4.4 never-led', () => {
  test('a piece created in review with no leader: absence starts at the stage entry, custody after N', () => {
    const E = T0 + 30 * MIN
    const f = positive({ pieces: [{ key: 'pN', taskId: 'task-N', phase: 'revisao_lider', project: P, stageSince: iso(E) }] })
    // L2 stays a project leader through the window
    f.pieces = f.pieces.map(p => (p.key === 'pL2' ? { ...p, leaderActivityAt: iso(E + N) } : p))
    run(f, T0 + N + 3 * MIN, E + N - MIN)
    expect(get(f, 'pN').leaderAbsentSince).toBe(iso(E))
    expect(get(f, 'pN').custody).toBeUndefined()
    run(f, E + N, E + N + 2 * MIN)
    expect(get(f, 'pN').custody).toMatchObject({ sessionId: 'L2', via: 'project-leader' })
  })
})

describe('§5.4.5 restart', () => {
  test('absence persisted across a restart: the reloaded state assigns at the same instant', () => {
    const f: Fixture = { pieces: [piece('pA'), piece('pL2', { taskId: 'task-L2', leaderSessionId: 'L2', leaderActivityBy: 'L2', leaderActivityAt: iso(T0 + N), project: P })], sessions: [sess('L1', { alive: false }), sess('L2', { taskId: 'task-L2' })] }
    run(f, T0 + MIN, T0 + 2 * MIN)
    const since = get(f, 'pA').leaderAbsentSince
    expect(since).toBe(iso(T0))
    // the server is down for three hours; nothing ticks. It restarts from the persisted bytes.
    const g = reload(f)
    tick(g, T0 + 3 * H + 5 * MIN)
    expect(get(g, 'pA').leaderAbsentSince).toBe(since)
    expect(get(g, 'pA').custody).toBeUndefined()
    tick(g, T0 + N + MIN)
    expect(get(g, 'pA').leaderAbsentSince).toBe(since)
    expect(get(g, 'pA').custody).toMatchObject({ sessionId: 'L2' })
  })
  test('a led piece with NO activity on record (it predates the stamp) is anchored at the first tick that sees it, and a restart keeps that anchor', () => {
    const f: Fixture = { pieces: [piece('pA'), piece('pL2', { taskId: 'task-L2', leaderSessionId: 'L2', leaderActivityBy: 'L2', leaderActivityAt: iso(T0 + N), project: P })], sessions: [sess('L1', { alive: false }), sess('L2', { taskId: 'task-L2' })] }
    delete f.pieces[0]!.leaderActivityAt; delete f.pieces[0]!.leaderActivityBy
    f.pieces[1]!.leaderActivityAt = iso(T0 + 10 * H + N - 5 * MIN) // L2 is still a recent project leader at the assignment
    tick(f, T0 + 10 * H)
    expect(get(f, 'pA').leaderAbsentSince).toBe(iso(T0 + 10 * H))
    const g = reload(f)
    tick(g, T0 + 10 * H + N - MIN)
    expect(get(g, 'pA').leaderAbsentSince).toBe(iso(T0 + 10 * H))
    expect(get(g, 'pA').custody).toBeUndefined()
    tick(g, T0 + 10 * H + N + MIN)
    expect(get(g, 'pA').custody).toMatchObject({ sessionId: 'L2' })
  })
  test('a restart does NOT restart the clock: an absence is never re-anchored to the first tick after boot', () => {
    const f = positive()
    const g = reload(f)
    tick(g, T0 + 9 * H)
    expect(get(g, 'pA').leaderAbsentSince).toBe(iso(T0))
  })
})

describe('§5.4.8 queue (the S7a half: the state; the SessionStart context is S7b)', () => {
  test('no project leader → queue; a leader appears → assigned on the next tick and planned for the message', () => {
    const f: Fixture = { pieces: [piece('pA')], sessions: [sess('L1', { alive: false })] }
    run(f, T0 + MIN, T0 + N + 2 * MIN)
    expect(get(f, 'pA').custody).toMatchObject({ sessionId: null, via: 'queue', project: P })
    f.sessions = [...f.sessions!, sess('L9', { taskId: 'task-L9' })]
    f.pieces = [...f.pieces, piece('pL9', { taskId: 'task-L9', leaderSessionId: 'L9', leaderActivityBy: 'L9', leaderActivityAt: iso(T0 + N + 3 * MIN) })]
    const plan = tick(f, T0 + N + 4 * MIN)
    expect(get(f, 'pA').custody).toMatchObject({ sessionId: 'L9', via: 'project-leader' })
    expect(plan.assignments).toEqual([{ sessionId: 'L9', project: P, keys: ['pA'] }])
  })
})

describe('§5.4.9 custodian dies', () => {
  test('re-assigned to another live project leader when one exists', () => {
    const f = positive({ pieces: [piece('pL4', { taskId: 'task-L4', leaderSessionId: 'L4', leaderActivityBy: 'L4', leaderActivityAt: iso(T0 + N - 10 * MIN) })], sessions: [sess('L4', { taskId: 'task-L4' })] })
    f.sessions = f.sessions!.map(s => (s.id === 'L2' ? { ...s, alive: false } : s))
    const plan = tick(f, T0 + N + 10 * MIN)
    expect(get(f, 'pA').custody).toMatchObject({ sessionId: 'L4', via: 'project-leader' })
    expect(plan.assignments.some(a => a.sessionId === 'L4' && a.keys.includes('pA'))).toBe(true)
    expect(get(f, 'pA').custodyLog?.map(e => e.event)).toContain('lost')
  })
  test('back to the queue when none does', () => {
    const f = positive()
    f.sessions = f.sessions!.map(s => (s.id === 'L2' ? { ...s, alive: false } : s))
    tick(f, T0 + N + 10 * MIN)
    expect(get(f, 'pA').custody).toMatchObject({ sessionId: null, via: 'queue', project: P })
  })
  test('a custodian that is alive but idle past N loses custody too (liveness is necessary, never sufficient)', () => {
    const f = positive()
    // L2 stays alive with a fresh heartbeat but stops acting; custody.since = T0+N+1min, so past T0+2N+1min it lapses
    f.pieces = f.pieces.map(p => (p.key === 'pL2' ? { ...p, leaderActivityAt: iso(T0) } : p))
    f.sessions = f.sessions!.map(s => (s.id === 'L2' ? { ...s, lastSeenMs: T0 + 3 * N } : s))
    tick(f, T0 + N + 2 * MIN)
    expect(get(f, 'pA').custody).toMatchObject({ sessionId: 'L2' }) // still inside its grace
    tick(f, T0 + 2 * N + 5 * MIN)
    expect(get(f, 'pA').custody).toMatchObject({ sessionId: null, via: 'queue' })
  })
})

describe('§5.4.10 cross-project', () => {
  test('a leader of another repository never receives the piece (after the same-project assignment works)', () => {
    const f = positive({ pieces: [piece('pX', { taskId: 'task-X', project: 'github.com/acme/other', leaderSessionId: 'LX', leaderActivityBy: 'LX', leaderActivityAt: iso(T0 + N + 5 * MIN) })], sessions: [sess('LX', { taskId: 'task-X' })] })
    // the same-project leader goes away: the only live leader left is in ANOTHER project
    f.sessions = f.sessions!.map(s => (s.id === 'L2' ? { ...s, alive: false } : s))
    tick(f, T0 + N + 10 * MIN)
    expect(get(f, 'pA').custody).toMatchObject({ sessionId: null, via: 'queue', project: P })
    for (const p of f.pieces) expect(p.custody?.sessionId).not.toBe('LX')
  })
  test('a piece whose project cannot be established is queued, never given to anybody', () => {
    const f = positive({ pieces: [piece('pU', { taskId: 'task-U', project: '', leaderActivityAt: iso(T0) })] })
    run(f, T0 + N + 3 * MIN, T0 + N + 5 * MIN)
    expect(get(f, 'pU').custody).toMatchObject({ sessionId: null, via: 'queue', project: '' })
  })
})

describe('§5.4.11 fleet unknown', () => {
  test('after custody exists: nothing changes — the absence clock neither advances nor clears', () => {
    const f = positive({ pieces: [piece('pK', { taskId: 'task-K', leaderSessionId: 'K', leaderActivityBy: 'K', leaderActivityAt: iso(T0 + N - 10 * MIN) })], sessions: [sess('K', { taskId: 'task-K' })] })
    const before = JSON.stringify(f.pieces)
    f.sessions = null
    const plan = tick(f, T0 + 20 * H)
    expect(plan.patches).toEqual([])
    expect(plan.assignments).toEqual([])
    expect(JSON.stringify(f.pieces)).toBe(before)
  })
  test('an empty (readable) fleet is NOT unknown: with nobody alive the clock runs', () => {
    const f: Fixture = { pieces: [piece('pA')], sessions: [] }
    run(f, T0 + MIN, T0 + N + 2 * MIN)
    expect(get(f, 'pA').leaderAbsentSince).toBe(iso(T0))
    expect(get(f, 'pA').custody).toMatchObject({ sessionId: null, via: 'queue' })
  })
})

describe('§5.4.12 mutation control — absence anchored to lastSeenMs (r1) must lose case 2', () => {
  test('under r1 a heartbeat-fresh zombie is "present" for ever; the real rule orphans it', () => {
    const f = positive({ pieces: [piece('pZ', { taskId: 'task-Z', leaderSessionId: 'Z', leaderActivityBy: 'Z', leaderActivityAt: iso(T0) })], sessions: [sess('Z', { taskId: 'task-Z', lastSeenMs: T0 + N + 2 * MIN })] })
    const now = T0 + N + 2 * MIN
    const r1Present = (s: CustodySession) => s.alive && now - (s.lastSeenMs ?? 0) <= N
    expect(r1Present(f.sessions!.find(s => s.id === 'Z')!)).toBe(true) // r1: the zombie never ages out
    run(f, T0 + N, now)
    expect(get(f, 'pZ').custody).toBeDefined() // the real rule: it does
  })
})

describe('eligibility and the other phases', () => {
  test('queued, blocked and not-yet-started pieces never accrue absence; published ends custody and clears the clock', () => {
    const f = positive({ pieces: [piece('pF', { phase: 'fila', leaderActivityAt: iso(T0) }), piece('pB', { phase: 'bloqueado', leaderActivityAt: iso(T0) })] })
    run(f, T0 + N + 3 * MIN, T0 + N + 5 * MIN)
    expect(get(f, 'pF').leaderAbsentSince).toBeUndefined()
    expect(get(f, 'pB').leaderAbsentSince).toBeUndefined()
    f.pieces = f.pieces.map(p => (p.key === 'pA' ? { ...p, phase: 'publicado' } : p))
    tick(f, T0 + N + 6 * MIN)
    expect(get(f, 'pA').custody).toBeUndefined()
    expect(get(f, 'pA').leaderAbsentSince).toBeNull()
  })
  test('a running stage (rank 0) and ranks 1–3 all count; the leader\'s own other-task activity is not a candidate for its own piece', () => {
    const f: Fixture = { pieces: [piece('pE', { phase: 'executando' }), piece('pQ', { phase: 'qa' }), piece('pJ', { phase: 'ajuste' }), piece('pM', { phase: 'pr_merge' }), piece('pC', { phase: 'ci' })], sessions: [sess('L1', { alive: true })] }
    run(f, T0 + N + MIN, T0 + N + 3 * MIN)
    for (const k of ['pE', 'pQ', 'pJ', 'pM', 'pC']) expect(get(f, k).leaderAbsentSince).toBeTruthy()
    // L1 is alive and active on ANOTHER task of the project, but it is the one absent from these pieces: never its own custodian
    f.pieces = [...f.pieces, piece('pOther', { taskId: 'task-other', leaderActivityAt: iso(T0 + N + 3 * MIN) })]
    run(f, T0 + N + 4 * MIN, T0 + N + 6 * MIN)
    for (const k of ['pE', 'pQ', 'pJ', 'pM', 'pC']) expect(get(f, k).custody).toMatchObject({ sessionId: null, via: 'queue' })
  })
  test('a custodian\'s own piece action keeps custody and clears absence (it is a leader acting on the piece)', () => {
    const f = positive()
    f.pieces = f.pieces.map(p => (p.key === 'pA' ? { ...p, leaderActivityBy: 'L2', leaderActivityAt: iso(T0 + N + 30 * MIN) } : p))
    tick(f, T0 + N + 31 * MIN)
    expect(get(f, 'pA').custody).toMatchObject({ sessionId: 'L2' })
    expect(get(f, 'pA').leaderAbsentSince).toBeNull()
  })
  test('a notified custody is not planned for the message again; an unnotified one is retried', () => {
    const f = positive()
    const plan = tick(f, T0 + N + 5 * MIN)
    expect(plan.assignments.some(a => a.sessionId === 'L2')).toBe(true) // never marked notified: retried
    f.pieces = f.pieces.map(p => (p.key === 'pA' ? { ...p, custody: { ...(p.custody as Custody), notifiedAt: iso(T0 + N + 5 * MIN) } } : p))
    expect(tick(f, T0 + N + 6 * MIN).assignments.some(a => a.keys.includes('pA'))).toBe(false)
  })
})
