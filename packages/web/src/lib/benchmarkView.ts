/**
 * The Benchmark screen's view model (the approved "D3" layout). PURE: the server's numbers in, what each
 * block draws out. Nothing is invented here: a block whose data the server does not produce comes back
 * as `null` / an empty list, and the screen says so in words.
 *
 * Two kinds of entry sit in the list on the left:
 *  - the OBSERVED HISTORY (always there, real numbers, never a verdict — hard work takes the heavy path),
 *  - one per CONTROLLED EXPERIMENT the server lists (`/api/benchmark/experiments`; none runs today).
 *    An experiment carries a core `VerdictResult` and may carry per-task rows and session buckets.
 */
import type { Compared, HistoryComparison, HistorySubtaskRow, HistoryTaskRow, Observed, ObservedHistory, ScoreType, Verdict, VerdictResult } from '@agentistics/core/benchmark'
import { percentile } from '@agentistics/core'
import { METRIC_LABEL, fmtInterval, fmtValue, nf, cardCoverage, cardHeadline, cardSubline, type Lang, type MetricKey, type Money } from './benchmarkFormat'

export type Tone = 'good' | 'bad' | 'tie' | 'none'
export type TypeKey = ScoreType | 'rework'
export const TYPE_ORDER: readonly TypeKey[] = ['quality', 'cost', 'time', 'reliability', 'rework']

/** The method page's version stamp (the contract carries `methodVersion`; the date is the day it was fixed). */
export const METHOD_STAMP = { version: 'v1', date: { pt: '08/11/2026', en: '2026-11-08' } } as const

/** The experiment minimum the method page states; a hero in the "none" state names what is missing against it. */
export const MIN_SAMPLE = { tasks: 8, repsPerTask: 2, acceptedPerArm: 5 } as const

export interface TaskPair<T> { 0: T; 1: T }
export interface SubtaskRow {
  id: string; title: string
  costUSD: [number | null, number | null]; wallMs: [number | null, number | null]
  qaRounds: [number | null, number | null]; accepted: [boolean | null, boolean | null]
}
export interface TaskRow {
  id: string; title: string; size: 'S' | 'M' | 'L'
  sessions: [number, number]
  costUSD: [number | null, number | null]; wallMs: [number | null, number | null]
  qaRounds: [number | null, number | null]; defects: [number | null, number | null]
  accepted: [boolean | null, boolean | null]
  /** The task's own 0–100 score for the candidate; null = could not be scored. */
  score: number | null
  note?: string
  subtasks?: SubtaskRow[]
}
export interface BucketRow {
  label: string; tasks: number
  costMedianUSD: number | null; wallMedianMs: number | null; escapedDefects: number | null
  firstTryRate: number | null; notReopenedRate: number | null
}
export interface ExperimentView { id: string; name: string; result: VerdictResult | null; tasks: TaskRow[]; buckets: BucketRow[] }

/** Tolerant reader for `/api/benchmark/experiments`: keeps only entries that say what they are. */
export function parseExperiments(raw: readonly unknown[] | null | undefined): ExperimentView[] {
  const out: ExperimentView[] = []
  for (const [i, e] of (raw ?? []).entries()) {
    if (!e || typeof e !== 'object') continue
    const o = e as Record<string, unknown>
    const result = (o.result && typeof o.result === 'object' ? o.result : 'verdict' in o && 'candidate' in o ? o : null) as VerdictResult | null
    const name = typeof o.name === 'string' && o.name ? o.name : result ? `${result.candidate} × ${result.reference}` : ''
    if (!name) continue
    out.push({
      id: typeof o.id === 'string' ? o.id : `exp-${i}`, name, result,
      tasks: Array.isArray(o.tasks) ? o.tasks as TaskRow[] : [], buckets: Array.isArray(o.buckets) ? o.buckets as BucketRow[] : [],
    })
  }
  return out
}

export const toneOf = (v: Verdict | null | undefined): Tone => v === 'pays' ? 'good' : v === 'does_not_pay' ? 'bad' : v === 'tie' ? 'tie' : 'none'
/** A 0–100 score read the way the prototype does: ≥ 55.55 pays (1.25×), ≤ 44.45 does not, between is a tie. */
export const toneOfScore = (n: number): Tone => n >= 55.55 ? 'good' : n <= 44.45 ? 'bad' : 'tie'
export const wordOf = (t: Tone, lang: Lang): string => {
  const pt = lang === 'pt'
  return t === 'good' ? (pt ? 'Compensou' : 'Paid off') : t === 'bad' ? (pt ? 'Não compensou' : 'Did not pay off') : t === 'tie' ? (pt ? 'Empate' : 'Tie') : (pt ? 'Sem veredito' : 'No verdict')
}

