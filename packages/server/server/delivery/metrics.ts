/**
 * delivery/metrics.ts — the IO half of "Evolução de entregas". It gathers what the screen, `GET /api/deliveries/metrics`,
 * the MCP tool (`agentistics_delivery_metrics`) and `agentop flow evolucao` share — the delivery records, the owner
 * requests that created the work, the board's tasks and the cost of the sessions filed under each piece — and hands
 * them to core's pure `buildMetricItems` / `buildMetrics`. It decides nothing: every rule (what a stage is, what a
 * rejection is, which window is "prior") is `@agentistics/core`'s `deliveryMetrics.ts`.
 *
 * Costs come from the SAME rollup the board uses (`rollupAttempt` over the conversations filed under the subtask), so
 * a delivery's cost here equals the cost on its task page; a piece with no priced session has `costUSD: null`.
 */
import {
  GROUP_BYS, METRIC_CURRENT_STAGES, NONE_KEY, QA_RESULTS, brtDayBounds, buildMetricItems, buildMetrics,
  type CalPriority, type CalStage, type GroupBy, type MetricFilters, type MetricInput, type MetricMove, type MetricsReply, type QaResult,
} from '@agentistics/core'
import type { DeliveryRecord } from './machine'

export interface OwnerRequestLite { at: string; linkedSubtaskIds: readonly string[] }
export interface TaskLite { id: string; title: string; priority?: string }
export interface SubtaskLite { id: string; taskId: string; title: string }
export interface SubtaskCost { costUSD: number | null; tokens: number | null; harness: string | null; model: string | null }

const parseMs = (iso: string | undefined): number | null => { const n = iso ? Date.parse(iso) : NaN; return Number.isFinite(n) ? n : null }
const toPriority = (p: string | undefined): CalPriority | null => (p === 'urgent' || p === 'high' || p === 'medium' || p === 'low' ? p : null)
const pickVersion = (v: string | undefined): string | null => (v && v !== 'next' && /^\d+\.\d+\.\d+/.test(v) ? v : null)

/** PURE: the delivery records + the facts around them → the builder's inputs. A dequeued record is not a delivery. */
export function metricInputsFrom(o: {
  records: readonly DeliveryRecord[]
  tasks: readonly TaskLite[]
  subtasks: readonly SubtaskLite[]
  requests: readonly OwnerRequestLite[]
  costs: ReadonlyMap<string, SubtaskCost>
}): MetricInput[] {
  const taskById = new Map(o.tasks.map(t => [t.id, t]))
  const subById = new Map(o.subtasks.map(s => [s.id, s]))
  const firstRequest = new Map<string, number>()
  for (const r of o.requests) {
    const at = parseMs(r.at)
    if (at === null) continue
    for (const id of r.linkedSubtaskIds) { const cur = firstRequest.get(id); if (cur === undefined || at < cur) firstRequest.set(id, at) }
  }
  const out: MetricInput[] = []
  for (const r of o.records) {
    if (r.dequeued) continue
    const createdAtMs = parseMs(r.createdAt)
    if (createdAtMs === null) continue
    const task = taskById.get(r.taskId)
    const cost = o.costs.get(r.subtaskId)
    const history: MetricMove[] = r.history.flatMap(h => { const at = parseMs(h.at); return at === null ? [] : [{ from: h.from, to: h.to, atMs: at, detail: h.detail }] })
    out.push({
      subtaskId: r.subtaskId, taskId: r.taskId, taskTitle: task?.title ?? r.taskId,
      title: subById.get(r.subtaskId)?.title ?? r.subtaskId, priority: toPriority(task?.priority),
      version: pickVersion(r.versionTarget), phase: r.phase, createdAtMs,
      requestedAtMs: firstRequest.get(r.subtaskId) ?? null,
      publishedAtMs: r.phase === 'publicado' ? parseMs(r.publishedAt) : null,
      authorModel: r.authorModel ?? cost?.model ?? null, qaModel: r.qaModel ?? null,
      harness: cost?.harness ?? null, history,
      costUSD: cost?.costUSD ?? null, tokens: cost?.tokens ?? null,
    })
  }
  return out
}

export interface MetricSources { nowMs: number; inputs: MetricInput[] }

/** The most expensive harness of a rollup's split — a delivery belongs to the harness that did most of its work. */
function dominant(split: Record<string, number> | null): string | null {
  if (!split) return null
  let best: string | null = null
  for (const [h, v] of Object.entries(split)) if (h && (best === null || v > (split[best] ?? 0))) best = h
  return best
}

