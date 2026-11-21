/**
 * The padlock's rules, exhaustively and purely (NAVEGADOR S3, spec §1.6). Every verb × every mode, the
 * deadline boundaries, who may change the padlock, the auto-lock table and the wait clamp.
 */
import { describe, expect, test } from 'bun:test'
import { HARNESS_ORDER, HARNESS_TOOL_TIMEOUT } from '@agentistics/core'
import { ACTION_KIND, SESSION_ACTIONS } from './browser-action-spec'
import {
  AUTO_LOCK_MS, HOLD_CAP_MS, HOLD_MIN_MS, MAX_HELD, PROGRESS_EVERY_MS,
  autoLockDue, decideGate, decideLockRequest, decideWait, expireHeld, hhmm, holdMsFor, holdMsForTimeout, initialLock,
  nextDeadline, notePersonInput, onBrowserStopped, setMode, waitReturnedAnswer, waitTimedOutAnswer,
  type LockState,
} from './browser-lock'

const T0 = 1_800_000_000_000
const unlocked = (now = T0): LockState => setMode(initialLock(now - 1), { mode: 'unlocked', now, by: 'person' }).state
const READS = SESSION_ACTIONS.filter(a => ACTION_KIND[a] === 'read')
const ACTIONS = SESSION_ACTIONS.filter(a => ACTION_KIND[a] === 'action')