export interface Entry {
  id: string; kind: 'history' | 'comparison' | 'experiment'; name: string; sample: string
  /** 0–100 score, only for an experiment that has one. */
  score: number | null; tone: Tone; word: string
  experiment: ExperimentView | null
  comparison?: Comparison | null
}

export function sampleOf(r: VerdictResult | null, lang: Lang): string {
  if (!r) return lang === 'pt' ? 'sem execuções' : 'no runs'
  const runs = r.sample.runsCandidate + r.sample.runsReference
  return lang === 'pt' ? `${nf(r.sample.tasks, lang, 0)} tarefas · ${nf(runs, lang, 0)} execuções` : `${nf(r.sample.tasks, lang, 0)} tasks · ${nf(runs, lang, 0)} runs`
}

export function entriesOf(observed: Observed | null, experiments: readonly ExperimentView[], lang: Lang): Entry[] {
  const pt = lang === 'pt'
  const cmp = observed?.history ? comparisonsOf(observed.history, lang) : []
  if (cmp.length) {
    const seals: Entry[] = cmp.map(c => ({ id: c.id, kind: 'comparison', name: c.name, sample: c.sample, score: null, tone: 'none', word: pt ? 'observado' : 'observed', experiment: null, comparison: c }))
    return [...seals, ...experiments.map(e => experimentEntry(e, lang))]
  }
  const list: Entry[] = [{
    id: 'observed', kind: 'history', name: pt ? 'Histórico observado' : 'Observed history',
    sample: observed ? (pt ? `${nf(observed.deliveries, lang, 0)} entregas reais` : `${nf(observed.deliveries, lang, 0)} real deliveries`) : (pt ? 'carregando' : 'loading'),
    score: null, tone: 'none', word: pt ? 'Só histórico, sem veredito' : 'History only, no verdict', experiment: null,
  }]
  for (const e of experiments) list.push(experimentEntry(e, lang))
  return list
}

export interface Hero {
  tone: Tone
  /** Verdict word, or the "none" title. */
  word: string
  /** "Compensou 38%" / "Custou 21% a mais" — cost per accepted delivery, candidate against reference. Null in the none state. */
  delta: string | null
  score: number | null
  say: string
  firm: { ok: boolean; text: string } | null
  /** Interval of the 0–100 score. */
  range: { lo: number; hi: number } | null
  why: string[]
  /** What the observed history lets us say (history entry only). */
  facts?: string[]
  /** One quiet line under the sentence (comparisons): what it is made of. */
  caption?: string
  /** Title of the disclosure holding `why` and `facts`; when set they are folded away. */
  disclosure?: string
}

/** The "none" state: what is missing, in plain words, never a fake number. */
function noneHero(lang: Lang, say: string, why: string[]): Hero {
  return { tone: 'none', word: lang === 'pt' ? 'Sem dados ainda' : 'No data yet', delta: null, score: null, say, firm: null, range: null, why }
}

