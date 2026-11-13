/**
 * delivery/guard-locks.ts — the ONE way to hold the board/delivery/guard locks (spec §2.6.1).
 *
 * `tasks.json`, `deliveries.json` and `guards.json` each keep their own cross-process file lock. Every writer
 * acquires them in ONE global order — tasks → deliveries → guards — and takes every lock the operation needs
 * BEFORE reading any of the three documents. A writer that needs only deliveries + guards may skip tasks but may
 * not take it afterwards; one that discovers it needs the board releases everything and restarts from `tasks`.
 *
 * FAIL CLOSED. `file-lock.ts`'s ordinary `withFileLock` goes ahead WITHOUT the lock after its wait (a lost label
 * is a smaller harm than a session with no record). A guard must never do that: a write is never persisted
 * without its guard because a lock was slow. So this helper treats a contended acquisition as a refusal — it
 * releases whatever it already holds, runs nothing and throws `GuardBusy` (`guard_busy`, 409). A tick or a sweep
 * passes `onBusy: 'skip'` and gets `{ skipped: 'guard_busy' }` back instead (they skip the tick, never proceed
 * unguarded).
 *
 * The locks are directory locks and NOT reentrant, so nesting is tracked per async context: a nested call that
 * asks for a lock already held, or one EARLIER than something held, is a programming error (`GuardLockOrderError`)
 * thrown before any lock is touched. `alreadyHeld` names locks the caller holds through another path — the board
 * hook inside `task-store.write()` already holds `tasks` — and they are not re-taken.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { join } from 'node:path'
import { lockFile, type LockHandle } from '../sessions/file-lock'

export const GUARD_LOCK_ORDER = ['tasks', 'deliveries', 'guards'] as const
export type GuardLockName = (typeof GUARD_LOCK_ORDER)[number]
export type GuardLockPaths = Record<GuardLockName, string>

/** Each acquisition waits at most this long (spec §2.6.1). */
export const GUARD_WAIT_MS = 5000

export class GuardBusy extends Error {
  readonly code = 'guard_busy'
  readonly status = 409
  constructor(readonly lock: GuardLockName) {
    super(`another agentop process is writing the board (${lock} is busy); retry`)
  }
}

export class GuardLockOrderError extends Error {
  readonly code = 'lock_order'
  constructor(why: string) { super(`lock order violation: ${why} (global order: ${GUARD_LOCK_ORDER.join(' → ')})`) }
}

export function defaultGuardLockPaths(dataDir = process.env.AGENTISTICS_DIR ?? join(process.env.HOME ?? '', '.agentistics')): GuardLockPaths {
  return {
    tasks: process.env.AGENTISTICS_TASKS_FILE ?? join(dataDir, 'tasks.json'),
    deliveries: process.env.AGENTISTICS_DELIVERIES_FILE ?? join(dataDir, 'deliveries.json'),
    guards: join(dataDir, 'guards.json'),
  }
}

export interface GuardLockOptions {
  paths?: GuardLockPaths
  waitMs?: number
  /** Locks the caller already holds by another route (e.g. `tasks` inside task-store's write). Not re-taken. */
  alreadyHeld?: readonly GuardLockName[]
  /** `throw` (default): `GuardBusy`. `skip`: resolve `{ skipped: 'guard_busy' }` — for the tick and the sweep. */
  onBusy?: 'throw' | 'skip'
}

const heldHere = new AsyncLocalStorage<readonly GuardLockName[]>()
const rank = (n: GuardLockName) => GUARD_LOCK_ORDER.indexOf(n)

function assertOrder(names: readonly GuardLockName[], alreadyHeld: readonly GuardLockName[]): void {
  for (let i = 1; i < names.length; i++) {
    if (rank(names[i]!) <= rank(names[i - 1]!)) throw new GuardLockOrderError(`${names[i]} requested after ${names[i - 1]}`)
  }
  const outer = heldHere.getStore() ?? []
  const maxHeld = Math.max(-1, ...outer.map(rank), ...alreadyHeld.map(rank))
  for (const n of names) {
    if (rank(n) <= maxHeld) throw new GuardLockOrderError(`${n} requested while holding ${GUARD_LOCK_ORDER[maxHeld]}`)
  }
}

export async function withGuardLocks<T>(
  names: readonly GuardLockName[],
  fn: () => Promise<T>,
  opts: GuardLockOptions & { onBusy: 'skip' },
): Promise<T | { skipped: 'guard_busy' }>
export async function withGuardLocks<T>(names: readonly GuardLockName[], fn: () => Promise<T>, opts?: GuardLockOptions): Promise<T>
export async function withGuardLocks<T>(names: readonly GuardLockName[], fn: () => Promise<T>, opts: GuardLockOptions = {}): Promise<T | { skipped: 'guard_busy' }> {
  const paths = opts.paths ?? defaultGuardLockPaths()
  const already = opts.alreadyHeld ?? []
  // `alreadyHeld` is a claim about the caller's own position: it may only name locks EARLIER than what we ask for.
  for (const h of already) for (const n of names) {
    if (rank(h) > rank(n)) throw new GuardLockOrderError(`${h} is held while ${n} is requested`)
  }
  const toTake = names.filter(n => !already.includes(n))
  assertOrder(names, [])
  assertOrder(toTake, already)
  const taken: LockHandle[] = []
  const releaseAll = async () => { for (const h of taken.reverse()) await h.release() }
  for (const n of toTake) {
    const h = await lockFile(paths[n], () => Date.now(), opts.waitMs ?? GUARD_WAIT_MS)
    if (h.contended) {
      await releaseAll()
      if (opts.onBusy === 'skip') return { skipped: 'guard_busy' }
      throw new GuardBusy(n)
    }
    taken.push(h)
  }
  try {
    return await heldHere.run([...(heldHere.getStore() ?? []), ...names], fn)
  } finally {
    await releaseAll()
  }
}
