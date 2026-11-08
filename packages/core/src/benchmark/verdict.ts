/**
 * The one verdict function. Four outcomes: pays / does_not_pay / tie / insufficient.
 *
 * Question asked about a PAIR of arms (candidate vs reference, both required, no default). The
 * result is the exact mirror when the two are swapped (pays ↔ does_not_pay). The code never looks
 * at an arm id or label except to tell the two apart.
 *
 * Primary measure: cost per accepted delivery (CPA). Margin of practical equivalence is
 * log-symmetric: the candidate is cheaper when the whole interval is below 1/(1+delta), dearer
 * when above 1+delta. (A linear 1−delta would not mirror: the mirror of 0.9 is 1/0.9.)
 */
import type { CpaSample, SizeBucket, VerdictResult } from './contract'
import { bootstrapRatio } from './stats'

export const MIN_SAMPLE = { tasks: 8, repsPerTask: 2, acceptedPerArm: 5 } as const
export const DEFAULT_DELTA = 0.1
export const DEFAULT_RESAMPLES = 10_000
export const SCOPE_NOTE = 'Em custo por entrega aceita; não inclui o contexto acumulado de um líder longo.'

/** A run reduced to what the verdict reads; optional fields feed only the secondary figures. */
export interface VerdictSample extends CpaSample {
  wallMs?: number | null
  /** Defects found by the evaluator + hidden tests; null = not evaluated. */
  defects?: number | null
  humanInterventions?: number | null
  /** Per harness: sessions the run opened and how many of them are priced. */
  harnesses?: Record<string, { sessions: number; withCost: number }>
}

export interface VerdictInput {
  samples: readonly VerdictSample[]
  candidate: string
  reference: string
  size: SizeBucket
  delta?: number
  seed: number
  resamples?: number
  /** The experiment stopped on its cost cap; cells skipped. The verdict is then insufficient with this reason. */
  cap?: { skippedCells: number } | null
}

const mean = (v: readonly number[]): number | null => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null)
const pct = (x: number): string => `${Math.round(x * 100)}%`

