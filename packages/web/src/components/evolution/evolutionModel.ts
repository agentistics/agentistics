/**
 * evolutionModel.ts — PURE. The words and the small arithmetic the "Evolução de entregas" screen puts on top of the
 * reply: durations, percentages, the change against the prior window, the narrative lead and the empty-state kind.
 * Nothing here computes a metric (that is core's `deliveryMetrics.ts`); it only phrases what the reply already says,
 * and a figure the reply could not measure stays "—" / "not measured", never a 0.
 */
import type { Metrics, MetricsReply, TimeBucket } from '@agentistics/core'

const H = 3_600_000

/** `—` for a figure nobody measured; minutes under an hour, hours under two days, days beyond. */
export function fmtDur(ms: number | null | undefined, pt: boolean): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  const nf = (n: number, d: number) => n.toLocaleString(pt ? 'pt-BR' : 'en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
  const h = ms / H
  // Under a minute reads as under a minute: rounding a real 400 ms up to "1 min" states a time nobody measured.
  if (ms <= 0) return '0 min'
  if (ms < 60_000) return '< 1 min'
  if (h < 1) return `${Math.round(h * 60)} min`
  if (h < 48) return `${nf(h, h < 10 ? 1 : 0)} h`
  return `${nf(h / 24, 1)} d`
}

export function fmtPct(rate: number | null | undefined, pt: boolean): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—'
  return `${(rate * 100).toLocaleString(pt ? 'pt-BR' : 'en-US', { maximumFractionDigits: 0 })}%`
}

export function fmtNum(n: number | null | undefined, pt: boolean, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return n.toLocaleString(pt ? 'pt-BR' : 'en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export type Tone = 'good' | 'bad' | 'flat'
export interface Delta { pct: number; tone: Tone }

/**
 * The change of `cur` against `prior`. `null` when either is unmeasured or the prior is zero (a change over nothing is
 * not a percentage). `lowerIsBetter` decides which way is "good"; within ±2 % it reads flat.
 */
export function deltaOf(cur: number | null, prior: number | null, lowerIsBetter: boolean): Delta | null {
  if (cur === null || prior === null || !Number.isFinite(cur) || !Number.isFinite(prior) || prior === 0) return null
  const pct = cur / prior - 1
  if (Math.abs(pct) < 0.02) return { pct, tone: 'flat' }
  return { pct, tone: (pct < 0) === lowerIsBetter ? 'good' : 'bad' }
}

export type EmptyKind = 'none' | 'no-data' | 'no-match'
/** Separates "there are no deliveries at all" from "the filters left nothing" from "there is something to draw". */
export function emptyKind(r: MetricsReply): EmptyKind {
  if (!r.anyData) return 'no-data'
  return r.rowsTotal === 0 ? 'no-match' : 'none'
}

export const STAGE_ORDER: readonly TimeBucket[] = ['queue', 'running', 'qa', 'adjust', 'leader', 'merge', 'ci', 'blocked']

/** The average time per stage as chart parts, in the order the delivery walks them; zero parts are dropped. */
export function stageParts(m: Metrics): { stage: TimeBucket; ms: number }[] {
  return STAGE_ORDER.map(stage => ({ stage, ms: m.stageAvgMs[stage] })).filter(p => p.ms > 0)
}

const REASONS: Record<string, { pt: string; en: string }> = {
  dependencia: { pt: 'Dependência de outra entrega', en: 'Depends on another delivery' },
  pedido_de_bloqueio: { pt: 'Pedido de bloqueio', en: 'Block requested' },
  limite: { pt: 'Limite de uso da conta', en: 'Account usage limit' },
  maquina: { pt: 'Máquina indisponível', en: 'Machine unavailable' },
  externo: { pt: 'Dependência externa', en: 'External dependency' },
  fora_das_autorizacoes: { pt: 'Fora das autorizações', en: 'Outside the authorisations' },
  decisao_do_dono: { pt: 'Aguardando decisão do dono', en: 'Waiting for the owner' },
  unknown: { pt: 'Motivo não registrado', en: 'Reason not recorded' },
}
export const blockReasonLabel = (reason: string, pt: boolean): string => (REASONS[reason] ? (pt ? REASONS[reason]!.pt : REASONS[reason]!.en) : reason)

/**
 * The lead paragraph — the story in one breath, built only from measured numbers. Each clause is dropped when its
 * figure is unmeasured, so the sentence can be short but never wrong.
 */
export function leadSentence(r: MetricsReply, pt: boolean, cost: (usd: number) => string): string {
  const s = r.summary
  if (s.n === 0) return pt ? 'Nenhuma entrega com esses filtros.' : 'No deliveries with these filters.'
  const parts: string[] = []
  if (s.published > 0) {
    // Under a week there is no weekly average (the API says null): the real count and the window it was counted in instead.
    const week = r.perWeek !== null
      ? (pt ? `, em média ${fmtNum(r.perWeek, true, 1)} por semana` : `, ${fmtNum(r.perWeek, false, 1)} per week on average`)
      : r.range.days < 7 ? (pt ? ` em ${r.range.days} ${r.range.days === 1 ? 'dia' : 'dias'}` : ` in ${r.range.days} ${r.range.days === 1 ? 'day' : 'days'}`) : ''
    parts.push(pt
      ? `${s.published} de ${s.n} entregas foram publicadas${week}.`
      : `${s.published} of ${s.n} deliveries were published${week}.`)
    if (s.leadP50Ms !== null) {
      const p90 = s.leadP90Ms !== null ? (pt ? ` (9 em cada 10 saem em até ${fmtDur(s.leadP90Ms, true)})` : ` (9 in 10 ship within ${fmtDur(s.leadP90Ms, false)})`) : ''
      parts.push(pt
        ? `O tempo mediano do pedido até a publicação é de ${fmtDur(s.leadP50Ms, true)}${p90}.`
        : `The median time from request to publication is ${fmtDur(s.leadP50Ms, false)}${p90}.`)
    }
  } else {
    parts.push(pt
      ? `${s.n} ${s.n === 1 ? 'entrega' : 'entregas'} no período, nenhuma publicada ainda.`
      : `${s.n} ${s.n === 1 ? 'delivery' : 'deliveries'} in the period, ${s.n === 1 ? 'not published yet' : 'none published yet'}.`)
  }
  if (s.qaN > 0) parts.push(pt ? `${s.qaRejected} de ${s.qaN} voltaram da QA (${fmtPct(s.qaRejectionRate, true)}).` : `${s.qaRejected} of ${s.qaN} came back from QA (${fmtPct(s.qaRejectionRate, false)}).`)
  if (s.etaRate !== null) parts.push(pt ? `O ETA acertou em ${fmtPct(s.etaRate, true)} (${s.etaN} com previsão guardada).` : `The ETA was right ${fmtPct(s.etaRate, false)} of the time (${s.etaN} with a stored prediction).`)
  if (s.costPerPublishedUSD !== null) parts.push(pt ? `Cada entrega publicada custou em média ${cost(s.costPerPublishedUSD)}.` : `Each published delivery cost ${cost(s.costPerPublishedUSD)} on average.`)
  return parts.join(' ')
}
