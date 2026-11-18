import { describe, expect, it } from 'bun:test'
import {
  MIN_QUIET_FOR_MS, CONFIRM_POLLS, HOLD_GRACE_MS, DEFAULT_DEADLINE_MS, DEFAULT_QUIET_FOR_MS, HANDOFF_DEADLINE_MS, decideRetire, effectiveDeadline, extendedDeadline, nextStreak, planRetireRequest,
  retireNoteText, retireReasonsText, type QuietStreak, type RetireObservation,
} from './retire-plan'
import type { RetireRequest } from './types'

const T0 = Date.parse('2026-10-16T10:00:00.000Z')
const req = (over: Partial<RetireRequest> = {}): RetireRequest => ({
  requestedAt: new Date(T0).toISOString(), by: 'person', quietForMs: 60_000,
  deadlineAt: new Date(T0 + 30 * 60_000).toISOString(), ...over,
})
const streak = (since: number, polls: number, last: number): QuietStreak => ({ since, polls, lastPollMs: last })
const quiet = (over: Partial<RetireObservation> = {}): RetireObservation => ({
  running: true, activity: 'waiting', streak: streak(T0, 13, T0 + 60_000), bgTasksRunning: 0,
  children: { checked: true, children: [] }, childrenTrusted: true, successorAlive: null, ...over,
})
const at = T0 + 61_000

describe('nextStreak — two-poll confirmation', () => {
  it('starts on waiting, grows per DISTINCT poll, breaks on anything else', () => {
    const a = nextStreak(null, 'waiting', 100)
    expect(a).toEqual({ since: 100, polls: 1, lastPollMs: 100 })
    expect(nextStreak(a, 'waiting', 100)).toBe(a) // the same snapshot twice is one poll
    expect(nextStreak(a, 'waiting', 105)).toEqual({ since: 100, polls: 2, lastPollMs: 105 })
    expect(nextStreak(a, 'working', 110)).toBeNull()
    expect(nextStreak(a, 'waiting-approval', 110)).toBeNull()
    expect(nextStreak(a, undefined, 110)).toBeNull()
  })
})

