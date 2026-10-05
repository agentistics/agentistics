/**
 * resolveFlow — what the Resolve button shows, as a pure function of where the click is.
 *
 * Resolving used to change nothing the eye could catch: the verb went out, the page reloaded, and the
 * topic quietly changed section. So a click now has three VISIBLE moments: `working` (the verb is out),
 * `done` (the button reads "Resolved ✓" in green and the line says where the topic went — held for
 * `RESOLVED_FLASH_MS`), then the ordinary state, where a resolved topic offers "Reopen". Reopening is the
 * same verb the other way and flashes nothing.
 */
export const RESOLVED_FLASH_MS = 1800
export type ResolveView = 'resolve' | 'working' | 'done' | 'reopen'

export function resolveView(o: { resolvedAt?: string | null; pending: boolean; flashing: boolean }): ResolveView {
  if (o.flashing) return 'done'
  if (o.pending) return 'working'
  return o.resolvedAt ? 'reopen' : 'resolve'
}