async function readCosts(world: Awaited<ReturnType<typeof import('../sessions/task-source').loadTaskWorld>>): Promise<Map<string, SubtaskCost>> {
  const [{ distinctConversations }, { rollupSessionsFor }, { rollupAttempt }] = await Promise.all([
    import('../sessions/task-conversations'), import('../sessions/task-report'), import('../sessions/task-rollup'),
  ])
  const rows = distinctConversations(world.rollupRows)
  const bySub = new Map<string, typeof rows>()
  for (const r of rows) { if (!r.subtaskId) continue; const l = bySub.get(r.subtaskId); if (l) l.push(r); else bySub.set(r.subtaskId, [r]) }
  const out = new Map<string, SubtaskCost>()
  for (const [id, mine] of bySub) {
    const sessions = rollupSessionsFor(mine, world.metas, world.costOf)
    const roll = rollupAttempt({ sessions })
    // The model that carried the most tokens (an unlinked row has no meta and says nothing).
    const byModel = new Map<string, number>()
    for (const s of sessions) if (s.meta?.model) byModel.set(s.meta.model, (byModel.get(s.meta.model) ?? 0) + (s.meta.output_tokens ?? 0) + (s.meta.input_tokens ?? 0) + 1)
    const model = [...byModel].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    out.set(id, { costUSD: roll.costUSD, tokens: roll.tokens, harness: dominant(roll.costByHarness), model })
  }
  return out
}

export async function readMetricSources(): Promise<MetricSources> {
  const nowMs = Date.now()
  const [{ deliveryService, readOwnerRequests }, { loadTaskWorld }] = await Promise.all([import('./host'), import('../sessions/task-source')])
  const [records, world, requests] = await Promise.all([deliveryService().list(), loadTaskWorld(), readOwnerRequests().catch(() => null)])
  const costs = await readCosts(world).catch(() => new Map<string, SubtaskCost>())
  return {
    nowMs,
    inputs: metricInputsFrom({
      records,
      tasks: world.book.tasks.map(t => ({ id: t.id, title: t.title, ...(t.priority ? { priority: t.priority } : {}) })),
      subtasks: world.book.subtasks.map(s => ({ id: s.id, taskId: s.taskId, title: s.title })),
      requests: (requests ?? []).map(r => ({ at: r.at, linkedSubtaskIds: r.linkedSubtaskIds ?? [] })),
      costs,
    }),
  }
}

export function metricsFrom(src: MetricSources, f: MetricFilters): MetricsReply {
  return buildMetrics(buildMetricItems(src.inputs, src.nowMs), f, src.nowMs)
}

/** The answer an agent asks for, read from the live sources. */
export async function deliveryMetrics(f: MetricFilters): Promise<MetricsReply> {
  return metricsFrom(await readMetricSources(), f)
}

const csv = (s: string | null): string[] | undefined => { const l = (s ?? '').split(',').map(x => x.trim()).filter(Boolean); return l.length ? l : undefined }
const instantOf = (s: string | null, endOfDay: boolean): number | undefined => {
  if (!s) return undefined
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const b = endOfDay ? brtDayBounds(undefined, s).toMs : brtDayBounds(s).fromMs; return b }
  const n = Date.parse(s)
  return Number.isFinite(n) ? n : undefined
}

/**
 * PURE: the query string → filters. `from`/`to` (yyyy-MM-dd BRT days or ISO instants), `harness`, `version`
 * (`none` = no version), `stage`, `model` (author model; `none` = unknown), `qa`, `priority`, `task`, `groupBy`.
 */
export function metricFiltersOf(q: URLSearchParams): MetricFilters {
  const stages = csv(q.get('stage'))?.filter((s): s is CalStage => (METRIC_CURRENT_STAGES as readonly string[]).includes(s))
  const priorities = csv(q.get('priority'))?.filter((s): s is CalPriority => ['urgent', 'high', 'medium', 'low'].includes(s))
  const qa = csv(q.get('qa'))?.filter((s): s is QaResult => (QA_RESULTS as readonly string[]).includes(s))
  const noneAware = (l: string[] | undefined) => l?.map(v => (v === 'none' ? NONE_KEY : v))
  const versions = noneAware(csv(q.get('version'))), models = noneAware(csv(q.get('model'))), harnesses = noneAware(csv(q.get('harness')))
  const fromMs = instantOf(q.get('from'), false), toMs = instantOf(q.get('to'), true)
  const gb = q.get('groupBy')
  return {
    ...(fromMs !== undefined ? { fromMs } : {}),
    ...(toMs !== undefined ? { toMs } : {}),
    ...(harnesses ? { harnesses } : {}),
    ...(versions ? { versions } : {}),
    ...(stages?.length ? { stages } : {}),
    ...(models ? { authorModels: models } : {}),
    ...(qa?.length ? { qa } : {}),
    ...(priorities?.length ? { priorities } : {}),
    ...(q.get('task') ? { task: q.get('task')! } : {}),
    ...(gb && (GROUP_BYS as readonly string[]).includes(gb) ? { groupBy: gb as GroupBy } : {}),
  }
}
