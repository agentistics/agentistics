/**
 * Resolve with `fallback` when `work` has not settled within `ms` (or rejects). The new-session
 * wizard's harness list must not wait on a slow neighbour — the project search, the task list, a
 * per-harness defaults read — so each gets a budget and the list answers with what resolved.
 */
export async function bounded<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), ms) })
  try {
    return await Promise.race([work.catch(() => fallback), late])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
