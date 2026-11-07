/**
 * deliveryMetrics.ts — PURE. The read model behind "Evolução de entregas" (Delivery evolution): how long each
 * delivery took from the owner's request to a published release, where the time went, how often QA sent a piece
 * back, what it cost, and how the numbers move over time.
 *
 * ONE builder serves the screen, `GET /api/deliveries/metrics`, the MCP tool `agentistics_delivery_metrics` and
 * `agentop flow evolucao`. A second implementation of "p50 lead time" or "QA rejection rate" would be a second
 * answer to the same question.
 *
 * Rules that are the whole point:
 *  - NOTHING IS INVENTED. Every figure is derived from the delivery record's own history (phase moves with
 *    timestamps), the owner request that created the work, the release's published instant and the sessions filed
 *    under the piece. A metric nobody could measure is `null` (and the UI says so), never `0`.
 *  - The ETA hit rate needs a prediction recorded AT THE TIME. A piece with none is counted in `noEta`, not scored.
 *  - A day is a BRT day (`America/Sao_Paulo`), the same rule the Delivery calendar uses.
 *  - The period filter is applied to the instant a delivery belongs to: its publication, or its request while it is
 *    still open — so "last 21 days" counts what shipped in them, not what merely started in them.
 */
import { brtDay, brtDayStartMs, compareVersions, type CalConfidence, type CalPriority, type CalStage } from './deliveryCalendar'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** Stages a delivery spends measurable time in, in the order it walks them. `blocked` runs beside them. */
export const METRIC_STAGES = ['queue', 'running', 'qa', 'adjust', 'leader', 'merge', 'ci'] as const
export type MetricStage = (typeof METRIC_STAGES)[number]
export type TimeBucket = MetricStage | 'blocked'
/** Every stage a delivery can currently be in (a filter dimension). */
export const METRIC_CURRENT_STAGES: readonly CalStage[] = ['queue', 'running', 'qa', 'adjust', 'leader', 'merge', 'ci', 'published', 'blocked']

export type QaResult = 'first_pass' | 'rejected_once' | 'rejected_many' | 'pending'
export const QA_RESULTS: readonly QaResult[] = ['first_pass', 'rejected_once', 'rejected_many', 'pending']
export type GroupBy = 'day' | 'week' | 'version' | 'model'
export const GROUP_BYS: readonly GroupBy[] = ['day', 'week', 'version', 'model']

const PHASE_BUCKET: Record<string, TimeBucket | 'published'> = {
  fila: 'queue', executando: 'running', qa: 'qa', ajuste: 'adjust', revisao_lider: 'leader', pr_merge: 'merge', ci: 'ci', bloqueado: 'blocked', publicado: 'published',
}

// ---------------------------------------------------------------------------------------------- inputs

/** One phase move of the delivery record (`from` → `to` at `atMs`). `detail` carries the block reason on a move to `bloqueado`. */
export interface MetricMove { from: string; to: string; atMs: number; detail: string }

/** What the builder needs of one delivery — structural, so core imports nothing from the server. */
export interface MetricInput {
  subtaskId: string
  taskId: string
  taskTitle: string
  title: string
  priority: CalPriority | null
  /** The release version it rides (`2.202.0`); null when none is declared or it was deferred to `next`. */
  version: string | null
  /** The record's current phase (`fila`, `executando`, … `publicado`). */
  phase: string
  /** When the record was created (the piece entered the queue). */
  createdAtMs: number
  /** When the owner asked for it (the earliest linked owner request); null when no request is linked. */
  requestedAtMs: number | null
  publishedAtMs: number | null
  authorModel: string | null
  qaModel: string | null
  harness: string | null
  history: readonly MetricMove[]
  /** Cost of the sessions filed under the piece, USD; null when none was priced. */
  costUSD: number | null
  tokens: number | null
  /** An ETA recorded when the work was dispatched. Absent for every record written before ETAs were kept. */
  eta?: { madeAtMs: number; predictedAtMs: number; confidence: CalConfidence | null } | null
}

// ---------------------------------------------------------------------------------------------- items

