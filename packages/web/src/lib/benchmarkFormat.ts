/**
 * Plain-language wording for the Benchmark screen. PURE: the server sends numbers and language-neutral
 * gap codes; every sentence, unit and locale rule lives here, in both languages.
 */
import type { Gap, GapCode, Interval, Observed } from '@agentistics/core/benchmark'

export type Lang = 'pt' | 'en'
export type MetricKey = keyof Observed['metrics']
type Unit = 'usd' | 'duration' | 'percent' | 'rounds' | 'perWeek'

export const METRIC_ORDER: MetricKey[] = [
  'costPerDelivery', 'wallMedian', 'activeMedian', 'throughputPerWeek', 'coordinationShare',
  'qaFirstRoundRejection', 'qaRoundsMedian', 'escapedDefectRate', 'wastedCostShare',
]

const UNIT: Record<MetricKey, Unit> = {
  costPerDelivery: 'usd', wallMedian: 'duration', activeMedian: 'duration', throughputPerWeek: 'perWeek', coordinationShare: 'percent',
  qaFirstRoundRejection: 'percent', qaRoundsMedian: 'rounds', escapedDefectRate: 'percent', wastedCostShare: 'percent',
}

export const METRIC_LABEL: Record<MetricKey, [string, string]> = {
  costPerDelivery: ['Custo por entrega', 'Cost per delivery'], wallMedian: ['Tempo até publicar', 'Time to publish'],
  activeMedian: ['Tempo ativo', 'Active time'], coordinationShare: ['Coordenação (faixa)', 'Coordination (range)'],
  qaFirstRoundRejection: ['Rejeição na QA', 'First-round QA rejection'], qaRoundsMedian: ['Rodadas de QA', 'QA rounds'],
  escapedDefectRate: ['Defeitos escapados', 'Escaped defects'], wastedCostShare: ['Custo desperdiçado', 'Wasted cost'],
  throughputPerWeek: ['Entregas por semana', 'Deliveries per week'],
}

/** What the figure is, in one plain sentence — what the origin drawer opens with. */
export const METRIC_PLAIN: Record<MetricKey, [string, string]> = {
  costPerDelivery: ['Média, entre as entregas, da soma do custo das sessões de cada uma (tokens de cada turno × tabela de preços). Entregas com alguma sessão sem preço ou sem tokens ficam de fora.', 'Average, across deliveries, of the summed cost of each one\'s sessions (per-turn tokens × price table). Deliveries with any session lacking a price or tokens are left out.'],
  wallMedian: ['Mediana do tempo entre a entrada na fila (ou o pedido) e a publicação, nas entregas publicadas.', 'Median time from queue entry (or the request) to publication, over published deliveries.'],
  activeMedian: ['Mediana do tempo em execução, QA, ajuste, revisão do líder, merge e CI, só nas entregas publicadas com histórico de fases registrado.', 'Median time spent running, in QA, adjusting, leader review, merge and CI, only for published deliveries with a recorded phase history.'],
  coordinationShare: ['Quanto do custo foi de sessões líderes: o início da faixa conta só líderes confirmados; o fim soma também as sessões sem papel registrado.', 'How much of the cost was leader sessions: the low end counts confirmed leaders only; the high end also adds sessions with no recorded role.'],
  qaFirstRoundRejection: ['Entregas que a QA devolveu ao menos uma vez ÷ entregas em que o histórico de fases mostra a QA decidindo.', 'Deliveries QA sent back at least once ÷ deliveries whose phase history shows QA deciding.'],
  qaRoundsMedian: ['Mediana de (devoluções da QA + 1) nas entregas em que o histórico mostra a QA decidindo.', 'Median of (QA send-backs + 1) over deliveries whose history shows QA deciding.'],
  escapedDefectRate: ['Entregas publicadas que uma correção, reversão ou reabertura posterior aponta de volta ÷ entregas publicadas. Exige o vínculo registrado.', 'Published deliveries that a later fix, revert or reopen points back to ÷ published deliveries. Needs the link to be recorded.'],
  wastedCostShare: ['Custo das sessões ligadas a trabalho abandonado ÷ custo total das sessões com preço.', 'Cost of sessions tied to abandoned work ÷ total cost of priced sessions.'],
  throughputPerWeek: ['Entregas publicadas ÷ semanas do período (do primeiro ao último registro).', 'Published deliveries ÷ weeks in the period (first to last record).'],
}

export const SOURCE_LABEL: Record<string, [string, string]> = {
  'tasks.json (subtasks)': ['quadro de tarefas (tasks.json)', 'task board (tasks.json)'],
  'deliveries.json (phase history)': ['histórico de fases das entregas (deliveries.json)', 'delivery phase history (deliveries.json)'],
  'managed-sessions.json (sessions)': ['sessões registradas (managed-sessions.json)', 'registered sessions (managed-sessions.json)'],
  'sessions store (tokens)': ['tokens guardados por sessão (~/.agentistics/sessions)', 'stored tokens per session (~/.agentistics/sessions)'],
}

