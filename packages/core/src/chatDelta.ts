/**
 * chatDelta.ts — what changed between two frames of a conversation's turns (PERF.1, live chat push).
 *
 * The chat stream sends a conversation's window of turns once, then only what changed: a turn
 * appended, the last turn grown, or the window slid forward by the turn cap. Turns carry no id, so
 * the delta is POSITIONAL against the frame the receiver already holds: drop `drop` turns from the
 * front, keep the next `keep`, then append `append`. Anything else is sent whole (`full`).
 */
export type ChatDelta =
  | { kind: 'same' }
  | { kind: 'full' }
  | { kind: 'delta'; drop: number; keep: number; append: unknown[] }

/** How far the window may have slid for a delta to be looked for (a burst of turns between frames). */
const MAX_SLIDE = 64

/** `prev` is the previous frame's turns, each as its JSON (what the sender kept). */
export function chatDelta(prev: readonly string[] | null, next: readonly unknown[]): ChatDelta {
  if (prev === null) return { kind: 'full' }
  const n = next.map(x => JSON.stringify(x))
  if (n.length === prev.length && n.every((s, i) => s === prev[i])) return { kind: 'same' }
  let best: { drop: number; keep: number } | null = null
  for (let drop = 0; drop <= Math.min(MAX_SLIDE, prev.length); drop++) {
    let keep = 0
    while (keep < n.length && drop + keep < prev.length && n[keep] === prev[drop + keep]) keep++
    // A kept run must reach the END of the old frame, or a turn in the middle changed.
    const reachesEnd = drop + keep === prev.length || (drop + keep === prev.length - 1 && keep > 0)
    if (keep > 0 && reachesEnd && (!best || keep > best.keep)) best = { drop, keep }
    if (best && best.keep === n.length) break
  }
  if (!best) return { kind: 'full' }
  return { kind: 'delta', drop: best.drop, keep: best.keep, append: next.slice(best.keep) as unknown[] }
}

export function applyChatDelta<T>(prev: readonly T[], d: { drop: number; keep: number; append: readonly unknown[] }): T[] {
  return [...prev.slice(d.drop, d.drop + d.keep), ...(d.append as T[])]
}