export interface MetricBlock { reason: string; ms: number; open: boolean }

export interface MetricItem {
  subtaskId: string
  taskId: string
  taskTitle: string
  title: string
  priority: CalPriority | null
  version: string | null
  stage: CalStage
  harness: string | null
  authorModel: string | null
  /** The instant the delivery's lead time starts from, and which fact it is. */
  startMs: number
  startBasis: 'owner' | 'queue'
  publishedAtMs: number | null
  /** The instant the delivery belongs to for the period filter and the time axis. */
  refMs: number
  leadMs: number | null
  stageMs: Record<TimeBucket, number>
  qaResult: QaResult
  /** Times QA sent the piece back. */
  qaRejections: number
  /** Times the piece entered `ajuste` (QA or the leader's review). */
  adjustRounds: number
  blocks: MetricBlock[]
  costUSD: number | null
  tokens: number | null
  eta: { predictedMs: number; actualMs: number; hit: boolean; confidence: CalConfidence | null } | null
  hasEta: boolean
  /** How long it has been (or was) in the queue, ms. */
  queueMs: number
}

const blockReasonOf = (detail: string): string => {
  const m = /^([a-z_]+):/.exec(detail.trim())
  return m ? m[1]! : 'unknown'
}

/** PURE: the segments of a delivery's life — which time bucket it was in, from when to when. */
export function lifeSegments(i: MetricInput, nowMs: number): { bucket: TimeBucket; fromMs: number; toMs: number; reason?: string; open: boolean }[] {
  const moves = [...i.history].sort((a, b) => a.atMs - b.atMs)
  const out: { bucket: TimeBucket; fromMs: number; toMs: number; reason?: string; open: boolean }[] = []
  const push = (phase: string, fromMs: number, toMs: number, detail: string | null, open: boolean) => {
    const b = PHASE_BUCKET[phase]
    if (!b || b === 'published' || toMs <= fromMs) return
    out.push({ bucket: b, fromMs, toMs, ...(b === 'blocked' ? { reason: blockReasonOf(detail ?? '') } : {}), open })
  }
  const end = i.publishedAtMs ?? nowMs
  if (moves.length === 0) { push(i.phase, i.createdAtMs, end, null, i.publishedAtMs === null); return out }
  push(moves[0]!.from, i.createdAtMs, moves[0]!.atMs, null, false)
  for (let k = 0; k < moves.length; k++) {
    const m = moves[k]!
    const next = moves[k + 1]
    // A published delivery's last segment ends at the move into `publicado` (its own entry), never at "now".
    push(m.to, m.atMs, next ? next.atMs : (m.to === 'publicado' ? m.atMs : end), m.detail, !next && i.publishedAtMs === null)
  }
  return out
}

const stageOfPhase = (phase: string): CalStage => {
  const b = PHASE_BUCKET[phase]
  return (b ?? 'queue') as CalStage
}

