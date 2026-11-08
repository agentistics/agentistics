import type { BackendSession, ManagedSession } from './types'

/** Recent managed sessions to resolve before reading the historical conversation store. */
export const INITIAL_SESSION_LIMIT = 15

/** Keep every live pane, even when its registry stamp is older than the recent window. */
export function initialRegistry(registry: readonly ManagedSession[], backend: readonly BackendSession[], limit = INITIAL_SESSION_LIMIT): ManagedSession[] {
  const recent = [...registry].sort((a, b) => {
    const at = (r: ManagedSession) => Math.max(r.lastSeenMs ?? 0, Date.parse(r.createdAt) || 0)
    return at(b) - at(a) || (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || a.id.localeCompare(b.id)
  }).slice(0, limit)
  const ids = new Set(recent.map(r => r.id))
  for (const b of backend) if (b.alive) ids.add(b.id)
  return registry.filter(r => ids.has(r.id))
}

// Process-local marker: the existing wire snapshot keeps exactly the same shape.
const initialSnapshots = new WeakSet<object>()
export function markInitialSnapshot(snapshot: object): void { initialSnapshots.add(snapshot) }
export function isInitialSnapshot(snapshot: object): boolean { return initialSnapshots.has(snapshot) }