export function heroOf(entry: Entry, observed: Observed | null, lang: Lang, money: Money = { currency: 'USD' }): Hero {
  const pt = lang === 'pt'
  if (entry.kind === 'comparison' && entry.comparison && observed?.history) return comparisonHero(entry.comparison, observed, lang, money)
  const min = pt
    ? `O mínimo para um veredito é ${MIN_SAMPLE.tasks} tarefas, cada uma feita ${MIN_SAMPLE.repsPerTask} vezes por lado, com ${MIN_SAMPLE.acceptedPerArm} entregas aceitas em cada lado e custo medido em todas as execuções.`
    : `The minimum for a verdict is ${MIN_SAMPLE.tasks} tasks, each run ${MIN_SAMPLE.repsPerTask} times per side, with ${MIN_SAMPLE.acceptedPerArm} accepted deliveries on each side and cost measured in every run.`
  if (entry.kind === 'history') {
    const h = observed?.history
    return {
      tone: 'none', word: pt ? 'Não dá para provar ainda' : 'Cannot be proven yet', delta: null, score: null, firm: null, range: null,
      say: pt ? 'Peças difíceis vão para o método pesado, então comparar custo cru engana: o histórico descreve o que aconteceu, não prova que o método compensa. O que se vê:'
        : 'Hard pieces go to the heavy method, so comparing raw cost misleads: history describes what happened, it does not prove the method pays off. What is seen:',
      facts: h ? coverageFacts(h, lang) : [],
      why: [
        min, pt ? 'Falta rodar um experimento controlado: nenhum rodou ainda.' : 'A controlled experiment still has to run: none has yet.',
        pt ? 'Qualidade final não é medida: defeito escapado depois do release e peça reaberta não são registrados, e o QA reprovar não diz que o defeito escaparia.' : 'Final quality is not measured: defects escaped after release and reopened pieces are not recorded, and a QA rejection does not mean the defect would have escaped.',
        ...(h ? [] : [pt ? 'O histórico por peça não veio do servidor: sem ele não há o que mostrar por tarefa.' : 'The per-piece history did not come from the server: without it there is nothing to show per task.']),
      ],
    }
  }
  const r = entry.experiment?.result ?? null
  const final = r?.score?.final
  if (!r || r.verdict === 'insufficient' || !final || final.display === null) {
    const need = r ? `${nf(r.sample.tasks, lang, 0)}/${MIN_SAMPLE.tasks} ${pt ? 'tarefas' : 'tasks'}, ${nf(r.sample.acceptedCandidate, lang, 0)} + ${nf(r.sample.acceptedReference, lang, 0)} ${pt ? 'entregas aceitas' : 'accepted deliveries'}` : ''
    return noneHero(lang, r?.reason || (pt ? 'Ainda não dá para dizer quanto compensou.' : 'It is not yet possible to say how much paid off.'), [min, ...(need ? [need] : []), ...(final?.nullReason ? [final.nullReason] : [])])
  }
  const tone = toneOf(r.verdict)
  const rp = r.ratio.point
  const pct = rp === null ? null : Math.round(Math.abs(1 - rp) * 100)
  const delta = rp === null || pct === null ? null : tone === 'tie' ? (pt ? 'custo por entrega aceita praticamente igual' : 'cost per accepted delivery about the same')
    : rp < 1 ? (pt ? `Compensou ${pct}%: custa ${pct}% menos por entrega aceita` : `Paid off ${pct}%: costs ${pct}% less per accepted delivery`)
    : (pt ? `Custou ${pct}% a mais por entrega aceita` : `Cost ${pct}% more per accepted delivery`)
  const sens = r.score?.sensitivity
  const firm = sens?.result == null ? null : sens.result === 'firm'
    ? { ok: true, text: pt ? 'Resultado firme' : 'Firm result' } : { ok: false, text: pt ? 'Depende do que você valoriza' : 'Depends on what you value' }
  const why = [
    pt ? `A nota pode estar entre ${final.lo === null ? '—' : Math.round(final.lo)} e ${final.hi === null ? '—' : Math.round(final.hi)} (margem de erro por reamostragem das tarefas).` : `The score may lie between ${final.lo === null ? '—' : Math.round(final.lo)} and ${final.hi === null ? '—' : Math.round(final.hi)} (resampling margin).`,
    ...(sens && sens.rows.length ? [sens.rows.map(x => `${x.name}: ${x.verdict ? wordOf(toneOf(x.verdict), lang) : '—'}`).join('; ')] : []),
    ...(r.score?.gateBlocked ? [pt ? 'O lado vencedor aceitou menos entregas que o outro: a trava de aceitação impede o "Compensou".' : 'The winning side accepted fewer deliveries than the other: the acceptance gate blocks "Paid off".'] : []),
    pt ? `Baseado em ${sampleOf(r, lang)}; método ${r.methodVersion}.` : `Based on ${sampleOf(r, lang)}; method ${r.methodVersion}.`,
  ]
  return { tone, word: wordOf(tone, lang), delta, score: final.display, say: r.reason, firm, range: final.lo !== null && final.hi !== null ? { lo: final.lo, hi: final.hi } : null, why }
}

// ---- Partes ---------------------------------------------------------------------------------------------

export const TYPE_META: Record<TypeKey, { pt: string; en: string; qpt: string; qen: string }> = {
  quality: { pt: 'Qualidade', en: 'Quality', qpt: 'Ficou certo?', qen: 'Was it right?' },
  cost: { pt: 'Custo', en: 'Cost', qpt: 'Quanto gastou?', qen: 'What did it cost?' },
  time: { pt: 'Tempo', en: 'Time', qpt: 'Quanto demorou?', qen: 'How long did it take?' },
  reliability: { pt: 'Confiabilidade', en: 'Reliability', qpt: 'Se repetir, sai igual?', qen: 'Same result when repeated?' },
  rework: { pt: 'Retrabalho', en: 'Rework', qpt: 'Quantas voltas até ficar pronto?', qen: 'How many rounds until done?' },
}

