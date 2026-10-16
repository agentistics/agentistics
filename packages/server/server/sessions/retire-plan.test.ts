import { describe, expect, it } from 'bun:test'
import {
  CONFIRM_POLLS, DEFAULT_DEADLINE_MS, DEFAULT_QUIET_FOR_MS, decideRetire, nextStreak, planRetireRequest,
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