describe('hold length — the harness\'s measured tool timeout', () => {
  test('measured rows: claude 130 s floor → 125 s; opencode 60 s limit → 55 s; unmeasured → 50 s', () => {
    expect(holdMsFor('claude')).toBe(125_000)
    expect(holdMsFor('opencode')).toBe(55_000)
    expect(holdMsFor('codex')).toBe(50_000)
    expect(holdMsFor(undefined)).toBe(50_000)
    expect(holdMsFor(null)).toBe(50_000)
  })

  // QA S3 mutant Q12: no harness in the table is longer than 130 s, so raising the cap survived.
  test('the cap is 10 minutes, and it binds a long harness; the floor binds a tiny one', () => {
    expect(HOLD_CAP_MS).toBe(10 * 60_000)
    expect(holdMsForTimeout(60 * 60_000)).toBe(10 * 60_000)
    expect(holdMsForTimeout(10 * 60_000 + 5_000)).toBe(10 * 60_000)
    expect(holdMsForTimeout(10 * 60_000 + 4_999)).toBe(10 * 60_000 - 1)
    expect(holdMsForTimeout(130_000)).toBe(125_000)
    expect(holdMsForTimeout(5_500)).toBe(HOLD_MIN_MS)
  })

  test('every harness: inside [1 s, 10 min], and always at least 5 s under its own timeout', () => {
    for (const h of HARNESS_ORDER) {
      const ms = holdMsFor(h)
      expect(ms).toBeGreaterThanOrEqual(HOLD_MIN_MS)
      expect(ms).toBeLessThanOrEqual(HOLD_CAP_MS)
      const t = HARNESS_TOOL_TIMEOUT[h]
      if (t) expect(ms).toBeLessThanOrEqual(t.ms - 5_000)
    }
  })

  test('every measured row carries its date and source; progress is announced well inside the 60 s floor', () => {
    for (const h of HARNESS_ORDER) {
      const t = HARNESS_TOOL_TIMEOUT[h]
      if (!t) continue
      expect(t.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(t.source.length).toBeGreaterThan(20)
    }
    expect(PROGRESS_EVERY_MS).toBeLessThanOrEqual(20_000)
  })
})

describe('the gate: every verb × every mode', () => {
  test('LOCKED: every verb proceeds (the model holds the browser)', () => {
    for (const a of SESSION_ACTIONS) {
      expect(decideGate(initialLock(T0), { action: a, isRead: ACTION_KIND[a] === 'read', now: T0, holdMs: 50_000, id: 'x' })).toEqual({ kind: 'proceed' })
    }
  })

  test('UNLOCKED: every READ proceeds — reading never gets in the person\'s way', () => {
    for (const a of READS) {
      expect(decideGate(unlocked(), { action: a, isRead: true, now: T0, holdMs: 50_000, id: 'x' })).toEqual({ kind: 'proceed' })
    }
  })

  test('UNLOCKED: every ACTION is held until now + holdMs, and nothing else changes', () => {
    for (const a of ACTIONS) {
      const s = unlocked()
      const d = decideGate(s, { action: a, isRead: false, now: T0 + 7, holdMs: 50_000, id: `h-${a}` })
      expect(d.kind).toBe('hold')
      if (d.kind !== 'hold') continue
      expect(d.held).toEqual({ id: `h-${a}`, action: a, heldAt: T0 + 7, deadline: T0 + 7 + 50_000 })
      expect(d.state.held).toEqual([d.held])
      expect(d.state.mode).toBe('unlocked')
      expect(s.held).toEqual([]) // pure: the input is not mutated
    }
  })

  test('more than MAX_HELD waiting is refused in words, never queued forever', () => {
    let s = unlocked()
    for (let i = 0; i < MAX_HELD; i++) {
      const d = decideGate(s, { action: 'click', isRead: false, now: T0, holdMs: 50_000, id: `h${i}` })
      if (d.kind !== 'hold') throw new Error('expected hold')
      s = d.state
    }
    const d = decideGate(s, { action: 'click', isRead: false, now: T0, holdMs: 50_000, id: 'last' })
    expect(d.kind).toBe('refuse')
    if (d.kind === 'refuse') {
      expect(d.answer).toMatchObject({ ok: false, performed: false, error: 'person_driving' })
      expect(String(d.answer.sentence)).toContain('agentistics_browser_wait_unlock')
    }
  })
})

describe('the deadline', () => {
  test('a held action whose deadline passed is answered "not done" with the wait tool named; boundary = expired', () => {
    const d = decideGate(unlocked(T0), { action: 'click', isRead: false, now: T0, holdMs: 50_000, id: 'a' })
    if (d.kind !== 'hold') throw new Error('hold')
    expect(expireHeld(d.state, T0 + 49_999).expired).toEqual([])
    const r = expireHeld(d.state, T0 + 50_000)
    expect(r.state.held).toEqual([])
    expect(r.expired).toHaveLength(1)
    expect(r.expired[0]!.id).toBe('a')
    expect(r.expired[0]!.answer).toMatchObject({ ok: false, performed: false, error: 'person_driving' })
    expect(String(r.expired[0]!.answer.sentence)).toContain('Your action was not done')
    expect(String(r.expired[0]!.answer.sentence)).toContain('agentistics_browser_wait_unlock')
  })

  test('only the passed ones expire; the next deadline is the earliest still pending', () => {
    let s = unlocked(T0)
    for (const [id, hold] of [['a', 10_000], ['b', 30_000], ['c', 20_000]] as const) {
      const d = decideGate(s, { action: 'type', isRead: false, now: T0, holdMs: hold, id })
      if (d.kind !== 'hold') throw new Error('hold')
      s = d.state
    }
    expect(nextDeadline(s)).toBe(T0 + 10_000)
    const r = expireHeld(s, T0 + 20_000)
    expect(r.expired.map(e => e.id)).toEqual(['a', 'c'])
    expect(nextDeadline(r.state)).toBe(T0 + 30_000)
    expect(nextDeadline(initialLock(T0))).toBeNull()
  })

  test('the sentence says how long it has been unlocked', () => {
    const s = unlocked(T0)
    const d = decideGate(s, { action: 'click', isRead: false, now: T0 + 3 * 60_000, holdMs: 50_000, id: 'a' })
    if (d.kind !== 'hold') throw new Error('hold')
    const r = expireHeld(d.state, T0 + 3 * 60_000 + 50_000)
    expect(r.expired[0]!.answer).toMatchObject({ unlockedForMinutes: 3 })
    expect(String(r.expired[0]!.answer.sentence)).toContain('unlocked 3 min ago')
  })
})

describe('changing the padlock', () => {
  test('ONLY the person: any session identity is refused, in both directions, before anything else', () => {
    for (const lock of ['locked', 'unlocked', 'bogus']) {
      for (const owner of ['abc', 'personal', null]) {
        const d = decideLockRequest({ carriesSession: true, owner, lock })
        expect(d).toMatchObject({ ok: false, status: 403, error: 'session_cannot_unlock' })
      }
    }
  })

  test('the person: a session owner and a valid mode pass; the personal browser has no padlock; bad input is 400', () => {
    expect(decideLockRequest({ carriesSession: false, owner: 'abc123', lock: 'unlocked' })).toEqual({ ok: true, managedId: 'abc123', mode: 'unlocked' })
    expect(decideLockRequest({ carriesSession: false, owner: { kind: 'session', managedId: 'abc' }, lock: 'locked' })).toEqual({ ok: true, managedId: 'abc', mode: 'locked' })
    expect(decideLockRequest({ carriesSession: false, owner: 'personal', lock: 'locked' })).toMatchObject({ ok: false, status: 400, error: 'personal_has_no_lock' })
    expect(decideLockRequest({ carriesSession: false, owner: { kind: 'personal' }, lock: 'locked' })).toMatchObject({ error: 'personal_has_no_lock' })
    expect(decideLockRequest({ carriesSession: false, owner: '../x', lock: 'locked' })).toMatchObject({ status: 400, error: 'bad_owner' })
    expect(decideLockRequest({ carriesSession: false, owner: undefined, lock: 'locked' })).toMatchObject({ status: 400, error: 'bad_owner' })
    expect(decideLockRequest({ carriesSession: false, owner: 'abc', lock: 'open' })).toMatchObject({ status: 400, error: 'bad_lock' })
  })

  test('a browser starts LOCKED (the model drives); setting the mode it has is a no-op', () => {
    const s = initialLock(T0)
    expect(s.mode).toBe('locked')
    expect(setMode(s, { mode: 'locked', now: T0 + 1, by: 'person' })).toEqual({ state: s, changed: false, released: [] })
    const u = unlocked(T0)
    expect(setMode(u, { mode: 'unlocked', now: T0 + 5, by: 'person' })).toEqual({ state: u, changed: false, released: [] })
  })

  test('locking releases EVERY held action as "not done, the page may have changed — snapshot" (a normal answer)', () => {
    let s = unlocked(T0)
    for (const a of ACTIONS) {
      const d = decideGate(s, { action: a, isRead: false, now: T0, holdMs: 50_000, id: a })
      if (d.kind === 'hold') s = d.state
    }
    const later = T0 + 4 * 60_000
    const r = setMode(s, { mode: 'locked', now: later, by: 'person', page: { title: 'Login', url: 'http://localhost:5173/login' } })
    expect(r.changed).toBe(true)
    expect(r.state.mode).toBe('locked')
    expect(r.state.held).toEqual([])
    expect(r.state.autoLockedAt).toBeNull()
    expect(r.released.map(x => x.id)).toEqual(ACTIONS.slice(0, MAX_HELD))
    for (const x of r.released) {
      expect(x.answer).toMatchObject({ ok: true, performed: false, reason: 'person_returned' })
      const s1 = String(x.answer.sentence)
      expect(s1).toContain(`from ${hhmm(T0)} to ${hhmm(later)}`)
      expect(s1).toContain('Login — http://localhost:5173/login')
      expect(s1).toContain('agentistics_browser_snapshot')
      expect(s1).toContain('NOT done')
    }
  })

  test('an unknown page is said as unknown, never invented', () => {
    const r = setMode(unlocked(T0), { mode: 'locked', now: T0, by: 'person' })
    expect(r.released).toEqual([])
    const d = decideGate(unlocked(T0), { action: 'click', isRead: false, now: T0, holdMs: 1000, id: 'a' })
    if (d.kind !== 'hold') throw new Error('hold')
    expect(String(setMode(d.state, { mode: 'locked', now: T0, by: 'person' }).released[0]!.answer.sentence)).toContain('(now: unknown)')
  })

  test('the auto-lock records when; the next person change clears it', () => {
    const r = setMode(unlocked(T0), { mode: 'locked', now: T0 + 9, by: 'auto' })
    expect(r.state.autoLockedAt).toBe(T0 + 9)
    expect(setMode(r.state, { mode: 'unlocked', now: T0 + 10, by: 'person' }).state.autoLockedAt).toBeNull()
  })
})

describe('auto-lock — unlocked and forgotten', () => {
  test('15 min since unlocking with nobody watching locks; a viewer or a recent input keeps it open', () => {
    const s = unlocked(T0)
    expect(autoLockDue(s, { now: T0 + AUTO_LOCK_MS - 1, viewers: 0 })).toBe(false)
    expect(autoLockDue(s, { now: T0 + AUTO_LOCK_MS, viewers: 0 })).toBe(true)
    expect(autoLockDue(s, { now: T0 + AUTO_LOCK_MS * 3, viewers: 1 })).toBe(false)
    const touched = notePersonInput(s, T0 + 10 * 60_000)
    expect(autoLockDue(touched, { now: T0 + AUTO_LOCK_MS, viewers: 0 })).toBe(false)
    expect(autoLockDue(touched, { now: T0 + 10 * 60_000 + AUTO_LOCK_MS, viewers: 0 })).toBe(true)
    expect(autoLockDue(initialLock(T0), { now: T0 + AUTO_LOCK_MS * 9, viewers: 0 })).toBe(false)
    expect(notePersonInput(initialLock(T0), T0 + 5)).toEqual(initialLock(T0))
  })
})

describe('the browser stops', () => {
  test('every held action is released "not done", and the padlock is locked again', () => {
    const d = decideGate(unlocked(T0), { action: 'navigate', isRead: false, now: T0, holdMs: 50_000, id: 'n' })
    if (d.kind !== 'hold') throw new Error('hold')
    const r = onBrowserStopped(d.state, { now: T0 + 1, reason: 'idle' })
    expect(r.state).toEqual(initialLock(T0 + 1))
    expect(r.released).toEqual([{ id: 'n', answer: expect.objectContaining({ ok: false, performed: false, error: 'browser_closed' }) }])
    expect(String(r.released[0]!.answer.sentence)).toContain('(idle)')
  })
})

describe('wait_unlock', () => {
  test('locked: answers at once that the browser is the model\'s', () => {
    expect(decideWait(initialLock(T0), { now: T0, maxMs: 60_000, holdMs: 50_000 })).toMatchObject({ kind: 'now', answer: { ok: true, locked: true, waitedMs: 0 } })
    const auto = setMode(unlocked(T0), { mode: 'locked', now: T0 + 5, by: 'auto' }).state
    const d = decideWait(auto, { now: T0 + 6, maxMs: undefined, holdMs: 50_000 })
    expect(d.kind === 'now' && String(d.answer.sentence)).toContain('closed by itself')
  })

  test('unlocked: waits, clamped to [1 s, holdMs] — never past its own harness\'s timeout', () => {
    const s = unlocked(T0)
    expect(decideWait(s, { now: T0, maxMs: undefined, holdMs: 50_000 })).toEqual({ kind: 'wait', deadline: T0 + 50_000 })
    expect(decideWait(s, { now: T0, maxMs: 600_000, holdMs: 50_000 })).toEqual({ kind: 'wait', deadline: T0 + 50_000 })
    expect(decideWait(s, { now: T0, maxMs: 2_500.7, holdMs: 50_000 })).toEqual({ kind: 'wait', deadline: T0 + 2_500 })
    expect(decideWait(s, { now: T0, maxMs: -5, holdMs: 50_000 })).toEqual({ kind: 'wait', deadline: T0 + HOLD_MIN_MS })
    expect(decideWait(s, { now: T0, maxMs: 'soon', holdMs: 50_000 })).toEqual({ kind: 'wait', deadline: T0 + 50_000 })
    expect(decideWait(s, { now: T0, maxMs: Number.NaN, holdMs: 50_000 })).toEqual({ kind: 'wait', deadline: T0 + 50_000 })
  })

  test('the two endings say different things', () => {
    const back = waitReturnedAnswer(T0, T0 + 120_000, 30_000, { title: 'Shop', url: 'http://x/' })
    expect(back).toMatchObject({ ok: true, locked: true, waitedMs: 30_000 })
    expect(String(back.sentence)).toContain('agentistics_browser_snapshot')
    const still = waitTimedOutAnswer(unlocked(T0), T0 + 2 * 60_000, 50_000)
    expect(still).toMatchObject({ ok: true, locked: false, waitedMs: 50_000, unlockedForMinutes: 2 })
    expect(String(still.sentence)).toContain('still using')
  })
})