/** Which observed metrics belong to which type. Reliability has none: nothing in the real history repeats a task. */
export const OBSERVED_BY_TYPE: Record<TypeKey, MetricKey[]> = {
  quality: ['qaFirstRoundRejection', 'escapedDefectRate'],
  cost: ['costPerDelivery', 'wastedCostShare', 'coordinationShare'],
  time: ['wallMedian', 'activeMedian', 'throughputPerWeek'],
  reliability: [],
  rework: ['qaRoundsMedian'],
}

export interface PartRow { key: string; label: string; value: string; sub: string; measured: boolean; metric?: MetricKey }
export interface Part {
  type: TypeKey; name: string; question: string
  /** Share of the type's points the candidate earned, 0–100; null when there is no comparison. */
  pct: number | null; points: number | null; max: number | null
  tone: Tone; word: string
  /** "No comparison" / "no data" in words, when the tile has no figure. */
  state: 'scored' | 'history' | 'none'
  /** The tile's one big figure when it is not a percentage (an observed multiplier). */
  big?: string
  /** Why a tile has no data, for a tooltip beside a one-word "sem dados". */
  hint?: string
  rows: PartRow[]
}

const idLabel = (id: string) => id.replace(/[_-]+/g, ' ')

export function partsOf(entry: Entry, observed: Observed | null, lang: Lang, money: Money): Part[] {
  const pt = lang === 'pt'
  if (entry.kind === 'comparison' && entry.comparison) return partsOfComparison(entry.comparison, lang, money, observed?.history?.coverage.withoutDuration ?? 0)
  return TYPE_ORDER.map((type): Part => {
    const meta = TYPE_META[type], name = pt ? meta.pt : meta.en, question = pt ? meta.qpt : meta.qen
    if (entry.kind === 'history') {
      if (type === 'rework' && observed?.history && observed.history.coverage.withQa > 0) {
        const subs = observed.history.tasks.flatMap(t => t.subtasks).filter(s => s.qaRounds !== null)
        const reworked = subs.filter(s => s.reworked).length, rounds = percentile(subs.map(s => s.qaRounds!), 0.5)
        const cov = pt ? `${subs.length} de ${observed.history.pieces} peças com QA` : `${subs.length} of ${observed.history.pieces} pieces with QA`
        const extra: PartRow[] = [
          { key: 'rework-rate', label: pt ? 'Peças com 2+ rodadas de QA' : 'Pieces with 2+ QA rounds', value: `${nf(reworked / subs.length * 100, lang, 0)}%`, sub: `${reworked} ${pt ? 'de' : 'of'} ${subs.length} · ${cov}`, measured: true },
          { key: 'rework-rounds', label: pt ? 'Rodadas de QA, mediana' : 'QA rounds, median', value: rounds === null ? '—' : nf(rounds, lang, 1), sub: pt ? 'lido do rótulo das sessões de QA (indicativo)' : 'read from the QA sessions\' labels (indicative)', measured: rounds !== null },
        ]
        return { type, name, question, pct: null, points: null, max: null, tone: 'none', state: 'history', word: pt ? 'só histórico' : 'history only', rows: extra }
      }
      const rows = observed ? OBSERVED_BY_TYPE[type].map((k): PartRow => {
        const head = cardHeadline(k, observed, lang, money), m = observed.metrics[k]
        const sub = head.measured
          ? (k === 'coordinationShare' ? (pt ? 'faixa, nunca um ponto' : 'a range, never a point') : m.interval ? fmtInterval(k, m.interval, lang, money) : (pt ? 'amostra pequena demais para um intervalo' : 'sample too small for an interval'))
          : cardSubline(k, observed, lang, money)
        return { key: k, metric: k, label: METRIC_LABEL[k][pt ? 0 : 1], value: head.value, sub: `${sub} · ${cardCoverage(k, observed, lang)}`, measured: head.measured }
      }) : []
      const any = rows.some(r => r.measured)
      return { type, name, question, pct: null, points: null, max: null, tone: 'none', state: any ? 'history' : 'none',
        word: any ? (pt ? 'só histórico' : 'history only') : (pt ? 'sem dados suficientes' : 'not enough data'), rows }
    }
    const r = entry.experiment?.result?.score ?? null
    if (type === 'rework') {
      const rows = r ? Object.entries(r.rework).map(([arm, v]): PartRow => ({ key: arm, label: arm, value: v === null ? '—' : nf(v, lang, 1), sub: pt ? 'rodadas por execução' : 'rounds per run', measured: v !== null })) : []
      const any = rows.some(x => x.measured)
      return { type, name, question, pct: null, points: null, max: null, tone: 'none', state: any ? 'history' : 'none', word: any ? (pt ? 'evidência, sem pontos' : 'evidence, no points') : (pt ? 'sem dados suficientes' : 'not enough data'), rows }
    }
    const t = r?.types[type] ?? null
    if (!t || t.displayPoints === null) {
      return { type, name, question, pct: null, points: null, max: t?.max ?? null, tone: 'none', state: 'none', word: pt ? 'sem dados suficientes' : 'not enough data',
        rows: (t?.metrics ?? []).map(m => ({ key: m.id, label: idLabel(m.id), value: '—', sub: m.missing ?? '', measured: false })) }
    }
    const pct = Math.round(t.displayPoints / t.max * 100)
    const tone: Tone = t.status === 'better' ? 'good' : t.status === 'worse' ? 'bad' : t.status === 'tie' ? 'tie' : 'none'
    const ratio = t.ratio
    const times = ratio === null ? '' : ` · ${nf(ratio >= 1 ? ratio : 1 / ratio, lang, 1)}× ${ratio >= 1 ? (pt ? 'melhor' : 'better') : (pt ? 'pior' : 'worse')}`
    return { type, name, question, pct, points: t.displayPoints, max: t.max, tone, state: 'scored', word: `${wordOf(tone, lang)}${times}`,
      rows: t.metrics.map(m => ({ key: m.id, label: idLabel(m.id), value: `${m.reference === null ? '—' : nf(m.reference, lang, 2)} → ${m.candidate === null ? '—' : nf(m.candidate, lang, 2)}`, sub: m.missing ?? '', measured: m.ratio !== null })) }
  })
}