describe('decideRetire', () => {
  it('retires (kill) only when everything is quiet', () => {
    expect(decideRetire(req(), quiet(), at)).toEqual({ action: 'retire', kill: true, notes: [] })
  })
  it('an expired request or none is never acted on', () => {
    expect(decideRetire(undefined, quiet(), at)).toEqual({ action: 'none' })
    expect(decideRetire(req({ expiredAt: new Date(at).toISOString() }), quiet(), at)).toEqual({ action: 'none' })
  })
  it('a row that already stopped is filed without a kill', () => {
    expect(decideRetire(req(), quiet({ running: false, activity: 'working' }), at)).toEqual({ action: 'retire', kill: false, notes: [] })
  })
  it('working waits', () => {
    expect(decideRetire(req(), quiet({ activity: 'working', streak: null }), at)).toMatchObject({ action: 'wait', reasons: [{ code: 'working' }] })
  })
  it('waiting-approval NEVER retires, even when long quiet', () => {
    const d = decideRetire(req(), quiet({ activity: 'waiting-approval' }), at)
    expect(d).toMatchObject({ action: 'wait', reasons: [{ code: 'waiting-approval' }] })
  })
  it(`one poll of waiting is not confirmed (needs ${CONFIRM_POLLS})`, () => {
    const d = decideRetire(req({ quietForMs: 0 }), quiet({ streak: streak(T0, 1, T0) }), at)
    expect(d).toMatchObject({ action: 'wait', reasons: [{ code: 'not-confirmed', polls: 1 }] })
    expect(decideRetire(req({ quietForMs: 0 }), quiet({ streak: streak(T0, 2, T0 + 5000) }), at).action).toBe('retire')
  })
  it('quietFor is measured over the confirmed streak', () => {
    const d = decideRetire(req(), quiet({ streak: streak(T0, 5, T0 + 20_000) }), at)
    expect(d).toMatchObject({ action: 'wait', reasons: [{ code: 'quiet-too-short', quietMs: 20_000, wantMs: 60_000 }] })
  })
  it('a background task still running waits; an unreadable count is not quiet', () => {
    expect(decideRetire(req(), quiet({ bgTasksRunning: 2 }), at)).toMatchObject({ action: 'wait', reasons: [{ code: 'bg-tasks', count: 2 }] })
    expect(decideRetire(req(), quiet({ bgTasksRunning: null }), at)).toMatchObject({ action: 'wait', reasons: [{ code: 'bg-unknown' }] })
  })
  it('a work child waits', () => {
    const child = { pid: 9, ppid: 1, exe: 'bash', argv: 'bash -c sleep 600' }
    const d = decideRetire(req(), quiet({ children: { checked: true, children: [child] } }), at)
    expect(d).toMatchObject({ action: 'wait', reasons: [{ code: 'work-child' }] })
    expect(retireReasonsText(d.action === 'wait' ? d.reasons : [])).toBe('child process bash still running')
  })
  it('unchecked or untrusted children do not block, and SAY so (codex gate)', () => {
    expect(decideRetire(req(), quiet({ children: { checked: false, reason: 'unmeasured' } }), at))
      .toEqual({ action: 'retire', kill: true, notes: [{ code: 'children-unchecked', why: 'unmeasured' }] })
    const child = { pid: 9, ppid: 1, exe: 'bash', argv: 'bash' }
    // Untrusted (codex): an EMPTY answer is treated as unchecked…
    expect(decideRetire(req(), quiet({ childrenTrusted: false }), at))
      .toEqual({ action: 'retire', kill: true, notes: [{ code: 'children-unchecked', why: 'untrusted' }] })
    // …while a child it DOES see is evidence and still blocks.
    expect(decideRetire(req(), quiet({ childrenTrusted: false, children: { checked: true, children: [child] } }), at).action).toBe('wait')
    expect(retireNoteText({ code: 'children-unchecked', why: 'untrusted' }, 'codex')).toContain('codex')
  })
  it('a dead successor cancels; a live one does not block', () => {
    expect(decideRetire(req({ successorId: 's' }), quiet({ successorAlive: false }), at)).toEqual({ action: 'cancel', reason: 'successor-dead' })
    expect(decideRetire(req({ successorId: 's' }), quiet({ successorAlive: true }), at).action).toBe('retire')
  })
  it('at or past the deadline nothing is killed — it expires with the reasons', () => {
    const dl = T0 + 30 * 60_000
    expect(decideRetire(req(), quiet({ activity: 'working', streak: null }), dl)).toMatchObject({ action: 'expire', reasons: [{ code: 'working' }] })
    // Even a session that is quiet exactly at the deadline is not killed past it.
    expect(decideRetire(req(), quiet(), dl)).toEqual({ action: 'expire', reasons: [], notes: [] })
    expect(decideRetire(req(), quiet(), dl - 1).action).toBe('retire')
  })
})

describe('planRetireRequest', () => {
  it('fills the defaults', () => {
    const p = planRetireRequest(undefined, { by: 'person' }, T0)
    expect(p).toEqual({
      ok: true,
      request: { requestedAt: new Date(T0).toISOString(), by: 'person', quietForMs: DEFAULT_QUIET_FOR_MS, deadlineAt: new Date(T0 + DEFAULT_DEADLINE_MS).toISOString() },
    })
  })
  it('refuses a second hand-off to a different successor; same successor or an expired one is replaced', () => {
    const pending = req({ successorId: 's1' })
    expect(planRetireRequest(pending, { by: 'x', successorId: 's2' }, T0)).toEqual({ ok: false, code: 'handoff_pending', successorId: 's1' })
    expect(planRetireRequest(pending, { by: 'x', successorId: 's1', deadlineMs: 5 }, T0).ok).toBe(true)
    expect(planRetireRequest({ ...pending, expiredAt: 'x' }, { by: 'x', successorId: 's2' }, T0).ok).toBe(true)
  })
})

