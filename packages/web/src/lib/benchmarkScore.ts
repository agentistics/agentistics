/**
 * The Benchmark's 0–100 score — the approved prototype's maths (`opcao-d3.html`: `nr`, `fin`, `pontos`, `tomTipo`,
 * `vezes`, `firme`) with the decided weights (leader/metodo/DECISAO-PESOS.md). PURE and total: ratios in, points out.
 *
 * A ratio is REFERENCE ÷ CANDIDATE for "lower is better" metrics (cost, time), so a ratio above 1 always means the
 * candidate is better. `nr` maps it onto 0–100 (1 → 50) and swapping the two sides gives the exact mirror.
 * A type with no ratio is NOT MEASURED: it is left out and the weights are renormalised over the measured ones —
 * never a zero, never a guess.
 */
export type ScoreTypeKey = 'quality' | 'cost' | 'time' | 'reliability'
export type ScoreTone = 'good' | 'bad' | 'tie'
export const SCORE_TYPES: readonly ScoreTypeKey[] = ['quality', 'cost', 'time', 'reliability']

/** Maximum points of each type (the decision: quality 40, cost 30, time 20, reliability 10). */
export const WEIGHTS: Record<ScoreTypeKey, number> = { quality: 40, cost: 30, time: 20, reliability: 10 }

/** The sensitivity rows: the same score under other reasonable weights. */
export const ALT_WEIGHTS: readonly { id: 'equal' | 'quality' | 'costTime'; weights: Record<ScoreTypeKey, number> }[] = [
  { id: 'equal', weights: { quality: 25, cost: 25, time: 25, reliability: 25 } },
  { id: 'quality', weights: { quality: 55, cost: 20, time: 15, reliability: 10 } },
  { id: 'costTime', weights: { quality: 25, cost: 40, time: 25, reliability: 10 } },
]

export type Ratios = Partial<Record<ScoreTypeKey, number | null | undefined>>
const usable = (r: number | null | undefined): r is number => typeof r === 'number' && Number.isFinite(r) && r > 0

/** Ratio → 0–100 through 100 / (1 + 1/r). */
export const nr = (r: number): number => 100 / (1 + 1 / r)

/** ≥ 55.55 (a 1.25× ratio) pays, ≤ 44.45 does not, in between is a tie — the decision's band for types and tasks. */
export const scoreTone = (n: number): ScoreTone => n >= 55.55 ? 'good' : n <= 44.45 ? 'bad' : 'tie'

export interface TypeScore { ratio: number; /** 0–100 */ nr: number; /** the type's maximum AFTER renormalising over the measured types */ max: number; points: number }
/**
 * The verdict word of a whole OBSERVED comparison: the prototype's point rule (`vd(v, 0)` / `ponto`) with margin 0, because an
 * observed comparison carries no margin of error. Above 52 pays, below 48 does not, otherwise a tie (52 and 48 themselves tie).
 * The type cards and the task rows keep the 55,55 / 44,45 band of `scoreTone` (`tomTipo`).
 */
export const pointTone = (n: number, margin = 0): ScoreTone => n - margin > 52 ? 'good' : n + margin < 48 ? 'bad' : 'tie'

export interface Scored { score: number | null; types: Partial<Record<ScoreTypeKey, TypeScore>> }

export function scoreOf(ratios: Ratios, weights: Record<ScoreTypeKey, number> = WEIGHTS): Scored {
  const ks = SCORE_TYPES.filter(k => usable(ratios[k]))
  const total = ks.reduce((a, k) => a + weights[k], 0)
  if (!ks.length || total <= 0) return { score: null, types: {} }
  const exact = ks.map(k => (weights[k] / total) * nr(ratios[k] as number))
  const score = exact.reduce((a, b) => a + b, 0)
  // Whole points that add up to the whole score: floor each, hand the rest to the largest remainders.
  const pts = exact.map(Math.floor)
  let missing = Math.round(score) - pts.reduce((a, b) => a + b, 0)
  ks.map((_, i) => i).sort((p, q) => (exact[q]! - pts[q]!) - (exact[p]! - pts[p]!)).forEach(i => { if (missing > 0) { pts[i]!++; missing-- } })
  const types: Partial<Record<ScoreTypeKey, TypeScore>> = {}
  ks.forEach((k, i) => { types[k] = { ratio: ratios[k] as number, nr: nr(ratios[k] as number), max: Math.round(weights[k] / total * 100), points: pts[i]! } })
  return { score, types }
}

/** One task's own score: cost and time only (what a task row carries); null when neither could be read. */
export const taskScore = (r: { cost: number | null | undefined; time: number | null | undefined }): number | null => scoreOf({ cost: r.cost, time: r.time }).score

/** "2,5× melhor" / "2,0× pior" / "igual": the multiplier with its direction, never an inversion hidden. */
export function vezes(r: number, lang: 'pt' | 'en'): string {
  const x = r >= 1 ? r : 1 / r
  if (x < 1.03) return lang === 'pt' ? 'igual' : 'equal'
  const n = x.toFixed(1).replace('.', lang === 'pt' ? ',' : '.')
  return `${n}× ${r >= 1 ? (lang === 'pt' ? 'melhor' : 'better') : (lang === 'pt' ? 'pior' : 'worse')}`
}

/** Which alternative weightings would change the word; none = "firm". */
export function firmness(ratios: Ratios): { changes: { weights: 'equal' | 'quality' | 'costTime'; tone: ScoreTone }[] } {
  const base = scoreOf(ratios).score
  if (base === null) return { changes: [] }
  const t = scoreTone(base)
  return { changes: ALT_WEIGHTS.flatMap(a => { const s = scoreOf(ratios, a.weights).score; return s !== null && scoreTone(s) !== t ? [{ weights: a.id, tone: scoreTone(s) }] : [] }) }
}
