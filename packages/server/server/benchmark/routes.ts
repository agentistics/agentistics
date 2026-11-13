import type { MetricInput, MetricFilters, MetricMove, SessionMeta } from '@agentistics/core'
import { buildMetricItems, sessionModelUsage } from '@agentistics/core'
import { buildObserved, sessionCost, type ObservedSession } from '@agentistics/core/benchmark'
import type { SessionRole } from '@agentistics/core/benchmark'
import { TASKS_FILE } from '../config'
import { createTaskStore } from '../sessions/task-store'
import { readRegistry } from '../sessions/registry'
import { createDeliveryStore } from '../delivery/store'
import { loadConsolidated } from '../consolidate'

export interface BenchmarkRouteDeps {
  observed: (filters?: MetricFilters) => Promise<ReturnType<typeof buildObserved>>
  experiments: () => Promise<[]> | []
}

/** The four stores the read model reads, as plain data, so a test can hand it a synthetic store. */
export interface BenchmarkSources {
  nowMs: number
  book: {
    tasks: readonly { id: string; title: string }[]
    subtasks: readonly { id: string; taskId: string; title: string; status: string; createdAt: string; deliveredAt?: string }[]
    historicalSessions: readonly { conversationId: string; harness: string; subtaskId?: string; linkedAt: string }[]
  }
  /** `managed-sessions.json` rows (a subset of ManagedSession). */
  registry: readonly {
    id: string; harness: string; createdAt: string; conversationId?: string; subtaskId?: string; taskId?: string; model?: string; leader?: boolean
  }[]
  /** The consolidated session store, keyed by the CONVERSATION id (`session_id`). */
  metas: ReadonlyMap<string, SessionMeta>
  /** `deliveries.json`: the delivery flow's records, with their phase history. */
  deliveries: Readonly<Record<string, {
    subtaskId: string; phase: string; createdAt?: string; leaderSessionId?: string; authorSessionId?: string; qaSessionId?: string
    history: readonly { from: string; to: string; at: string; detail?: string }[]
  }>>
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

function filters(url: URL): MetricFilters {
  const from = Number(url.searchParams.get('from'))
  const to = Number(url.searchParams.get('to'))
  return {
    ...(Number.isFinite(from) && from > 0 ? { fromMs: from } : {}),
    ...(Number.isFinite(to) && to > 0 ? { toMs: to } : {}),
    ...(url.searchParams.get('task') ? { task: url.searchParams.get('task')! } : {}),
  }
}

const ms = (iso: string | undefined): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

/** The flow words its own adoption of a piece already under way in the first move's detail ("adotada: …"). */
const ADOPTION = /^\s*adotad/i

interface Statement { conversationId: string | null; id: string; harness: string; subtaskId: string | null; at: number; ids: string[]; leader: boolean }

/** PURE: one session per conversation, filed where its NEWEST filing statement says (a row with an empty `taskId` un-files it). */
function sessionStatements(s: BenchmarkSources): Statement[] {
  const out = new Map<string, Statement>()
  const put = (key: string, st: Statement, ids: string[], leader: boolean) => {
    const prev = out.get(key)
    if (!prev || st.at >= prev.at) out.set(key, { ...st, ids: [...(prev?.ids ?? []), ...ids], leader: leader || !!prev?.leader })
    else out.set(key, { ...prev, ids: [...prev.ids, ...ids], leader: prev.leader || leader })
  }
  for (const r of s.registry) {
    const says = !!r.subtaskId || r.taskId === ''
    const key = r.conversationId ? `c:${r.conversationId}` : `r:${r.id}`
    const at = ms(r.createdAt) ?? 0
    if (!says) {
      // a row that says nothing never decides, but its id still belongs to the conversation (role lookup)
      const prev = out.get(key)
      if (prev) { prev.ids.push(r.id); prev.leader ||= !!r.leader } else if (r.conversationId) out.set(key, { conversationId: r.conversationId, id: r.id, harness: r.harness, subtaskId: null, at: -1, ids: [r.id], leader: !!r.leader })
      continue
    }
    put(key, { conversationId: r.conversationId ?? null, id: r.id, harness: r.harness, subtaskId: r.subtaskId ?? null, at, ids: [], leader: false }, [r.id], !!r.leader)
  }
  for (const h of s.book.historicalSessions) {
    put(`c:${h.conversationId}`, { conversationId: h.conversationId, id: `hist:${h.conversationId}`, harness: h.harness, subtaskId: h.subtaskId ?? null, at: ms(h.linkedAt) ?? 0, ids: [], leader: false }, [], false)
  }
  return [...out.values()].filter(x => x.subtaskId)
}

/** PURE: the whole read model over plain data. Every figure comes from a record named in `Observed.origin`. */
export function buildObservedFromSources(s: BenchmarkSources, observedFilters?: MetricFilters): ReturnType<typeof buildObserved> {
  const taskTitle = new Map(s.book.tasks.map(t => [t.id, t.title]))
  const statements = sessionStatements(s)
  const bySubtask = new Map<string, ObservedSession[]>()

  for (const st of statements) {
    const meta = st.conversationId ? s.metas.get(st.conversationId) : undefined
    const hasUsage = !!meta && !meta.tokens_unavailable && (
      (meta.input_tokens ?? 0) > 0 || (meta.output_tokens ?? 0) > 0 || (meta.cache_read_input_tokens ?? 0) > 0 || (meta.cache_creation_input_tokens ?? 0) > 0
    )
    const row = s.registry.find(r => st.ids.includes(r.id) && r.model)
    const rowModel = row?.model
    let cost: ObservedSession['cost']
    if (meta && hasUsage) {
      // model_usage (several models) wins; otherwise the meta's own model, then the registry row's
      const turns = sessionModelUsage(meta, rowModel).map(([model, u]) => ({
        model, tokens: {
          input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadInputTokens, cacheWrite: u.cacheCreationInputTokens,
          // the 1 h / 5 min split, exactly as the Costs page prices it
          ...(u.cacheCreation1hInputTokens !== undefined ? { cacheWrite1h: u.cacheCreation1hInputTokens } : {}),
          ...(u.cacheCreation5mInputTokens !== undefined ? { cacheWrite5m: u.cacheCreation5mInputTokens } : {}),
        },
      }))
      cost = turns.length
        ? sessionCost(turns)
        : { costUSD: null, missing: 'price', basis: 'table×tokens', priceTable: sessionCost([]).priceTable }
    } else {
      cost = { costUSD: null, missing: 'tokens', basis: 'table×tokens', priceTable: sessionCost([]).priceTable }
    }
    const rec = s.deliveries[st.subtaskId!]
    const role: SessionRole = st.leader || (rec?.leaderSessionId !== undefined && st.ids.includes(rec.leaderSessionId)) ? 'leader'
      : rec?.authorSessionId !== undefined && st.ids.includes(rec.authorSessionId) ? 'worker'
      : rec?.qaSessionId !== undefined && st.ids.includes(rec.qaSessionId) ? 'qa'
      : 'unknown'
    const session: ObservedSession = { id: st.id, subtaskId: st.subtaskId, harness: st.harness, role, cost, hasTokens: hasUsage }
    bySubtask.set(st.subtaskId!, [...(bySubtask.get(st.subtaskId!) ?? []), session])
  }

  const abandoned = new Set(s.book.subtasks.filter(x => x.status === 'abandoned').map(x => x.id))
  const historyKnown = new Set<string>()
  const historyComplete = new Set<string>()
  const requestStart = new Set<string>()
  const inputs: MetricInput[] = []
  for (const sub of s.book.subtasks) {
    const rec = s.deliveries[sub.id]
    const isAbandonedWithSessions = abandoned.has(sub.id) && (bySubtask.get(sub.id)?.length ?? 0) > 0
    // A real delivery went through the delivery flow or was published. Todo, deferred and unrecorded work is not one.
    if (!rec && !sub.deliveredAt && !isAbandonedWithSessions) continue
    const history: MetricMove[] = (rec?.history ?? []).flatMap(m => {
      const at = ms(m.at)
      return at === null ? [] : [{ from: m.from, to: m.to, atMs: at, detail: m.detail ?? '' }]
    })
    if (rec && history.length > 0) historyKnown.add(sub.id)
    // A record the flow ADOPTED (its first move says so, or it recorded no move at all) starts mid-way: its
    // creation is a bookkeeping event, not the start of the work. Lead time then starts at the request (the
    // subtask's creation) and active time is not measured for it.
    const first = [...history].sort((a, b) => a.atMs - b.atMs)[0]
    const adopted = !!rec && (history.length === 0 || ADOPTION.test(first?.detail ?? ''))
    if (rec && history.length > 0 && !adopted) historyComplete.add(sub.id)
    if (adopted) requestStart.add(sub.id)
    const published = history.find(m => m.to === 'publicado')?.atMs ?? ms(sub.deliveredAt)
    const sessions = bySubtask.get(sub.id) ?? []
    inputs.push({
      subtaskId: sub.id, taskId: sub.taskId, taskTitle: taskTitle.get(sub.taskId) ?? '', title: sub.title,
      priority: null, version: null, phase: rec?.phase ?? (published !== null ? 'publicado' : 'fila'),
      createdAtMs: ms(rec?.createdAt) ?? ms(sub.createdAt) ?? 0,
      requestedAtMs: adopted ? ms(sub.createdAt) : null, publishedAtMs: published, authorModel: null, qaModel: null, harness: sessions[0]?.harness ?? null,
      history, costUSD: null, tokens: null,
    })
  }
  const items = buildMetricItems(inputs, s.nowMs)
  const observedSessions = [...bySubtask.values()].flat()
  const iso = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? new Date(v).toISOString() : null)
  return buildObserved({
    items, sessions: observedSessions, historyKnown, historyComplete, requestStart, abandoned, filters: observedFilters,
    period: { from: iso(observedFilters?.fromMs), to: iso(observedFilters?.toMs) },
  })
}

