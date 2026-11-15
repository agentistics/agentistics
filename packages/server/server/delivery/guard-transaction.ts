/** Explicit envelope for operations that touch the board as well as deliveries.
 * Reuse is scoped to this async operation AND these exact files; it never grants a lock based on a caller flag.
 * Ordinary withGuardLocks nesting continues to reject reentrance/order inversions.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { resolve } from 'node:path'
import { withGuardLocks, type GuardLockPaths } from './guard-locks'

const envelope = new AsyncLocalStorage<{ paths: GuardLockPaths; active: boolean; writes: Map<string, Promise<unknown>> }>()
export function inGuardTransaction(paths: GuardLockPaths): boolean {
  const held = envelope.getStore()
  return !!held?.active && (['tasks', 'deliveries', 'guards'] as const).every(k => resolve(held.paths[k]) === resolve(paths[k]))
}
export async function withGuardTransaction<T>(paths: GuardLockPaths, fn: () => Promise<T>): Promise<T> {
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

/** File locks exclude other processes; this queue also excludes parallel writers sharing this envelope, across instances. */
export function serializeGuardWrite<T>(paths: GuardLockPaths, name: 'tasks' | 'deliveries', fn: () => Promise<T>): Promise<T> {
  const lease = envelope.getStore()
  if (!lease?.active || !inGuardTransaction(paths)) return fn()
  const key = resolve(paths[name])
  const next = (lease.writes.get(key) ?? Promise.resolve()).then(fn)
  lease.writes.set(key, next.catch(() => undefined))
  return next
}
