/**
 * engineCapsBus — "what the engine says is on" is read once per page load (`useEngineCaps`,
 * `nativeFleet`), because it only changed with a server restart. The experimental switch
 * (the `agentop experimental` command) changes it without one, so whoever flips it calls `invalidateEngineCaps`
 * and every reader that cached the answer asks again. No fetch here — a registry of "forget" callbacks.
 */
const listeners = new Set<() => void>()

/** Register a reader's "forget what you cached and re-ask". Returns the unsubscribe. */
export function onEngineCapsInvalidated(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function invalidateEngineCaps(): void {
  for (const fn of [...listeners]) { try { fn() } catch { /* one reader failing must not stop the others */ } }
}