export function buildMetricItems(inputs: readonly MetricInput[], nowMs: number): MetricItem[] {
  return inputs.map(i => {
    const stageMs = { queue: 0, running: 0, qa: 0, adjust: 0, leader: 0, merge: 0, ci: 0, blocked: 0 } as Record<TimeBucket, number>
    const blocks: MetricBlock[] = []
    for (const s of lifeSegments(i, nowMs)) {
      stageMs[s.bucket] += s.toMs - s.fromMs
      if (s.bucket === 'blocked') blocks.push({ reason: s.reason ?? 'unknown', ms: s.toMs - s.fromMs, open: s.open })
    }
    const startMs = i.requestedAtMs !== null && i.requestedAtMs <= i.createdAtMs ? i.requestedAtMs : i.createdAtMs
    const startBasis: 'owner' | 'queue' = i.requestedAtMs !== null && i.requestedAtMs <= i.createdAtMs ? 'owner' : 'queue'
    const moves = i.history
    const qaRejections = moves.filter(m => m.from === 'qa' && m.to === 'ajuste').length
    const adjustRounds = moves.filter(m => m.to === 'ajuste').length
    const leftQa = moves.some(m => m.from === 'qa')
    const qaResult: QaResult = !leftQa ? 'pending' : qaRejections === 0 ? 'first_pass' : qaRejections === 1 ? 'rejected_once' : 'rejected_many'
    const published = i.publishedAtMs !== null
    const leadMs = published ? Math.max(0, i.publishedAtMs! - startMs) : null
    // The queue stage includes the wait before the record existed when the owner asked earlier.
    stageMs.queue += Math.max(0, i.createdAtMs - startMs)
    let eta: MetricItem['eta'] = null
    if (i.eta && published) {
      const predictedMs = Math.max(1, i.eta.predictedAtMs - i.eta.madeAtMs), actualMs = i.publishedAtMs! - i.eta.madeAtMs
      eta = { predictedMs, actualMs, hit: Math.abs(actualMs - predictedMs) <= 0.25 * predictedMs, confidence: i.eta.confidence }
    }
    return {
      subtaskId: i.subtaskId, taskId: i.taskId, taskTitle: i.taskTitle, title: i.title, priority: i.priority, version: i.version,
      stage: stageOfPhase(i.phase), harness: i.harness, authorModel: i.authorModel,
      startMs, startBasis, publishedAtMs: i.publishedAtMs, refMs: i.publishedAtMs ?? startMs, leadMs, stageMs,
      qaResult, qaRejections, adjustRounds, blocks, costUSD: i.costUSD, tokens: i.tokens, eta, hasEta: !!i.eta,
      queueMs: stageMs.queue,
    }
  })
}

// ---------------------------------------------------------------------------------------------- filters

export interface MetricFilters {
  /** Epoch ms bounds (inclusive) on the instant a delivery belongs to (`refMs`). */
  fromMs?: number
  toMs?: number
  harnesses?: readonly string[]
  versions?: readonly string[]
  /** The stage a delivery is in NOW. */
  stages?: readonly CalStage[]
  authorModels?: readonly string[]
  qa?: readonly QaResult[]
  priorities?: readonly CalPriority[]
  /** A task id, or part of its title (case-insensitive). */
  task?: string
  groupBy?: GroupBy
}

/** The sentinel a filter uses for "no version" / "no model" / "no harness". */
export const NONE_KEY = '__none__'

export function itemMatches(it: MetricItem, f: MetricFilters, skip?: keyof MetricFilters): boolean {
  if (skip !== 'fromMs' && f.fromMs !== undefined && it.refMs < f.fromMs) return false
  if (skip !== 'toMs' && f.toMs !== undefined && it.refMs > f.toMs) return false
  const has = (list: readonly string[] | undefined, v: string | null) => !list?.length || list.includes(v ?? NONE_KEY)
  if (skip !== 'harnesses' && !has(f.harnesses, it.harness)) return false
  if (skip !== 'versions' && !has(f.versions, it.version)) return false
  if (skip !== 'authorModels' && !has(f.authorModels, it.authorModel)) return false
  if (skip !== 'stages' && f.stages?.length && !f.stages.includes(it.stage)) return false
  if (skip !== 'qa' && f.qa?.length && !f.qa.includes(it.qaResult)) return false
  if (skip !== 'priorities' && f.priorities?.length && (!it.priority || !f.priorities.includes(it.priority))) return false
  if (skip !== 'task' && f.task) {
    const q = f.task.toLowerCase()
    if (it.taskId !== f.task && !it.taskTitle.toLowerCase().includes(q)) return false
  }
  return true
}

export function filterMetricItems(items: readonly MetricItem[], f: MetricFilters): MetricItem[] {
  return items.filter(it => itemMatches(it, f))
}

// ---------------------------------------------------------------------------------------------- metrics

