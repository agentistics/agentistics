/**
 * The observed comparisons, built ONCE on the server (HTTP and the MCP tool carry them; the screen only
 * renders). PURE: the history's subtask rows in, ratios out. Two groups of pieces are set against each other
 * only WITHIN a size (S / M / L), and only where both sides have enough pieces; the multiplier is the
 * n-weighted geometric mean of the per-size ratios, and each per-size pair is returned with its own n, so a
 * reader can check every pair against the multiplier (with one size they are the same number).
 * Observed and biased: hard pieces go to the heavy path. No verdict here.
 */
import { percentile } from '../deliveryMetrics'
import type { HistorySubtaskRow, PieceSize } from './history'

/** A size counts for a comparison only when BOTH sides have at least this many measured pieces of it. */
export const GROUP_MIN = 3

export interface SizePair { size: PieceSize; medA: number; medB: number; nA: number; nB: number }
export interface Compared {
  /** Weighted geometric mean over the sizes of (median B / median A). */
  ratio: number
  /** The per-size medians the ratio is made of; the pooled median pair is deliberately NOT carried. */
  sizes: SizePair[]
}
export interface HistoryComparison {
  /** Not `id`: the MCP tool strips every `id` key from the history, and this one is not an identifier of work. */
  key: 'qa' | 'sessions'
  nA: number; nB: number
  cost: Compared | null; wall: Compared | null
  /** QA comparison: how many more sessions; sessions comparison: the rework rate of each side. */
  third: { kind: 'sessions'; sessions: Compared | null } | { kind: 'rework'; rateA: number | null; rateB: number | null }
}

const med = (v: number[]) => percentile(v, 0.5)

function matched(subs: readonly HistorySubtaskRow[], inA: (s: HistorySubtaskRow) => boolean, inB: (s: HistorySubtaskRow) => boolean, val: (s: HistorySubtaskRow) => number | null): Compared | null {
  const sizes: SizePair[] = [], per: { r: number; w: number }[] = []
  for (const size of ['S', 'M', 'L'] as const) {
    const a = subs.filter(s => s.size === size && inA(s)).map(val).filter((v): v is number => v !== null)
    const b = subs.filter(s => s.size === size && inB(s)).map(val).filter((v): v is number => v !== null)
    if (a.length < GROUP_MIN || b.length < GROUP_MIN) continue
    const medA = med(a)!, medB = med(b)!
    if (!(medA > 0) || !(medB > 0)) continue
    sizes.push({ size, medA, medB, nA: a.length, nB: b.length })
    per.push({ r: medB / medA, w: a.length + b.length })
  }
  if (!sizes.length) return null
  const w = per.reduce((x, p) => x + p.w, 0)
  const ratio = per.length === 1 ? per[0]!.r : Math.exp(per.reduce((x, p) => x + p.w * Math.log(p.r), 0) / w)
  return { ratio, sizes }
}

const rate = (g: readonly HistorySubtaskRow[]): number | null => {
  const known = g.filter(s => s.reworked !== null)
  return known.length >= GROUP_MIN ? known.filter(s => s.reworked).length / known.length : null
}

/** The comparisons the history supports (none when no size has enough pieces on both sides). */
export function buildComparisons(subs: readonly HistorySubtaskRow[]): HistoryComparison[] {
  const mk = (key: 'qa' | 'sessions', inA: (s: HistorySubtaskRow) => boolean, inB: (s: HistorySubtaskRow) => boolean): HistoryComparison | null => {
    const A = subs.filter(inA), B = subs.filter(inB)
    const cost = matched(subs, inA, inB, s => s.costUSD), wall = matched(subs, inA, inB, s => s.wallMs)
    if (!cost && !wall) return null
    const third: HistoryComparison['third'] = key === 'qa'
      ? { kind: 'sessions', sessions: matched(subs, inA, inB, s => s.sessions) }
      : { kind: 'rework', rateA: rate(A), rateB: rate(B) }
    return { key, nA: A.length, nB: B.length, cost, wall, third }
  }
  return [
    mk('qa', s => s.qaRounds === 1, s => s.qaRounds !== null && s.qaRounds >= 2),
    mk('sessions', s => s.sessions === 1, s => s.sessions >= 5),
  ].filter((c): c is HistoryComparison => c !== null)
}
