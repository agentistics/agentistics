/**
 * Optional live burn enrichment must not hold up stored plan limits and history. The route uses
 * only a completed data build or the previous startup snapshot, never starts a build, and bounds
 * the entire live sample (including process discovery). When unavailable it sends no live sample.
 */

/** How long the route waits for session data before answering without the live burn sample. */
export const PLAN_LIMITS_DATA_WAIT_MS = 250

/** PURE-ish: `work`'s value if it settles within `ms`, else `null`. A rejection is `null` too — never a throw. */
export async function withinOrNull<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms) })
  try {
    return await Promise.race([work.catch(() => null), late])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