// ---- Por tarefa -----------------------------------------------------------------------------------------

export type TaskSortKey = 'title' | 'cost' | 'time' | 'qa' | 'score'
export type SizeFilter = 'all' | 'S' | 'M' | 'L'

/** Case-insensitive contains; an empty needle keeps everything. */
export const matches = (title: string, needle: string): boolean => !needle.trim() || title.toLowerCase().includes(needle.trim().toLowerCase())

const sortValue = (t: TaskRow, k: TaskSortKey): number | string | null =>
  k === 'title' ? t.title.toLowerCase() : k === 'cost' ? t.costUSD[1] : k === 'time' ? t.wallMs[1] : k === 'qa' ? t.qaRounds[1] : t.score

/** Filtered and sorted rows; a task with no value for the sort key goes LAST in both directions. */
export function taskRows(rows: readonly TaskRow[], o: { size: SizeFilter; needle: string; key: TaskSortKey; dir: 1 | -1 }): TaskRow[] {
  return rows.filter(t => (o.size === 'all' || t.size === o.size) && matches(t.title, o.needle)).sort((a, b) => {
    const x = sortValue(a, o.key), y = sortValue(b, o.key)
    if (x === null && y === null) return 0
    if (x === null) return 1
    if (y === null) return -1
    return (x < y ? -1 : x > y ? 1 : 0) * o.dir
  })
}

export function pairText(v: readonly [number | null, number | null], fmt: (n: number) => string): string {
  const f = (n: number | null) => n === null ? '—' : fmt(n)
  return `${f(v[0])} → ${f(v[1])}`
}

export function acceptedText(v: readonly [boolean | null, boolean | null], lang: Lang): string {
  const f = (b: boolean | null) => b === null ? '—' : b ? (lang === 'pt' ? 'sim' : 'yes') : (lang === 'pt' ? 'não' : 'no')
  return `${f(v[0])} → ${f(v[1])}`
}

export const moneyText = (n: number, lang: Lang, money: Money): string => fmtValue('costPerDelivery', n, lang, money)
export const durationText = (ms: number, lang: Lang): string => fmtValue('wallMedian', ms, lang)

// ---- observed history: facts and rows ------------------------------------------------------------------

const sizeWord = (s: 'S' | 'M' | 'L', lang: Lang) => (lang === 'pt' ? (s === 'S' ? 'P' : s === 'M' ? 'M' : 'G') : s)
export const sizeLabel = sizeWord

/**
 * What the observed history lets us state ABOUT THE DATA, never about a comparison: how many pieces, and where cost is missing.
 * No ratio or median is computed here — those come from the server's `comparisons`.
 */