/** Linear-interpolated percentile of a list; null when empty. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i)
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo)
}
const sum = (a: readonly number[]): number => a.reduce((x, y) => x + y, 0)
const rate = (n: number, d: number): number | null => (d > 0 ? n / d : null)

export interface Metrics {
  /** Deliveries in scope, and how many of them shipped. */
  n: number
  published: number
  leadP50Ms: number | null
  leadP90Ms: number | null
  /** Deliveries whose QA verdict is known, how many were sent back at least once, and the rate. */
  qaN: number
  qaRejected: number
  qaRejectionRate: number | null
  /** Average trips to `ajuste` per published delivery. */
  adjustAvg: number | null
  /** Published deliveries that carried a recorded ETA, how many landed within ±25%, and the rate. */
  etaN: number
  etaHits: number
  etaRate: number | null
  /** Published deliveries without a recorded ETA — not scored, not guessed. */
  noEta: number
  costUSD: number | null
  tokens: number | null
  /** Average cost of a published delivery whose cost is known. */
  costPerPublishedUSD: number | null
  costKnown: number
  blockedNow: number
  blockedAny: number
  blockMs: number
  /** Average time in each stage over the PUBLISHED deliveries. */
  stageAvgMs: Record<TimeBucket, number>
}

export function computeMetrics(items: readonly MetricItem[]): Metrics {
  const pub = items.filter(i => i.publishedAtMs !== null)
  const leads = pub.map(i => i.leadMs!).filter(n => Number.isFinite(n))
  const qaDone = items.filter(i => i.qaResult !== 'pending')
  const qaRej = qaDone.filter(i => i.qaRejections > 0)
  const etaItems = pub.filter(i => i.eta)
  const etaHits = etaItems.filter(i => i.eta!.hit)
  const costs = items.flatMap(i => (i.costUSD !== null ? [i.costUSD] : []))
  const tokens = items.flatMap(i => (i.tokens !== null ? [i.tokens] : []))
  const pubCosts = pub.flatMap(i => (i.costUSD !== null ? [i.costUSD] : []))
  const stageAvgMs = {} as Record<TimeBucket, number>
  for (const b of [...METRIC_STAGES, 'blocked'] as TimeBucket[]) stageAvgMs[b] = pub.length ? sum(pub.map(i => i.stageMs[b])) / pub.length : 0
  return {
    n: items.length, published: pub.length,
    leadP50Ms: percentile(leads, 0.5), leadP90Ms: percentile(leads, 0.9),
    qaN: qaDone.length, qaRejected: qaRej.length, qaRejectionRate: rate(qaRej.length, qaDone.length),
    adjustAvg: pub.length ? sum(pub.map(i => i.adjustRounds)) / pub.length : null,
    etaN: etaItems.length, etaHits: etaHits.length, etaRate: rate(etaHits.length, etaItems.length), noEta: pub.length - etaItems.length,
    costUSD: costs.length ? sum(costs) : null, tokens: tokens.length ? sum(tokens) : null,
    costPerPublishedUSD: pubCosts.length ? sum(pubCosts) / pubCosts.length : null, costKnown: pubCosts.length,
    blockedNow: items.filter(i => i.stage === 'blocked').length,
    blockedAny: items.filter(i => i.blocks.length > 0).length,
    blockMs: sum(items.map(i => i.stageMs.blocked)),
    stageAvgMs,
  }
}

// ---------------------------------------------------------------------------------------------- groups

export interface MetricGroup { key: string; label: string; short: string; metrics: Metrics }

const MAX_BUCKETS = 120

/** Monday of the BRT week containing the instant, as a `yyyy-MM-dd` day. */
export function brtWeekStart(ms: number): string {
  const day = brtDay(ms)
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay() // 0 = Sunday
  const back = (dow + 6) % 7
  return brtDay(brtDayStartMs(day) + 12 * HOUR - back * DAY)
}
const addDays = (day: string, n: number): string => brtDay(brtDayStartMs(day) + 12 * HOUR + n * DAY)
const dayNum = (day: string): number => Math.round(Date.parse(`${day}T00:00:00Z`) / DAY)

export function effectiveGroupBy(want: GroupBy, spanDays: number): GroupBy {
  return want === 'day' && spanDays > MAX_BUCKETS ? 'week' : want
}

/**
 * Buckets the scoped items on the chosen axis. `day`/`week` are continuous (an empty day is a real empty bucket, so a
 * trend shows the gap instead of joining across it); `version`/`model` list only what exists.
 */