let cache: { at: number; sources: Promise<BenchmarkSources> } | null = null
const CACHE_MS = 15_000

/** Reads the four local stores. The consolidated store is the token source: it does not depend on the app version or home. */
async function readSources(): Promise<BenchmarkSources> {
  const [book, registry, metas, deliveries] = await Promise.all([
    createTaskStore(TASKS_FILE).read(), readRegistry(), loadConsolidated(), createDeliveryStore().read(),
  ])
  const byConversation = new Map<string, SessionMeta>()
  for (const m of metas.values()) {
    byConversation.set(m.session_id, m)
    if (m.native_session_id && !byConversation.has(m.native_session_id)) byConversation.set(m.native_session_id, m)
  }
  return { nowMs: Date.now(), book, registry, metas: byConversation, deliveries: deliveries.deliveries as BenchmarkSources['deliveries'] }
}

/** Reads only the local stores already used by the server. Missing usage remains unmeasured. */
export async function liveObserved(observedFilters?: MetricFilters): Promise<ReturnType<typeof buildObserved>> {
  if (!cache || Date.now() - cache.at > CACHE_MS) cache = { at: Date.now(), sources: readSources() }
  try { return buildObservedFromSources(await cache.sources, observedFilters) } catch (e) { cache = null; throw e }
}

export async function handleBenchmarkRequest(req: Request, url: URL, deps: BenchmarkRouteDeps = {
  observed: liveObserved,
  experiments: () => [],
}): Promise<Response> {
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405)
  if (url.pathname === '/api/benchmark/observed') return json(await deps.observed(filters(url)))
  if (url.pathname === '/api/benchmark/experiments') return json(await deps.experiments())
  return json({ error: 'not_found' }, 404)
}