export function coverageFacts(h: ObservedHistory, lang: Lang, withCount = true): string[] {
  const pt = lang === 'pt'
  const c = h.coverage
  const out: string[] = []
  if (withCount) out.push(pt ? `${nf(h.pieces, lang, 0)} peças entregues com sessão vinculada, em ${nf(h.tasks.length, lang, 0)} tarefas.` : `${nf(h.pieces, lang, 0)} delivered pieces with a linked session, in ${nf(h.tasks.length, lang, 0)} tasks.`)
  out.push(pt ? `Custo medido em ${nf(c.withCost, lang, 0)} de ${nf(c.pieces, lang, 0)} peças${c.pctWithCost === null ? '' : ` (${nf(c.pctWithCost, lang, 0)}%)`}${c.harnessesWithoutCost.length ? `; sem custo: ${c.harnessesWithoutCost.join(', ')}` : ''}${c.harnessesPartialCost.length ? `; custo parcial: ${c.harnessesPartialCost.join(', ')}` : ''}.`
    : `Cost measured in ${nf(c.withCost, lang, 0)} of ${nf(c.pieces, lang, 0)} pieces${c.pctWithCost === null ? '' : ` (${nf(c.pctWithCost, lang, 0)}%)`}${c.harnessesWithoutCost.length ? `; no cost: ${c.harnessesWithoutCost.join(', ')}` : ''}${c.harnessesPartialCost.length ? `; partial cost: ${c.harnessesPartialCost.join(', ')}` : ''}.`)
  return out
}

/** Sizes whose own ratio runs against the headline's direction (clearly: more than 10% on the other side of 1). */
function oppositeSizes(c: Comparison): { metric: 'cost' | 'wall'; size: 'S' | 'M' | 'L' }[] {
  const out: { metric: 'cost' | 'wall'; size: 'S' | 'M' | 'L' }[] = []
  for (const metric of ['wall', 'cost'] as const) {
    const k = c[metric]
    if (!k || Math.abs(k.ratio - 1) < 0.05) continue
    for (const p of k.sizes) {
      const r = p.medB / p.medA
      if ((k.ratio > 1 && r < 0.9) || (k.ratio < 1 && r > 1.1)) out.push({ metric, size: p.size })
    }
  }
  return out
}

function oppositeNote(c: Comparison, lang: Lang): string {
  const pt = lang === 'pt'
  const o = oppositeSizes(c)
  if (!o.length) return ''
  // Per METRIC: "in time, S; in cost, L" never "in time and cost, S and L" (that would say S was opposite in cost too).
  const metrics = [...new Set(o.map(x => x.metric))]
  const parts = metrics.map((m, i) => {
    const list = o.filter(x => x.metric === m).map(x => sizeWord(x.size, lang)).join(pt ? ' e ' : ' and ')
    const what = m === 'wall' ? (pt ? 'tempo' : 'time') : (pt ? 'custo' : 'cost')
    if (pt) return i === 0 ? `no ${what}, nas peças ${list} foi o contrário` : `no ${what}, nas ${list}`
    return i === 0 ? `in ${what}, the opposite for ${list} pieces` : `in ${what}, for ${list}`
  })
  return parts.join('; ')
}

export type HistorySortKey = 'title' | 'cost' | 'wall' | 'qa' | 'sessions'
const hv = (t: HistoryTaskRow, k: HistorySortKey): number | string | null =>
  k === 'title' ? t.title.toLowerCase() : k === 'cost' ? t.costUSD : k === 'wall' ? t.wallMs : k === 'qa' ? t.qaRounds : t.sessions

/** Filtered and sorted history rows; a row with no value for the key goes LAST in both directions. */
export function historyTaskRows(rows: readonly HistoryTaskRow[], o: { size: SizeFilter; needle: string; key: HistorySortKey; dir: 1 | -1 }): HistoryTaskRow[] {
  return rows.filter(t => (o.size === 'all' || t.size === o.size) && matches(t.title, o.needle)).sort((a, b) => {
    const x = hv(a, o.key), y = hv(b, o.key)
    if (x === null && y === null) return 0
    if (x === null) return 1
    if (y === null) return -1
    return (x < y ? -1 : x > y ? 1 : 0) * o.dir
  })
}

function experimentEntry(e: ExperimentView, lang: Lang): Entry {
  const r = e.result
  const score = r?.score?.final.display ?? null
  const tone = score === null ? 'none' : toneOf(r?.verdict)
  return { id: e.id, kind: 'experiment', name: e.name, sample: sampleOf(r, lang), score, tone, word: wordOf(tone, lang), experiment: e }
}

// ---- observed comparisons: what the history alone lets two groups of pieces be set against ---------------

export type { Compared }
export interface Comparison {
  id: 'qa' | 'sessions'; name: string; aShort: string; bShort: string; sample: string
  nA: number; nB: number
  cost: Compared | null; wall: Compared | null
  /** QA comparison: how many more sessions; sessions comparison: the rework rate of each side. */
  third: HistoryComparison['third']
}

/**
 * The comparisons the observed history supports. They are BUILT ON THE SERVER (core `buildComparisons`, carried
 * by HTTP and the MCP tool alike); this only gives each one its words. An older server that sends none shows none.
 */