export function buildGroups(items: readonly MetricItem[], by: GroupBy, range: { fromMs: number; toMs: number }): MetricGroup[] {
  if (by === 'version' || by === 'model') {
    const buckets = new Map<string, MetricItem[]>()
    for (const it of items) {
      const k = (by === 'version' ? it.version : it.authorModel) ?? NONE_KEY
      const l = buckets.get(k); if (l) l.push(it); else buckets.set(k, [it])
    }
    const keys = [...buckets.keys()]
    if (by === 'version') keys.sort((a, b) => (a === NONE_KEY ? 1 : b === NONE_KEY ? -1 : compareVersions(a, b)))
    else keys.sort((a, b) => (a === NONE_KEY ? 1 : b === NONE_KEY ? -1 : buckets.get(b)!.length - buckets.get(a)!.length || a.localeCompare(b)))
    return keys.map(k => ({ key: k, label: k, short: k === NONE_KEY ? '—' : by === 'version' ? k.replace(/^\d+\./, '') : k, metrics: computeMetrics(buckets.get(k)!) }))
  }
  const firstDay = brtDay(range.fromMs), lastDay = brtDay(range.toMs)
  const week = by === 'week'
  const startKey = week ? brtWeekStart(range.fromMs) : firstDay
  const keys: string[] = []
  for (let d = startKey; dayNum(d) <= dayNum(lastDay) && keys.length < MAX_BUCKETS; d = addDays(d, week ? 7 : 1)) keys.push(d)
  const buckets = new Map<string, MetricItem[]>(keys.map(k => [k, []]))
  for (const it of items) {
    const day = brtDay(Math.min(Math.max(it.refMs, range.fromMs), range.toMs))
    const k = week ? brtWeekStart(brtDayStartMs(day) + 12 * HOUR) : day
    buckets.get(k)?.push(it)
  }
  return keys.map(k => ({ key: k, label: k, short: k.slice(8) + '/' + k.slice(5, 7), metrics: computeMetrics(buckets.get(k)!) }))
}

// ---------------------------------------------------------------------------------------------- the reply

export interface FunnelRow { stage: MetricStage; reached: number; now: number; medianMs: number | null; avgMs: number | null }
export interface Bottleneck { stage: TimeBucket; share: number; avgMs: number; byAuthor: { model: string; avgMs: number; n: number }[] }
export interface QaByAuthor { model: string; n: number; rejected: number; rate: number | null; adjustAvg: number | null }
export interface BlockByReason { reason: string; ms: number; count: number }
export interface CostSlice { key: string; costUSD: number; deliveries: number }
export interface QueueRow { subtaskId: string; taskId: string; title: string; priority: CalPriority | null; ageMs: number }
export interface MetricRow {
  subtaskId: string; taskId: string; taskTitle: string; title: string; stage: CalStage; version: string | null; priority: CalPriority | null
  authorModel: string | null; harness: string | null; startMs: number; publishedAtMs: number | null; leadMs: number | null
  qaResult: QaResult; qaRejections: number; adjustRounds: number; blockedMs: number; costUSD: number | null; tokens: number | null
  stageMs: Record<TimeBucket, number>
}

export interface MetricOptions {
  versions: string[]; authorModels: string[]; harnesses: string[]; tasks: { id: string; title: string }[]
}

export interface MetricsReply {
  generatedAt: string
  nowMs: number
  timezone: 'America/Sao_Paulo'
  filters: MetricFilters
  range: { fromMs: number; toMs: number; days: number }
  groupBy: GroupBy
  summary: Metrics
  /** The window of the same length just before the filtered one; null when the period is open or a version is chosen. */
  prior: Metrics | null
  groups: MetricGroup[]
  /** The groups the quality and cost TRENDS draw: weekly when `groupBy` is day (a day holds too few deliveries for a rate), else `groups`. */
  trendGroups: MetricGroup[]
  /** Throughput of published deliveries per 7 days over the range. */
  perWeek: number | null
  funnel: FunnelRow[]
  bottleneck: Bottleneck | null
  qaByAuthor: QaByAuthor[]
  etaPoints: { subtaskId: string; title: string; predictedMs: number; actualMs: number; model: string | null; confidence: CalConfidence | null }[]
  blocks: BlockByReason[]
  costByAuthor: CostSlice[]
  costByHarness: CostSlice[]
  queue: QueueRow[]
  rows: MetricRow[]
  rowsTotal: number
  options: MetricOptions
  /** Whether any delivery exists at all, before filters — separates "no data" from "the filters left nothing". */
  anyData: boolean
}

