/**
 * browser-lock-host.ts — the padlock's MEMORY (NAVEGADOR S3): one `LockState` per session browser, the
 * timers of the held actions and the promises the held calls and `wait_unlock` callers are waiting on.
 *
 * Every decision is `browser-lock.ts`'s (pure); this module only keeps state and wakes promises. It is in
 * memory on purpose: a padlock is a fact about a LIVE browser, and a restart (which kills every browser)
 * starts every session locked again — the default, and the safe side.
 *
 * `ActionGate` is the route's hook (`browser-web.ts`): a held action's promise resolves with a result the
 * route returns as is, and the action itself is never run.
 */

import type { BrowserAction } from './browser-action-spec'
import {
  autoLockDue, decideGate, decideWait, expireHeld, initialLock, nextDeadline, notePersonInput, onBrowserStopped,
  setMode, waitReturnedAnswer, waitTimedOutAnswer,
  type LockAnswer, type LockMode, type LockState, type PageFacts,
} from './browser-lock'

type Timer = unknown

export interface LockHostDeps {
  now: () => number
  setTimer: (fn: () => void, ms: number) => Timer
  clearTimer: (t: Timer) => void
}

interface Waiter { startedAt: number; resolve: (a: LockAnswer) => void; timer: Timer }

export interface LockView { mode: LockMode; since: number; held: number; waiting: number; autoLockedAt: number | null }

export class BrowserLocks {
  private states = new Map<string, LockState>()
  private pending = new Map<string, (a: LockAnswer) => void>()
  private deadlineTimers = new Map<string, Timer>()
  private waiters = new Map<string, Set<Waiter>>()
  private seq = 0

  constructor(private readonly d: LockHostDeps) {}

  private state(key: string): LockState {
    let s = this.states.get(key)
    if (!s) { s = initialLock(this.d.now()); this.states.set(key, s) }
    return s
  }

  view(key: string): LockView {
    const s = this.state(key)
    return { mode: s.mode, since: s.since, held: s.held.length, waiting: this.waiters.get(key)?.size ?? 0, autoLockedAt: s.autoLockedAt }
  }

  /** Session keys that are unlocked right now (the auto-lock tick walks these). */
  unlockedKeys(): string[] {
    return [...this.states].filter(([, s]) => s.mode === 'unlocked').map(([k]) => k)
  }

  /** The route's gate for a session's action. A read, or a locked browser, proceeds at once. */
  async gate(key: string, action: BrowserAction, input: { isRead: boolean; holdMs: number }): Promise<{ proceed: true } | { proceed: false; result: LockAnswer }> {
    const id = `h${++this.seq}`
    const d = decideGate(this.state(key), { action, isRead: input.isRead, now: this.d.now(), holdMs: input.holdMs, id })
    if (d.kind === 'proceed') return { proceed: true }
    if (d.kind === 'refuse') return { proceed: false, result: d.answer }
    this.states.set(key, d.state)
    const result = await new Promise<LockAnswer>((resolve) => {
      this.pending.set(id, resolve)
      this.armDeadline(key)
    })
    return { proceed: false, result }
  }

  private armDeadline(key: string): void {
    const old = this.deadlineTimers.get(key)
    if (old !== undefined) this.d.clearTimer(old)
    this.deadlineTimers.delete(key)
    const next = nextDeadline(this.state(key))
    if (next === null) return
    this.deadlineTimers.set(key, this.d.setTimer(() => this.expire(key), Math.max(0, next - this.d.now())))
  }

  private expire(key: string): void {
    this.deadlineTimers.delete(key)
    const r = expireHeld(this.state(key), this.d.now())
    this.states.set(key, r.state)
    for (const e of r.expired) this.settle(e.id, e.answer)
    this.armDeadline(key)
  }

  private settle(id: string, answer: LockAnswer): void {
    const resolve = this.pending.get(id)
    this.pending.delete(id)
    resolve?.(answer)
  }

  /** The person (or the auto-lock) sets the padlock. Locking answers every held action and every waiter. */
  setLock(key: string, mode: LockMode, by: 'person' | 'auto', page?: PageFacts): { changed: boolean; view: LockView } {
    const before = this.state(key)
    const now = this.d.now()
    const r = setMode(before, { mode, now, by, page })
    this.states.set(key, r.state)
    for (const e of r.released) this.settle(e.id, e.answer)
    if (r.changed && mode === 'locked') {
      this.armDeadline(key)
      for (const w of this.takeWaiters(key)) w.resolve(waitReturnedAnswer(before.since, now, now - w.startedAt, page))
    }
    return { changed: r.changed, view: this.view(key) }
  }

  /** The person's input reached the browser (S4). */
  personInput(key: string): void {
    this.states.set(key, notePersonInput(this.state(key), this.d.now()))
  }

  /** Locks every unlocked browser nobody has touched or watched for 15 min. Returns the keys it locked. */
  autoLock(viewers: (key: string) => number, page: (key: string) => PageFacts | undefined): string[] {
    const now = this.d.now()
    const done: string[] = []
    for (const key of this.unlockedKeys()) {
      if (autoLockDue(this.state(key), { now, viewers: viewers(key) })) {
        this.setLock(key, 'locked', 'auto', page(key))
        done.push(key)
      }
    }
    return done
  }

  /** `agentistics_browser_wait_unlock`: answers when the person locks, or at the (clamped) deadline. */
  waitUnlock(key: string, maxMs: unknown, holdMs: number): Promise<LockAnswer> {
    const now = this.d.now()
    const d = decideWait(this.state(key), { now, maxMs, holdMs })
    if (d.kind === 'now') return Promise.resolve(d.answer)
    return new Promise((resolve) => {
      const set = this.waiters.get(key) ?? new Set<Waiter>()
      this.waiters.set(key, set)
      const w: Waiter = {
        startedAt: now,
        resolve,
        timer: this.d.setTimer(() => {
          set.delete(w)
          const t = this.d.now()
          resolve(waitTimedOutAnswer(this.state(key), t, t - now))
        }, d.deadline - now),
      }
      set.add(w)
    })
  }

  private takeWaiters(key: string): Waiter[] {
    const set = this.waiters.get(key)
    if (!set) return []
    this.waiters.delete(key)
    for (const w of set) this.d.clearTimer(w.timer)
    return [...set]
  }

  /** The browser stopped: everything held is answered with the reason and the padlock is locked again. */
  browserStopped(key: string, reason: string): void {
    const s = this.states.get(key)
    if (!s) return
    const now = this.d.now()
    const r = onBrowserStopped(s, { now, reason })
    this.states.set(key, r.state)
    for (const e of r.released) this.settle(e.id, e.answer)
    this.armDeadline(key)
    for (const w of this.takeWaiters(key)) {
      w.resolve({ ok: true, locked: true, waitedMs: now - w.startedAt, sentence: `This session's browser was closed (${reason}); the padlock is locked again. The next browser call opens a fresh one.` })
    }
  }
}