export function comparisonsOf(h: ObservedHistory, lang: Lang): Comparison[] {
  const pt = lang === 'pt'
  const words: Record<HistoryComparison['key'], { name: string; a: string; b: string }> = {
    qa: { name: pt ? '1 rodada de QA × 2+ rodadas' : '1 QA round × 2+ rounds', a: pt ? '1 rodada de QA' : '1 QA round', b: pt ? '2+ rodadas de QA' : '2+ QA rounds' },
    sessions: { name: pt ? '1 sessão × 5+ sessões' : '1 session × 5+ sessions', a: pt ? '1 sessão' : '1 session', b: pt ? '5+ sessões' : '5+ sessions' },
  }
  return (h.comparisons ?? []).map(c => ({
    id: c.key, name: words[c.key].name, aShort: words[c.key].a, bShort: words[c.key].b,
    sample: pt ? `${c.nA} × ${c.nB} peças` : `${c.nA} × ${c.nB} pieces`, nA: c.nA, nB: c.nB, cost: c.cost, wall: c.wall, third: c.third,
  }))
}

const times = (r: number, lang: Lang) => `${nf(r >= 1 ? r : 1 / r, lang, 1)}×`
/** B ÷ A as it is (0,6× is cheaper, 1,7× is dearer): a tile or a pair never hides the direction behind an inversion. */
const ratioText = (r: number, lang: Lang) => `${nf(r, lang, 1)}×`
const pct0 = (v: number, lang: Lang) => `${nf(v * 100, lang, 0)}%`

/** One sentence in the prototype's mould, short enough for three lines: what the B-side pieces cost, took and used. */
function comparisonSentence(c: Comparison, lang: Lang): string {
  const pt = lang === 'pt'
  const parts: string[] = []
  const more = (r: number, noun: string, nounLess = noun) => pt ? `${times(r, lang)} ${r >= 1 ? 'mais' : 'menos'} ${noun}` : `${times(r, lang)} ${r >= 1 ? 'more' : 'less'} ${nounLess}`
  if (c.cost) parts.push(more(c.cost.ratio, pt ? 'custo' : 'cost'))
  if (c.wall) parts.push(more(c.wall.ratio, pt ? 'tempo' : 'time'))
  if (c.third.kind === 'sessions' && c.third.sessions) parts.push(more(c.third.sessions.ratio, pt ? 'sessões' : 'sessions'))
  if (c.third.kind === 'rework' && c.third.rateA !== null && c.third.rateB !== null) parts.push(`${pt ? 'retrabalho' : 'rework'} ${pct0(c.third.rateA, lang)} → ${pct0(c.third.rateB, lang)}`)
  return `${pt ? 'Com' : 'With'} ${c.bShort}: ${parts.join(', ')}.`
}

function comparisonHero(c: Comparison, observed: Observed, lang: Lang, money: Money): Hero {
  const pt = lang === 'pt'
  const h = observed.history!
  return {
    tone: 'none', word: pt ? 'Indício, não prova' : 'Evidence, not proof', delta: null, score: null, firm: null, range: null,
    say: comparisonSentence(c, lang),
    caption: (pt ? `contra ${c.aShort} · ${c.nA} × ${c.nB} peças · mesmo tamanho` : `against ${c.aShort} · ${c.nA} × ${c.nB} pieces · same size`) + (oppositeNote(c, lang) ? ` · ${oppositeNote(c, lang)}` : ''),
    disclosure: pt ? 'Por que não é prova?' : 'Why is this not proof?',
    why: [
      pt ? 'Peças difíceis vão para o método pesado e tendem a ter mais rodadas e mais sessões: a diferença pode ser a dificuldade, não o método. Comparar dentro do mesmo tamanho (linhas) é um controle fraco.' : 'Hard pieces go to the heavy method and tend to have more rounds and sessions: the difference may be the difficulty, not the method. Matching by size (lines) is a weak control.',
      pt ? `Para um veredito falta um experimento controlado (mínimo ${MIN_SAMPLE.tasks} tarefas × ${MIN_SAMPLE.repsPerTask} repetições, ${MIN_SAMPLE.acceptedPerArm} aceitas por lado); nenhum rodou ainda.` : `A verdict needs a controlled experiment (minimum ${MIN_SAMPLE.tasks} tasks × ${MIN_SAMPLE.repsPerTask} repetitions, ${MIN_SAMPLE.acceptedPerArm} accepted per side); none has run yet.`,
      pt ? 'Qualidade final não é medida: defeito escapado depois do release e peça reaberta não são registrados.' : 'Final quality is not measured: defects escaped after release and reopened pieces are not recorded.',
      ...(c.id === 'qa' ? [pt ? 'As rodadas de QA vêm do rótulo das sessões de QA: indicativo, o fluxo ainda não registra veredito estruturado.' : 'QA rounds come from the QA sessions\' labels: indicative, the flow does not record a structured verdict yet.'] : []),
    ],
    facts: coverageFacts(h, lang, false),
  }
}