const ROW_CAP = 500

const slices = (items: readonly MetricItem[], keyOf: (i: MetricItem) => string | null): CostSlice[] => {
  const m = new Map<string, { costUSD: number; deliveries: number }>()
  for (const i of items) {
    if (i.costUSD === null) continue
    const k = keyOf(i) ?? NONE_KEY
    const s = m.get(k) ?? { costUSD: 0, deliveries: 0 }
    s.costUSD += i.costUSD; s.deliveries += 1; m.set(k, s)
  }
  return [...m].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.costUSD - a.costUSD)
}

export function buildMetrics(all: readonly MetricItem[], f: MetricFilters, nowMs: number): MetricsReply {
  const items = filterMetricItems(all, f)
  const refs = all.map(i => i.refMs)
  const fromMs = f.fromMs ?? (refs.length ? Math.min(...refs) : nowMs)
  const toMs = f.toMs ?? Math.max(nowMs, ...(refs.length ? refs : [nowMs]))
  const days = Math.max(1, Math.round((toMs - fromMs) / DAY))
  const groupBy = effectiveGroupBy(f.groupBy ?? 'day', days)
  const summary = computeMetrics(items)
  const groups = buildGroups(items, groupBy, { fromMs, toMs })

  let prior: Metrics | null = null
  if (f.fromMs !== undefined && f.toMs !== undefined && !f.versions?.length) {
    const len = f.toMs - f.fromMs + 1
    prior = computeMetrics(filterMetricItems(all, { ...f, fromMs: f.fromMs - len, toMs: f.fromMs - 1 }))
  }

  const pub = items.filter(i => i.publishedAtMs !== null)
  const funnel: FunnelRow[] = METRIC_STAGES.map(stage => {
    const idx = METRIC_STAGES.indexOf(stage)
    const reached = items.filter(i => {
      if (stage === 'adjust') return i.adjustRounds > 0 || i.stage === 'adjust'
      const cur = i.stage === 'published' ? METRIC_STAGES.length : i.stage === 'blocked' ? -1 : METRIC_STAGES.indexOf(i.stage as MetricStage)
      return cur >= idx || i.stageMs[stage] > 0
    })
    const times = reached.map(i => i.stageMs[stage]).filter(v => v > 0)
    return { stage, reached: reached.length, now: items.filter(i => i.stage === stage).length, medianMs: percentile(times, 0.5), avgMs: times.length ? sum(times) / times.length : null }
  })

  let bottleneck: Bottleneck | null = null
  if (pub.length) {
    const totals = {} as Record<TimeBucket, number>
    for (const b of [...METRIC_STAGES, 'blocked'] as TimeBucket[]) totals[b] = sum(pub.map(i => i.stageMs[b]))
    const grand = sum(Object.values(totals))
    const top = (Object.keys(totals) as TimeBucket[]).reduce((a, b) => (totals[b] > totals[a] ? b : a))
    if (grand > 0 && totals[top] > 0) {
      const byModel = new Map<string, number[]>()
      for (const i of pub) { const k = i.authorModel ?? NONE_KEY; const l = byModel.get(k); const v = i.stageMs[top]; if (l) l.push(v); else byModel.set(k, [v]) }
      bottleneck = {
        stage: top, share: totals[top] / grand, avgMs: totals[top] / pub.length,
        byAuthor: [...byModel].map(([model, v]) => ({ model, avgMs: sum(v) / v.length, n: v.length })).sort((a, b) => b.avgMs - a.avgMs),
      }
    }
  }

  const authors = new Map<string, MetricItem[]>()
  for (const i of items) { const k = i.authorModel ?? NONE_KEY; const l = authors.get(k); if (l) l.push(i); else authors.set(k, [i]) }
  const qaByAuthor: QaByAuthor[] = [...authors].map(([model, its]) => {
    const m = computeMetrics(its)
    return { model, n: m.qaN, rejected: m.qaRejected, rate: m.qaRejectionRate, adjustAvg: m.adjustAvg }
  }).filter(a => a.n > 0).sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0) || b.n - a.n)

  const blockMap = new Map<string, { ms: number; keys: Set<string> }>()
  for (const i of items) for (const b of i.blocks) {
    const s = blockMap.get(b.reason) ?? { ms: 0, keys: new Set<string>() }
    s.ms += b.ms; s.keys.add(i.subtaskId); blockMap.set(b.reason, s)
  }
  const blocks: BlockByReason[] = [...blockMap].map(([reason, s]) => ({ reason, ms: s.ms, count: s.keys.size })).sort((a, b) => b.ms - a.ms)

  const queue = items.filter(i => i.stage === 'queue')
    .map(i => ({ subtaskId: i.subtaskId, taskId: i.taskId, title: i.title, priority: i.priority, ageMs: nowMs - i.startMs }))
    .sort((a, b) => b.ageMs - a.ageMs).slice(0, 8)

  const options: MetricOptions = {
    versions: [...new Set(all.flatMap(i => (i.version ? [i.version] : [])))].sort((a, b) => compareVersions(b, a)),
    authorModels: [...new Set(all.flatMap(i => (i.authorModel ? [i.authorModel] : [])))].sort(),
    harnesses: [...new Set(all.flatMap(i => (i.harness ? [i.harness] : [])))].sort(),
    tasks: [...new Map(all.map(i => [i.taskId, i.taskTitle] as const))].map(([id, title]) => ({ id, title })).sort((a, b) => a.title.localeCompare(b.title)),
  }

  const sorted = [...items].sort((a, b) => b.refMs - a.refMs)
  return {
    generatedAt: new Date(nowMs).toISOString(), nowMs, timezone: 'America/Sao_Paulo', filters: { ...f, groupBy },
    range: { fromMs, toMs, days }, groupBy, summary, prior,
    groups,
    trendGroups: groupBy === 'day' ? buildGroups(items, 'week', { fromMs, toMs }) : groups,
    perWeek: summary.published > 0 ? summary.published / (days / 7) : null,
    funnel, bottleneck, qaByAuthor,
    etaPoints: pub.filter(i => i.eta).map(i => ({ subtaskId: i.subtaskId, title: i.title, predictedMs: i.eta!.predictedMs, actualMs: i.eta!.actualMs, model: i.authorModel, confidence: i.eta!.confidence })),
    blocks,
    costByAuthor: slices(items, i => i.authorModel), costByHarness: slices(items, i => i.harness),
    queue,
    rows: sorted.slice(0, ROW_CAP).map(i => ({
      subtaskId: i.subtaskId, taskId: i.taskId, taskTitle: i.taskTitle, title: i.title, stage: i.stage, version: i.version, priority: i.priority,
      authorModel: i.authorModel, harness: i.harness, startMs: i.startMs, publishedAtMs: i.publishedAtMs, leadMs: i.leadMs,
      qaResult: i.qaResult, qaRejections: i.qaRejections, adjustRounds: i.adjustRounds, blockedMs: i.stageMs.blocked, costUSD: i.costUSD, tokens: i.tokens,
      stageMs: i.stageMs,
    })),
    rowsTotal: items.length, options, anyData: all.length > 0,
  }
}

/** BRT start of a `yyyy-MM-dd` day, and its last millisecond — the bounds a day-range filter turns into. */
export function brtDayBounds(from?: string, to?: string): { fromMs?: number; toMs?: number } {
  return {
    ...(from ? { fromMs: brtDayStartMs(from) } : {}),
    ...(to ? { toMs: brtDayStartMs(to) + DAY - 1 } : {}),
  }
}
