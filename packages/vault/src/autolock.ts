/**
 * autolock.ts — when the HUMAN scope locks itself (SECRETS.4 §5.1). PURE: the clock is injected.
 *
 *  - default 30 min idle; configurable 5–480; there is NO "never" on the human scope (§9.13);
 *  - "idle" = no human-scope open AND no human interaction (dashboard/TUI heartbeat, any `agentop`
 *    verb). A session that keeps calling its provider counts as use — locking under a running agent
 *    turn would kill the user's own work; the target is the FORGOTTEN open vault (Q5);
 *  - the runner scope never auto-locks (Cloud rule) — it never has one of these.
 */
export const AUTO_LOCK_DEFAULT_MIN = 30
export const AUTO_LOCK_MIN = 5
export const AUTO_LOCK_MAX = 480

/** PURE. A requested idle period in minutes, or null when it is not allowed ("never", 0, out of range). */
export function parseAutoLockMinutes(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isInteger(v)) return null
  return v >= AUTO_LOCK_MIN && v <= AUTO_LOCK_MAX ? v : null
}

/** The idle clock. `due(now)` is true once nothing touched the vault for `minutes`. */
export class AutoLockClock {
  private lastUseMs: number
  constructor(private minutes: number, nowMs: number) {
    if (parseAutoLockMinutes(minutes) === null) throw new Error('auto-lock: minutes out of range')
    this.lastUseMs = nowMs
  }
  /** Any human-scope open or human interaction. */
  use(nowMs: number): void { if (nowMs > this.lastUseMs) this.lastUseMs = nowMs }
  setMinutes(m: number): void { if (parseAutoLockMinutes(m) === null) throw new Error('auto-lock: minutes out of range'); this.minutes = m }
  get periodMinutes(): number { return this.minutes }
  dueAtMs(): number { return this.lastUseMs + this.minutes * 60_000 }
  due(nowMs: number): boolean { return nowMs >= this.dueAtMs() }
  /** ms until the lock, for `status` (never negative). */
  remainingMs(nowMs: number): number { return Math.max(0, this.dueAtMs() - nowMs) }
}