const GAP_TEXT: Record<GapCode, [string, string]> = {
  no_phase_history: ['sem histórico de fases registrado', 'no recorded phase history'],
  no_qa_stage: ['histórico sem etapa de QA', 'history shows no QA stage'],
  not_published: ['ainda não publicadas', 'not published yet'],
  no_price: ['modelo sem preço na tabela', 'model has no price in the table'],
  no_tokens: ['tokens não guardados', 'tokens not stored'],
  no_sessions: ['nenhuma sessão ligada', 'no session linked'],
  waste_not_tracked: ['trabalho abandonado não registrado', 'abandoned work not recorded'],
  escape_links_not_recorded: ['vínculo de defeito escapado não registrado', 'escape link not recorded'],
  role_unknown: ['sessões sem papel registrado', 'sessions with no recorded role'],
}

export function gapText(g: Gap, lang: Lang): string {
  return `${nf(g.count, lang, 0)} ${GAP_TEXT[g.code][lang === 'pt' ? 0 : 1]}`
}

const loc = (lang: Lang) => (lang === 'pt' ? 'pt-BR' : 'en-US')
export const nf = (v: number, lang: Lang, digits = 1): string =>
  v.toLocaleString(loc(lang), { minimumFractionDigits: 0, maximumFractionDigits: digits })

function duration(ms: number, lang: Lang): string {
  const h = ms / 3_600_000
  if (h < 1) return `${nf(ms / 60_000, lang, 0)} min`
  if (h < 48) return `${nf(h, lang, 1)} h`
  return `${nf(h / 24, lang, 1)} ${lang === 'pt' ? 'd' : 'd'}`
}

export function fmtValue(key: MetricKey, v: number, lang: Lang): string {
  switch (UNIT[key]) {
    case 'usd': return lang === 'pt' ? `US$ ${nf(v, lang, 2)}` : `$${nf(v, lang, 2)}`
    case 'duration': return duration(v, lang)
    case 'percent': return `${nf(v * 100, lang, 0)}%`
    case 'rounds': return `${nf(v, lang, 1)} ${lang === 'pt' ? (v === 1 ? 'rodada' : 'rodadas') : (v === 1 ? 'round' : 'rounds')}`
    case 'perWeek': return `${nf(v, lang, 1)} ${lang === 'pt' ? '/ semana' : '/ week'}`
  }
}

export function fmtInterval(key: MetricKey, i: Interval, lang: Lang): string {
  const a = fmtValue(key, i.lo, lang), b = fmtValue(key, i.hi, lang)
  return `${lang === 'pt' ? 'IC 95%' : '95% CI'}: ${a} – ${b}`
}

export function intervalMethod(i: Interval, lang: Lang): string {
  const m: Record<Interval['method'], [string, string]> = {
    wilson: ['intervalo de Wilson (proporção)', 'Wilson interval (proportion)'],
    'poisson-score': ['intervalo de Poisson (taxa)', 'Poisson interval (rate)'],
    bootstrap: ['bootstrap com semente fixa, 2000 reamostragens', 'bootstrap with a fixed seed, 2000 resamples'],
    range: ['faixa entre os dois extremos possíveis', 'range between the two possible extremes'],
  }
  return m[i.method][lang === 'pt' ? 0 : 1]
}

/** The headline of a card: the value, a range, or "—" with the reason. */
export function cardHeadline(key: MetricKey, o: Observed, lang: Lang): { value: string; measured: boolean } {
  const m = o.metrics[key]
  if (key === 'coordinationShare') {
    const r = o.coordinationShareRange
    return r.lo === null || r.hi === null ? { value: '—', measured: false }
      : { value: `${fmtValue(key, r.lo, lang)} – ${fmtValue(key, r.hi, lang)}`, measured: true }
  }
  return m.value === null ? { value: '—', measured: false } : { value: fmtValue(key, m.value, lang), measured: true }
}

/** One short line under the value: the interval, or why there is no figure. */
export function cardSubline(key: MetricKey, o: Observed, lang: Lang): string {
  const m = o.metrics[key]
  const head = cardHeadline(key, o, lang)
  if (!head.measured) {
    const top = [...m.gaps].sort((a, b) => b.count - a.count)[0]
    return `${lang === 'pt' ? 'sem medição' : 'not measured'}${top ? ` · ${gapText(top, lang)}` : ''}`
  }
  if (key === 'coordinationShare') return lang === 'pt' ? 'faixa, nunca um ponto' : 'a range, never a point'
  return m.interval ? fmtInterval(key, m.interval, lang) : (lang === 'pt' ? 'amostra pequena demais para um intervalo' : 'sample too small for an interval')
}

export function cardCoverage(key: MetricKey, o: Observed, lang: Lang): string {
  const m = o.metrics[key]
  return lang === 'pt' ? `${nf(m.n, lang, 0)} de ${nf(m.total, lang, 0)} medidas` : `${nf(m.n, lang, 0)} of ${nf(m.total, lang, 0)} measured`
}

export type HarnessState = 'measured' | 'partial' | 'none'
export function harnessState(c: Observed['coverage'][string]): HarnessState {
  return c.withCost === c.sessions ? 'measured' : c.withCost === 0 ? 'none' : 'partial'
}

export function harnessReason(c: Observed['coverage'][string], lang: Lang): string {
  const noTokens = c.sessions - c.withTokens, noPrice = c.withTokens - c.withCost
  const parts: string[] = []
  if (noTokens > 0) parts.push(lang === 'pt' ? `${noTokens} sem tokens guardados` : `${noTokens} without stored tokens`)
  if (noPrice > 0) parts.push(lang === 'pt' ? `${noPrice} com modelo sem preço` : `${noPrice} with a model that has no price`)
  return parts.join(' · ')
}