// LIDER.PASSAGEM (owner 2026-11-17): old leaders stayed `working` beside their successors. 55 of 59
// real hand-off retires EXPIRED ("its child processes could not be read" — a structured session has
// no pane), and the deadline only ever expired. A HAND-OFF with a live successor is now guaranteed.
describe('hand-off retire is guaranteed (LIDER.PASSAGEM)', () => {
  const handoff = (over: Partial<RetireRequest> = {}) => req({ successorId: 's', ...over })
  it('a new hand-off request defaults to the short quiet and a 10-minute deadline', () => {
    const p = planRetireRequest(undefined, { by: 's', successorId: 's' }, T0)
    expect(p).toMatchObject({ ok: true, request: { quietForMs: MIN_QUIET_FOR_MS, deadlineAt: new Date(T0 + HANDOFF_DEADLINE_MS).toISOString() } })
    expect(HANDOFF_DEADLINE_MS).toBeLessThanOrEqual(10 * 60_000)
  })
  it('a plain (non hand-off) request keeps its old defaults', () => {
    expect(planRetireRequest(undefined, { by: 'person' }, T0)).toMatchObject({ request: { quietForMs: DEFAULT_QUIET_FOR_MS } })
  })
  it('retires as soon as the turn ends: confirmed waiting for the short quiet, children unmeasured', () => {
    const r = handoff({ quietForMs: MIN_QUIET_FOR_MS })
    const obs = quiet({ successorAlive: true, streak: streak(T0, 2, T0 + MIN_QUIET_FOR_MS), children: { checked: false, reason: 'unmeasured' } })
    expect(decideRetire(r, obs, T0 + MIN_QUIET_FOR_MS).action).toBe('retire')
  })
  it('past the deadline a hand-off with a LIVE successor is closed even while working (kept nudged)', () => {
    const dl = Date.parse(handoff().deadlineAt)
    for (const o of [
      { activity: 'working' as const, streak: null },
      { children: null },
      { bgTasksRunning: 3 },
      { activity: 'waiting' as const, streak: streak(dl - 4000, 1, dl - 4000) },
    ]) {
      const d = decideRetire(handoff(), quiet({ successorAlive: true, ...o }), dl)
      expect(d).toMatchObject({ action: 'retire', kill: true, forced: true })
    }
  })
  it('the 10-minute cap also binds an OLD request stored with a 30-minute deadline', () => {
    const old = handoff() // deadlineAt = T0 + 30 min
    const d = decideRetire(old, quiet({ successorAlive: true, activity: 'working', streak: null }), T0 + HANDOFF_DEADLINE_MS)
    expect(d).toMatchObject({ action: 'retire', kill: true, forced: true })
    expect(effectiveDeadline(old)).toBe(T0 + HANDOFF_DEADLINE_MS)
  })
  it('a successor not yet observed never forces a kill — it waits; a dead one cancels', () => {
    const dl = Date.parse(handoff().deadlineAt)
    expect(decideRetire(handoff(), quiet({ successorAlive: null, activity: 'working', streak: null }), dl).action).toBe('wait')
    expect(decideRetire(handoff(), quiet({ successorAlive: false }), dl)).toEqual({ action: 'cancel', reason: 'successor-dead' })
  })
  it('a request with no successor still expires at its deadline (unchanged)', () => {
    const dl = T0 + 30 * 60_000
    expect(decideRetire(req(), quiet({ activity: 'working', streak: null }), dl).action).toBe('expire')
  })
})

describe('retire QA safety gates', () => {
  it('a named successor whose liveness is unknown blocks', () => {
    expect(decideRetire(req({ successorId: 's' }), quiet(), at))
      .toMatchObject({ action: 'wait', reasons: [{ code: 'successor-unknown' }] })
  })
  it('unreadable children on a trusted harness block; untrusted still carries a note', () => {
    for (const children of [null, { checked: false, reason: 'unreadable' }] as const) {
      expect(decideRetire(req(), quiet({ children }), at))
        .toMatchObject({ action: 'wait', reasons: [{ code: 'children-unreadable' }] })
      expect(decideRetire(req(), quiet({ children, childrenTrusted: false }), at))
        .toEqual({ action: 'retire', kill: true, notes: [{ code: 'children-unchecked', why: 'unreadable' }] })
    }
  })
  it('new requests enforce minimum quietFor even outside the CLI', () => {
    const p = planRetireRequest(undefined, { by: 'person', quietForMs: 0 }, T0)
    expect(p).toMatchObject({ ok: true, request: { quietForMs: MIN_QUIET_FOR_MS } })
  })
})