const sessionsWord = (n: number, lang: Lang) => lang === 'pt' ? `${nf(n, lang, 1)} ${n === 1 ? 'sessão' : 'sessões'}` : `${nf(n, lang, 1)} ${n === 1 ? 'session' : 'sessions'}`

function partsOfComparison(c: Comparison, lang: Lang, money: Money, withoutDuration = 0): Part[] {
  const pt = lang === 'pt'
  const seal = pt ? 'observado' : 'observed'
  const sameSize = pt ? 'comparado dentro do mesmo tamanho' : 'compared within the same size'
  // The headline is the size-matched ratio, so the figures behind it are the per-size pairs: each one gives ITS ratio.
  const pair = (k: Compared, f: (n: number) => string, label: string): PartRow[] => k.sizes.map(p => ({
    key: `${label}-${p.size}`, label: `${label} · ${sizeWord(p.size, lang)}`, value: `${f(p.medA)} → ${f(p.medB)}`,
    sub: `${ratioText(p.medB / p.medA, lang)} · ${pt ? 'peças' : 'pieces'} ${p.nA} × ${p.nB}`, measured: true,
  }))
  const none = (type: TypeKey, why: string): Part => ({ type, name: pt ? TYPE_META[type].pt : TYPE_META[type].en, question: pt ? TYPE_META[type].qpt : TYPE_META[type].qen, pct: null, points: null, max: null, tone: 'none', state: 'none', word: pt ? 'sem dados' : 'no data', hint: why, rows: [] })
  const tile = (type: TypeKey, k: Compared | null, f: (n: number) => string, rowLabel: string): Part => k
    ? { type, name: pt ? TYPE_META[type].pt : TYPE_META[type].en, question: pt ? TYPE_META[type].qpt : TYPE_META[type].qen, pct: null, points: null, max: null, tone: 'none', state: 'history', big: ratioText(k.ratio, lang), word: sameSize, rows: pair(k, f, rowLabel) }
    : none(type, pt ? 'sem dados suficientes' : 'not enough data')
  const third = c.third
  const rework: Part = third.kind === 'sessions'
    ? { ...tile('rework', third.sessions, n => sessionsWord(n, lang), pt ? 'Sessões por peça' : 'Sessions per piece'), name: pt ? 'Sessões por peça' : 'Sessions per piece', question: pt ? 'Quantas sessões gastou?' : 'How many sessions did it take?' }
    : third.rateA !== null && third.rateB !== null
      ? { type: 'rework', name: pt ? TYPE_META.rework.pt : TYPE_META.rework.en, question: pt ? TYPE_META.rework.qpt : TYPE_META.rework.qen, pct: null, points: null, max: null, tone: 'none', state: 'history',
        big: `${pct0(third.rateA, lang)} → ${pct0(third.rateB, lang)}`, word: seal, rows: [{ key: 'rate', label: pt ? '2+ rodadas de QA' : '2+ QA rounds', value: `${pct0(third.rateA, lang)} → ${pct0(third.rateB, lang)}`, sub: pt ? 'entre as peças com QA (lido do rótulo das sessões, indicativo)' : 'among pieces with QA (read from session labels, indicative)', measured: true }] }
      : none('rework', pt ? 'sem dados suficientes' : 'not enough data')
  return [
    none('quality', pt ? 'defeito escapado e peça reaberta não são registrados' : 'escaped defects and reopened pieces are not recorded'),
    tile('cost', c.cost, n => moneyText(n, lang, money), pt ? 'Custo mediano' : 'Median cost'),
    ((t: Part): Part => withoutDuration > 0 && t.state === 'history'
      ? { ...t, rows: [...t.rows, { key: 'no-duration', label: pt ? 'Sem duração' : 'No duration', value: `${withoutDuration} ${pt ? (withoutDuration === 1 ? 'peça' : 'peças') : (withoutDuration === 1 ? 'piece' : 'pieces')}`, sub: pt ? 'início = entrega: fora das medianas de tempo' : 'start = delivery: left out of the time medians', measured: false }] } : t
    )(tile('time', c.wall, n => durationText(n, lang), pt ? 'Tempo mediano' : 'Median time')),
    none('reliability', pt ? 'nenhuma tarefa foi repetida' : 'no task was repeated'),
    rework,
  ]
}
