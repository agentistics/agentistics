import type { MetricInput, MetricFilters, MetricMove, SessionMeta } from '@agentistics/core'
import { buildMetricItems, sessionModelUsage } from '@agentistics/core'
import { buildHistory, buildObserved, qaRoundsFromLabels, reviewRoundsFromHistory, sessionCost, type HistoryPieceInput, type ObservedSession } from '@agentistics/core/benchmark'
import type { SessionRole } from '@agentistics/core/benchmark'
import { TASKS_FILE } from '../config'
import { createTaskStore } from '../sessions/task-store'
import { readRegistry } from '../sessions/registry'
import { createDeliveryStore } from '../delivery/store'
import { loadConsolidated } from '../consolidate'
import { readAllEvents } from '../events/event-store'
import { archivedLinks, type ArchivedComment, type ArchivedConversation } from './archived-links'

export interface BenchmarkRouteDeps {
  observed: (filters?: MetricFilters) => Promise<ReturnType<typeof buildObserved>>
  experiments: () => Promise<[]> | []
}

/** The four stores the read model reads, as plain data, so a test can hand it a synthetic store. */
export interface BenchmarkSources {
  nowMs: number
  book: {
    tasks: readonly { id: string; title: string; status?: string }[]
    subtasks: readonly { id: string; taskId: string; title: string; status: string; createdAt: string; updatedAt?: string; startedAt?: string; deliveredAt?: string; provenance?: { at: string } }[]
    historicalSessions: readonly { conversationId: string; harness: string; subtaskId?: string; linkedAt: string }[]
    /** The board's comments: a session's own comments name the piece it worked on (see `archived-links.ts`). */
    comments?: readonly ArchivedComment[]
  }
  /** Managed session id -> conversation, for sessions that left the live registry (event inbox). */
  conversations?: ReadonlyMap<string, ArchivedConversation>
  /** `managed-sessions.json` rows (a subset of ManagedSession). */
  registry: readonly {
    id: string; harness: string; createdAt: string; conversationId?: string; subtaskId?: string; taskId?: string; model?: string; leader?: boolean; label?: string
  }[]
  /** The consolidated session store, keyed by the CONVERSATION id (`session_id`). */
  metas: ReadonlyMap<string, SessionMeta>
  /** `deliveries.json`: the delivery flow's records, with their phase history. */
  deliveries: Readonly<Record<string, {
    subtaskId: string; phase: string; createdAt?: string; leaderSessionId?: string; authorSessionId?: string; qaSessionId?: string; authorModel?: string; qaModel?: string
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
  // Sessions that LEFT the registry: filed where their own comments say, only when nothing live or historical already filed the conversation.
  const leaderIds = new Set<string>([...s.registry.filter(r => r.leader).map(r => r.id), ...Object.values(s.deliveries).flatMap(d => d.leaderSessionId ? [d.leaderSessionId] : [])])
  for (const l of archivedLinks({
    comments: s.book.comments ?? [], conversations: s.conversations ?? new Map(), leaderIds, subtasks: new Set(s.book.subtasks.map(x => x.id)),
  })) {
    const key = `c:${l.conversationId}`
    if ((out.get(key)?.at ?? -1) >= 0) continue
    put(key, { conversationId: l.conversationId, id: l.sessionId, harness: l.harness, subtaskId: l.subtaskId, at: l.atMs, ids: [], leader: false }, [l.sessionId], false)
  }
  return [...out.values()].filter(x => x.subtaskId)
}

/** The model a session spent most tokens on: the pieces are compared by who wrote them. */
function dominantModel(turns: readonly [string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }][]): string | null {
  let best: string | null = null, bw = -1
  for (const [m, u] of turns) { const w = u.inputTokens + u.outputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens; if (w > bw) { best = m; bw = w } }
  return best
}

