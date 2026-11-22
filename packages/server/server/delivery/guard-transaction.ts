/** Explicit envelope for operations that touch the board as well as deliveries.
 * Reuse is scoped to this async operation AND these exact files; it never grants a lock based on a caller flag.
 * Ordinary withGuardLocks nesting continues to reject reentrance/order inversions.
 *
 * RULE OFF IS THE BASE (QA r2 N2, spec §2.7). `withGuardTransaction` peeks rule A first: `off` runs the operation with
 * NO envelope at all — every store inside it then takes exactly the lock the base took (`withFileLock` on its own
 * file) — while `shadow`/`on` take tasks → deliveries → guards before anything is read. A writer that peeked `off` and
 * then finds a raising write re-checks the rule under its own file lock; because the activation itself takes the full
 * envelope (`activation.ts` `setState`), a writer genuinely holding its file lock cannot interleave with the switch.
 * From `off` the only reachable state is `shadow` (`on` requires 24 h of shadow), and shadow refuses nothing.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { dirname, resolve } from 'node:path'
import { withGuardLocks, type GuardLockPaths } from './guard-locks'

const envelope = new AsyncLocalStorage<{ paths: GuardLockPaths; active: boolean; writes: Map<string, Promise<unknown>> }>()
export function inGuardTransaction(paths: GuardLockPaths): boolean {
  const held = envelope.getStore()
  return !!held?.active && (['tasks', 'deliveries', 'guards'] as const).every(k => resolve(held.paths[k]) === resolve(paths[k]))
}

/** Rule A, read without a lock: only to CHOOSE the lock set. Lazy import keeps this module free of the guard host's graph. */
export async function peekRuleA(paths: GuardLockPaths): Promise<'off' | 'shadow' | 'on'> {
  const { ruleAState } = await import('./guard-host')
  return ruleAState(dirname(paths.guards))
}

/** The full envelope, unconditionally: tasks → deliveries → guards, fail closed. */
export async function withGuardEnvelope<T>(paths: GuardLockPaths, fn: () => Promise<T>): Promise<T> {
  if (inGuardTransaction(paths)) return fn()
  return withGuardLocks(['tasks', 'deliveries', 'guards'], async () => {
    const lease = { paths, active: true, writes: new Map<string, Promise<unknown>>() }
    try { return await envelope.run(lease, fn) } finally {
      // A callback may have scheduled a store write without awaiting it. Never release its file locks mid-write.
      for (;;) {
        const tails = [...lease.writes.values()]
        await Promise.all(tails)
        const current = [...lease.writes.values()]
        if (tails.length === current.length && tails.every((p, i) => p === current[i])) break
      }
      lease.active = false
    }
  }, { paths })
}

/** A multi-store operation: the full envelope while rule A is shadow/on; with rule A off, exactly the base (no envelope). */
export async function withGuardTransaction<T>(paths: GuardLockPaths, fn: () => Promise<T>): Promise<T> {
  if (inGuardTransaction(paths)) return fn()
  if (await peekRuleA(paths) === 'off') return fn()
  return withGuardEnvelope(paths, fn)
}

/** File locks exclude other processes; this queue also excludes parallel writers sharing this envelope, across instances. */
export function serializeGuardWrite<T>(paths: GuardLockPaths, name: 'tasks' | 'deliveries', fn: () => Promise<T>): Promise<T> {
  const lease = envelope.getStore()
  if (!lease?.active || !inGuardTransaction(paths)) return fn()
  const key = resolve(paths[name])
  const next = (lease.writes.get(key) ?? Promise.resolve()).then(fn)
  lease.writes.set(key, next.catch(() => undefined))
  return next
}

/** Thrown inside a base-locked (rule-off) write that discovered the rule is no longer off: retake under the envelope. */
export class RuleNoLongerOff extends Error {
  readonly code = 'rule_changed'
  constructor() { super('rule A changed while this write held only its own file lock; it is retried under the full envelope') }
}