export function verdict(input: VerdictInput): VerdictResult {
  const { candidate, reference, size } = input
  if (!candidate || !reference || candidate === reference) {
    throw new Error('verdict needs two different arms: candidate and reference')
  }
  const delta = input.delta ?? DEFAULT_DELTA
  const resamples = input.resamples ?? DEFAULT_RESAMPLES
  const arms = [candidate, reference]
  const pair = input.samples.filter(s => arms.includes(s.armId))

  // Tasks that have enough repetitions in BOTH arms form the paired design.
  const perTask = new Map<string, { c: number; r: number }>()
  for (const s of pair) {
    const e = perTask.get(s.taskId) ?? { c: 0, r: 0 }
    if (s.armId === candidate) e.c++; else e.r++
    perTask.set(s.taskId, e)
  }
  const goodTasks = new Set([...perTask].filter(([, e]) => e.c >= MIN_SAMPLE.repsPerTask && e.r >= MIN_SAMPLE.repsPerTask).map(([id]) => id))
  const used = pair.filter(s => goodTasks.has(s.taskId))
  const runsOf = (arm: string) => used.filter(s => s.armId === arm)
  const accOf = (arm: string) => runsOf(arm).filter(s => s.accepted).length
  const unmeasured = used.filter(s => s.costUSD === null).length

  const secondary: VerdictResult['secondary'] = { acceptRate: {}, wallPerAccepted: {}, defectsPerRun: {}, humanInterventions: {} }
  const coverage: VerdictResult['coverage'] = {}
  for (const arm of arms) {
    const rs = runsOf(arm)
    const acc = rs.filter(s => s.accepted)
    secondary.acceptRate[arm] = rs.length ? acc.length / rs.length : null
    const walls = rs.map(s => s.wallMs).filter((x): x is number => typeof x === 'number')
    secondary.wallPerAccepted[arm] = acc.length && walls.length === rs.length ? walls.reduce((a, b) => a + b, 0) / acc.length : null
    const defs = rs.map(s => s.defects).filter((x): x is number => typeof x === 'number')
    secondary.defectsPerRun[arm] = defs.length === rs.length ? mean(defs) : null
    const hi = rs.map(s => s.humanInterventions).filter((x): x is number => typeof x === 'number')
    secondary.humanInterventions[arm] = rs.length && hi.length === rs.length ? mean(hi) : null
  }
  for (const s of used) for (const [h, c] of Object.entries(s.harnesses ?? {})) {
    const e = coverage[h] ?? { sessions: 0, withCost: 0 }
    e.sessions += c.sessions; e.withCost += c.withCost
    coverage[h] = e
  }

  const base = {
    candidate, reference, size, delta, seed: input.seed, resamples,
    sample: {
      tasks: goodTasks.size,
      runsCandidate: runsOf(candidate).length, runsReference: runsOf(reference).length,
      acceptedCandidate: accOf(candidate), acceptedReference: accOf(reference), unmeasured,
    },
    minimum: { ...MIN_SAMPLE },
    secondary, coverage,
  }
  const insufficient = (reason: string, ratio: VerdictResult['ratio'] = { point: null, lo: null, hi: null }): VerdictResult =>
    ({ ...base, verdict: 'insufficient', ratio, reason: `${reason} ${SCOPE_NOTE}` })

  if (input.cap) return insufficient(`O experimento parou no limite de custo; ${input.cap.skippedCells} execuções não rodaram.`)
  if (goodTasks.size < MIN_SAMPLE.tasks) {
    const more = MIN_SAMPLE.tasks - goodTasks.size
    return insufficient(`Faltam ${more} tarefa${more > 1 ? 's' : ''} (mínimo ${MIN_SAMPLE.tasks}, cada uma com ${MIN_SAMPLE.repsPerTask}+ repetições por braço).`)
  }
  const okAcc = (n: number) => n >= MIN_SAMPLE.acceptedPerArm || n === 0
  const accC = accOf(candidate), accR = accOf(reference)
  if (!okAcc(accC) || !okAcc(accR) || (accC === 0 && accR === 0)) {
    return insufficient(`Poucas entregas aceitas (${candidate}: ${accC} de ${runsOf(candidate).length}; ${reference}: ${accR} de ${runsOf(reference).length}); o mínimo é ${MIN_SAMPLE.acceptedPerArm} por braço.`)
  }
  if (unmeasured > 0) return insufficient(`Custo ausente em ${unmeasured} execuç${unmeasured > 1 ? 'ões' : 'ão'}.`)

  const b = bootstrapRatio(used, candidate, reference, input.seed, resamples)
  const ratio = {
    point: Number.isNaN(b.logPoint) ? null : Math.exp(b.logPoint),
    lo: Number.isNaN(b.logLo) ? null : Math.exp(b.logLo),
    hi: Number.isNaN(b.logHi) ? null : Math.exp(b.logHi),
  }
  if (Number.isNaN(b.logLo) || Number.isNaN(b.logHi)) return insufficient('Não foi possível calcular a razão de custo.', ratio)

  const zeroNote = accC === 0 ? ` ${candidate} aceitou 0 de ${runsOf(candidate).length}.` : accR === 0 ? ` ${reference} aceitou 0 de ${runsOf(reference).length}.` : ''
  const m = Math.log(1 + delta)
  const range = ratio.lo !== null && ratio.hi !== null ? ` (intervalo ${ratio.lo.toFixed(2)}–${Number.isFinite(ratio.hi) ? ratio.hi.toFixed(2) : '∞'}, margem ${pct(delta)})` : ''
  const mk = (v: VerdictResult['verdict'], text: string): VerdictResult => ({ ...base, verdict: v, ratio, reason: `${text}${range}${zeroNote} ${SCOPE_NOTE}` })
  if (b.logHi < -m) return mk('pays', 'Compensa em custo por entrega aceita: o candidato custa menos por entrega.')
  if (b.logLo > m) return mk('does_not_pay', 'Não compensa em custo por entrega aceita: o candidato custa mais por entrega.')
  if (b.logLo >= -m && b.logHi <= m) return mk('tie', 'Empate em custo por entrega aceita: diferença dentro da margem.')

  // Straddles a boundary: how many more tasks would it take (half-width shrinks with 1/√tasks)?
  let more = ''
  if (Number.isFinite(b.logPoint) && Number.isFinite(b.logLo) && Number.isFinite(b.logHi)) {
    const p = b.logPoint
    const hw = p < -m ? b.logHi - p : p > m ? p - b.logLo : Math.max(b.logHi - p, p - b.logLo)
    const need = p < -m ? -m - p : p > m ? p - m : Math.min(m - p, p + m)
    if (need > 0 && hw > need) {
      const extra = Math.ceil(goodTasks.size * ((hw / need) ** 2 - 1))
      more = ` Cerca de ${extra} tarefas a mais estreitariam o suficiente.`
    }
  }
  return mk('insufficient', `Os dados ainda não separam os braços: o intervalo cruza a margem.${more}`)
}