/** PURE: the whole read model over plain data. Every figure comes from a record named in `Observed.origin`. */
export function buildObservedFromSources(s: BenchmarkSources, observedFilters?: MetricFilters): ReturnType<typeof buildObserved> {
  const taskTitle = new Map(s.book.tasks.map(t => [t.id, t.title]))
  const statements = sessionStatements(s)
  const bySubtask = new Map<string, ObservedSession[]>()
  const sessionModels = new Map<ObservedSession, string | null>()
  const pieceFacts = new Map<string, { lines: number | null; startMs: number | null; labels: string[] }>()

  for (const st of statements) {
    const meta = st.conversationId ? s.metas.get(st.conversationId) : undefined
    const hasUsage = !!meta && !meta.tokens_unavailable && (
      (meta.input_tokens ?? 0) > 0 || (meta.output_tokens ?? 0) > 0 || (meta.cache_read_input_tokens ?? 0) > 0 || (meta.cache_creation_input_tokens ?? 0) > 0
    )
    const row = s.registry.find(r => st.ids.includes(r.id) && r.model)
    const rowModel = row?.model
    let cost: ObservedSession['cost']
    let model: string | null = null
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
      model = dominantModel(sessionModelUsage(meta, rowModel))
      cost = turns.length
        ? sessionCost(turns)
        : { costUSD: null, missing: 'price', basis: 'table×tokens', priceTable: sessionCost([]).priceTable }
    } else {
      cost = { costUSD: null, missing: 'tokens', basis: 'table×tokens', priceTable: sessionCost([]).priceTable }
    }
    const rec = s.deliveries[st.subtaskId!]
    // no usage: the model the record or the registry row states for it
    model ??= rowModel ?? (rec?.authorSessionId !== undefined && st.ids.includes(rec.authorSessionId) ? rec.authorModel : rec?.qaSessionId !== undefined && st.ids.includes(rec.qaSessionId) ? rec.qaModel : undefined) ?? meta?.model ?? null
    const role: SessionRole = st.leader || (rec?.leaderSessionId !== undefined && st.ids.includes(rec.leaderSessionId)) ? 'leader'
      : rec?.authorSessionId !== undefined && st.ids.includes(rec.authorSessionId) ? 'worker'
      : rec?.qaSessionId !== undefined && st.ids.includes(rec.qaSessionId) ? 'qa'
      : 'unknown'
    const session: ObservedSession = { id: st.id, subtaskId: st.subtaskId, harness: st.harness, role, cost, hasTokens: hasUsage }
    sessionModels.set(session, model)
    bySubtask.set(st.subtaskId!, [...(bySubtask.get(st.subtaskId!) ?? []), session])
    // what the piece's sessions changed (size) and when the first one started (wall-clock start)
    const acc = pieceFacts.get(st.subtaskId!) ?? { lines: null, startMs: null, labels: [] as string[] }
    if (meta && (meta.lines_added !== undefined || meta.lines_removed !== undefined)) acc.lines = (acc.lines ?? 0) + (meta.lines_added ?? 0) + (meta.lines_removed ?? 0)
    for (const r of s.registry) if (st.ids.includes(r.id)) { if (r.label) acc.labels.push(r.label); const t = ms(r.createdAt); if (t !== null && (acc.startMs === null || t < acc.startMs)) acc.startMs = t }
    pieceFacts.set(st.subtaskId!, acc)
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
  const observed = buildObserved({
    items, sessions: observedSessions, historyKnown, historyComplete, requestStart, abandoned, filters: observedFilters,
    period: { from: iso(observedFilters?.fromMs), to: iso(observedFilters?.toMs) },
  })
  // Per-piece history (ANALISE.md method): every done / in_review subtask with a linked session, from the board.
  const itemOf = new Map(items.map(i => [i.subtaskId, i]))
  const ACTIVE = ['running', 'qa', 'adjust', 'leader', 'merge', 'ci'] as const
  const pieces: HistoryPieceInput[] = s.book.subtasks.filter(sub => sub.status === 'done' || sub.status === 'in_review').map(sub => {
    const facts = pieceFacts.get(sub.id)
    const it = itemOf.get(sub.id)
    const sessions = (bySubtask.get(sub.id) ?? []).map(x => ({ id: x.id, harness: x.harness, costUSD: x.cost.costUSD, model: sessionModels.get(x) ?? null, role: x.role }))
    const moves = (s.deliveries[sub.id]?.history ?? []).flatMap(m => { const at = ms(m.at); return at === null ? [] : [{ to: m.to, atMs: at }] }).sort((a, b) => a.atMs - b.atMs)
    // the end of a piece nobody published: the handback (its first move into review), then the provenance stamped at handback/kill
    const handbackMs = moves.find(m => m.to === 'revisao_lider' || m.to === 'qa')?.atMs ?? ms(sub.provenance?.at)
    const active = it && historyComplete.has(sub.id) ? ACTIVE.reduce((a, b) => a + it.stageMs[b], 0) : 0
    return {
      id: sub.id, taskId: sub.taskId, title: sub.title, status: sub.status, sessions, lines: facts?.lines ?? null,
      startMs: ms(sub.startedAt) ?? facts?.startMs ?? ms(sub.createdAt),
      endMs: ms(sub.deliveredAt) ?? (sub.status === 'done' ? ms(sub.updatedAt) : null) ?? handbackMs,
      qaRounds: it && historyKnown.has(sub.id) && it.qaResult !== 'pending' ? it.qaRejections + 1 : qaRoundsFromLabels(facts?.labels ?? []) ?? reviewRoundsFromHistory(moves),
      activeMs: active > 0 ? active : null,
    }
  })
  const history = buildHistory({ pieces, tasks: s.book.tasks, filters: observedFilters })
  return { ...observed, history }
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
  const conversations = await archivedConversations(registry)
  return { nowMs: Date.now(), book: book as BenchmarkSources['book'], registry, metas: byConversation, deliveries: deliveries.deliveries as BenchmarkSources['deliveries'], conversations }
}

/** Managed id -> conversation: the event inbox (older lines first, so the newest wins), then every registry row. */
async function archivedConversations(registry: BenchmarkSources['registry']): Promise<Map<string, ArchivedConversation>> {
  const out = new Map<string, ArchivedConversation>()
  for (const e of await readAllEvents().catch(() => [])) if (e.conversationId && e.id) out.set(e.id, { conversationId: e.conversationId, harness: e.harness ?? '' })
  for (const r of registry) if (r.conversationId) out.set(r.id, { conversationId: r.conversationId, harness: r.harness })
  return out
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