describe('a hold holds the retire', () => {
  const held = { state: 'held', since: T0 - 120_000, sentence: { en: 'engine words', pt: 'palavras do engine' } } as const

  it('held → the session is held even when it is long quiet', () => {
    const d = decideRetire(req(), quiet({ hold: held }), at)
    expect(d).toEqual({ action: 'wait', reasons: [{ code: 'in-use', since: T0 - 120_000, sentence: held.sentence }], notes: [] })
  })
  it('hold ends → the very same observation retires', () => {
    expect(decideRetire(req(), quiet({ hold: held }), at).action).toBe('wait')
    expect(decideRetire(req(), quiet({ hold: { state: 'none' } }), at)).toEqual({ action: 'retire', kill: true, notes: [] })
    expect(decideRetire(req(), quiet(), at).action).toBe('retire') // absent = no hold
  })
  it('the deadline passing with a hold open does NOT expire and never kills', () => {
    const past = Date.parse(req().deadlineAt) + 1
    const d = decideRetire(req(), quiet({ hold: held }), past)
    expect(d.action).toBe('wait')
    expect(d).toMatchObject({ reasons: [{ code: 'in-use' }] })
    // and without the hold the same moment expires (nothing is ever killed past the deadline)
    expect(decideRetire(req(), quiet(), past).action).toBe('expire')
  })
  it('a hold state that could not be read is unknown, and unknown is never quiet', () => {
    expect(decideRetire(req(), quiet({ hold: { state: 'unknown' } }), at)).toMatchObject({ action: 'wait', reasons: [{ code: 'hold-unknown' }] })
  })
  it('a row that already stopped is filed whatever the hold says (nothing to kill)', () => {
    expect(decideRetire(req(), quiet({ running: false, hold: held }), at)).toEqual({ action: 'retire', kill: false, notes: [] })
  })
  it('a dead successor still cancels (the task is never left without a leader)', () => {
    expect(decideRetire(req({ successorId: 'b' }), quiet({ successorAlive: false, hold: held }), at)).toEqual({ action: 'cancel', reason: 'successor-dead' })
  })
  it('the hold outranks a working row: it is the reason said', () => {
    expect(decideRetire(req(), quiet({ activity: 'working', streak: null, hold: held }), at)).toMatchObject({ reasons: [{ code: 'in-use' }] })
  })
  it('the reason says it in words', () => {
    expect(retireReasonsText([{ code: 'in-use', since: T0, sentence: { en: 'engine words', pt: 'palavras do engine' } }])).toContain('engine words')
    expect(retireReasonsText([{ code: 'hold-unknown' }])).toContain('could not be read')
  })
  it('extendedDeadline follows the hold: only when the deadline is near or past', () => {
    const r = req()
    expect(extendedDeadline(r, T0)).toBeNull()
    const near = Date.parse(r.deadlineAt) - HOLD_GRACE_MS / 4
    expect(extendedDeadline(r, near)).toBe(new Date(near + HOLD_GRACE_MS).toISOString())
    const past = Date.parse(r.deadlineAt) + 1000
    expect(Date.parse(extendedDeadline(r, past)!)).toBe(past + HOLD_GRACE_MS)
  })
  it('re-asking for the SAME successor keeps the notice said; another successor is refused anyway', () => {
    const said = req({ successorId: 'b', handoffNoticeAt: new Date(T0).toISOString() })
    const again = planRetireRequest(said, { by: 'x', successorId: 'b' }, T0 + 1000)
    expect(again.ok && again.request.handoffNoticeAt).toBe(new Date(T0).toISOString())
    const fresh = planRetireRequest(undefined, { by: 'x', successorId: 'b' }, T0)
    expect(fresh.ok && fresh.request.handoffNoticeAt).toBeUndefined()
  })
})

describe('a hold-extended hand-off is not trimmed back to the 10-minute cap', () => {
  it('effectiveDeadline: the cap binds a hand-off, but not once a hold moved the deadline', () => {
    const base = req({ successorId: 'b', deadlineAt: new Date(T0 + 30 * 60_000).toISOString(), requestedAt: new Date(T0).toISOString() })
    expect(effectiveDeadline(base)).toBe(T0 + HANDOFF_DEADLINE_MS)
    expect(effectiveDeadline({ ...base, holdExtendedAt: new Date(T0).toISOString() })).toBe(T0 + 30 * 60_000)
  })
})
