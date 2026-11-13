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
import type { Observed, ScoreType, Verdict, VerdictResult } from '@agentistics/core/benchmark'
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
  id: string; kind: 'history' | 'experiment'; name: string; sample: string
  /** 0–100 score, only for an experiment that has one. */
  score: number | null; tone: Tone; word: string
  experiment: ExperimentView | null
}

export function sampleOf(r: VerdictResult | null, lang: Lang): string {
  if (!r) return lang === 'pt' ? 'sem execuções' : 'no runs'
  const runs = r.sample.runsCandidate + r.sample.runsReference
  return lang === 'pt' ? `${nf(r.sample.tasks, lang, 0)} tarefas · ${nf(runs, lang, 0)} execuções` : `${nf(r.sample.tasks, lang, 0)} tasks · ${nf(runs, lang, 0)} runs`
}

export function entriesOf(observed: Observed | null, experiments: readonly ExperimentView[], lang: Lang): Entry[] {
  const pt = lang === 'pt'
  const list: Entry[] = [{
    id: 'observed', kind: 'history', name: pt ? 'Histórico observado' : 'Observed history',
    sample: observed ? (pt ? `${nf(observed.deliveries, lang, 0)} entregas reais` : `${nf(observed.deliveries, lang, 0)} real deliveries`) : (pt ? 'carregando' : 'loading'),
    score: null, tone: 'none', word: pt ? 'Só histórico, sem veredito' : 'History only, no verdict', experiment: null,
  }]
  for (const e of experiments) {
    const r = e.result
    const score = r?.score?.final.display ?? null
    const tone = score === null ? 'none' : toneOf(r?.verdict)
    list.push({ id: e.id, kind: 'experiment', name: e.name, sample: sampleOf(r, lang), score, tone, word: wordOf(tone, lang), experiment: e })
  }
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
}

/** The "none" state: what is missing, in plain words, never a fake number. */
function noneHero(lang: Lang, say: string, why: string[]): Hero {
  return { tone: 'none', word: lang === 'pt' ? 'Sem dados ainda' : 'No data yet', delta: null, score: null, say, firm: null, range: null, why }
}

export function heroOf(entry: Entry, observed: Observed | null, lang: Lang): Hero {
  const pt = lang === 'pt'
  const min = pt
    ? `O mínimo para um veredito é ${MIN_SAMPLE.tasks} tarefas, cada uma feita ${MIN_SAMPLE.repsPerTask} vezes por lado, com ${MIN_SAMPLE.acceptedPerArm} entregas aceitas em cada lado e custo medido em todas as execuções.`
    : `The minimum for a verdict is ${MIN_SAMPLE.tasks} tasks, each run ${MIN_SAMPLE.repsPerTask} times per side, with ${MIN_SAMPLE.acceptedPerArm} accepted deliveries on each side and cost measured in every run.`
  if (entry.kind === 'history') {
    return noneHero(lang,
      pt ? 'Isto é o passado do trabalho real: não compara dois jeitos de trabalhar, então não dá para dizer quanto compensou. Os números reais estão em "Partes", logo abaixo.'
        : 'This is the history of real work: it does not compare two ways of working, so it cannot say how much paid off. The real figures are in "Parts" below.',
      [min, pt ? 'Falta rodar um experimento controlado: nenhum rodou ainda.' : 'A controlled experiment still has to run: none has yet.',
        ...(observed ? [pt ? 'Trabalho difícil tende a seguir o caminho pesado, por isso o histórico é viesado e nunca vira veredito.' : 'Hard work tends to take the heavier path, so history is biased and never becomes a verdict.'] : [])])
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
  rows: PartRow[]
}

const idLabel = (id: string) => id.replace(/[_-]+/g, ' ')

export function partsOf(entry: Entry, observed: Observed | null, lang: Lang, money: Money): Part[] {
  const pt = lang === 'pt'
  return TYPE_ORDER.map((type): Part => {
    const meta = TYPE_META[type], name = pt ? meta.pt : meta.en, question = pt ? meta.qpt : meta.qen
    if (entry.kind === 'history') {
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
