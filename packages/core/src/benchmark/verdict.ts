/**
 * The one verdict function. Four outcomes: pays / does_not_pay / tie / insufficient.
 *
 * Question asked about a PAIR of arms (candidate vs reference, both required, no default). Method v1
 * (DECISAO-PESOS.md): the verdict comes from the interval of the SCORE (score.ts) — `pays` if the
 * whole interval is above 52, `does_not_pay` if below 48, else `tie`. Too little data wins over all
 * of it (`insufficient`). The cost ratio (cost per accepted delivery) stays as evidence in `ratio`.
 *
 * Swapping the arms mirrors the result exactly (finals add to 100), gate included: the gate is
 * symmetric — it blocks whichever side the score would declare the winner when that side accepted
 * fewer runs than the other beyond the margin.
 * The code never looks at an arm id or label except to tell the two apart.
 */
import type { SizeBucket, VerdictResult } from './contract'
import { computeScore, verdictOfScore, type RunSample } from './score'
import { bootstrapRatio } from './stats'

export const MIN_SAMPLE = { tasks: 8, repsPerTask: 2, acceptedPerArm: 5 } as const
export const DEFAULT_DELTA = 0.1
export const DEFAULT_RESAMPLES = 10_000
export const SCOPE_NOTE = 'Não inclui o contexto acumulado de um líder longo.'

/** A run reduced to what the verdict reads; optional fields feed the score and the secondary figures. */
export interface VerdictSample extends RunSample {
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
const n1 = (x: number | null): string => (x === null ? '—' : Number.isFinite(x) ? x.toFixed(2) : '∞')

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
    candidate, reference, size, delta, seed: input.seed, resamples, methodVersion: 'v1' as const,
    sample: {
      tasks: goodTasks.size,
      runsCandidate: runsOf(candidate).length, runsReference: runsOf(reference).length,
      acceptedCandidate: accOf(candidate), acceptedReference: accOf(reference), unmeasured,
    },
    minimum: { ...MIN_SAMPLE },
    secondary, coverage,
  }
  const noRatio = { point: null, lo: null, hi: null }
  const insufficient = (reason: string, ratio: VerdictResult['ratio'] = noRatio, score: VerdictResult['score'] = null): VerdictResult =>
    ({ ...base, verdict: 'insufficient', score, ratio, reason: `${reason} ${SCOPE_NOTE}` })

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

  // Evidence: the cost-per-accepted ratio and its interval.
  const b = bootstrapRatio(used, candidate, reference, input.seed, resamples)
  const ratio = {
    point: Number.isNaN(b.logPoint) ? null : Math.exp(b.logPoint),
    lo: Number.isNaN(b.logLo) ? null : Math.exp(b.logLo),
    hi: Number.isNaN(b.logHi) ? null : Math.exp(b.logHi),
  }
  const score = computeScore({ samples: used, candidate, reference, seed: input.seed, resamples, delta })
  if (score.final.value === null || score.final.lo === null || score.final.hi === null) {
    return insufficient(score.final.nullReason ?? 'Não foi possível calcular a nota.', ratio, score)
  }

  const f = score.final
  const costLine = `Custo: ${n1(ratio.point)}× o custo por entrega aceita do outro lado (menor é melhor para o candidato; intervalo ${n1(ratio.lo)}–${n1(ratio.hi)}).`
  const zeroNote = accC === 0 ? ` ${candidate} aceitou 0 de ${runsOf(candidate).length}.` : accR === 0 ? ` ${reference} aceitou 0 de ${runsOf(reference).length}.` : ''
  const sens = score.sensitivity.result === 'firm' ? ' Resultado firme com outros pesos.' : score.sensitivity.result === 'depends_on_weights' ? ' Depende dos pesos.' : ''
  const head = `Nota ${f.display} de 100 (margem ${Math.round(f.lo!)}–${Math.round(f.hi!)}; 50 é empate).`
  const mk = (v: VerdictResult['verdict'], text: string): VerdictResult =>
    ({ ...base, verdict: v, score, ratio, reason: `${text} ${head} ${costLine}${zeroNote}${sens} ${SCOPE_NOTE}` })

  const v = scoreVerdict(score)
  if (v === 'pays') return mk('pays', 'Compensou.')
  if (v === 'does_not_pay') return mk('does_not_pay', 'Não compensou.')
  const rc = accC / runsOf(candidate).length, rr = accR / runsOf(reference).length
  const blocked = score.gateBlocked
    ? ` O lado que levaria a melhor aceitou menos entregas (${rc < rr ? candidate : reference}: ${pct(Math.min(rc, rr))} contra ${pct(Math.max(rc, rr))}); sem "Compensou" nem "Não compensou" nesse caso.`
    : ''
  return mk('tie', `Empate: não dá para cravar.${blocked}`)
}

/** Verdict of the main (method v1) weights: the score's own interval, after the gate. */
function scoreVerdict(score: NonNullable<VerdictResult['score']>): VerdictResult['verdict'] {
  const { lo, hi } = score.final
  if (lo === null || hi === null) return 'insufficient'
  const v = verdictOfScore(lo, hi)
  return score.gateBlocked ? 'tie' : v
}
