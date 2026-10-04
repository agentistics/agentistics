/**
 * native-sessions.ts — NATIVE.SURF: the native Agentistics harness's sessions as the rows every
 * dashboard already reads (`SessionMeta`, `harness: 'agentistics'`).
 *
 * The native harness has no transcript to parse: the engine states what each session did
 * (`GET /api/runtime/sessions/facts`, `engine/src/native-facts.ts`) and this module only MAPS it, with the
 * rules every other harness's rows follow — which is the whole point. Home, Compare, the filters, the
 * repository views and the task rollups need no native special case once a session is a row.
 *
 * - Tokens are the counters the provider reported; per-model usage goes in `model_usage`, so the shared
 *   pricing (`sessionCostUSD`) applies unchanged: a model the table prices is priced, a model it does not
 *   is UNPRICED (PRICE.UNKNOWN: 'desconhecido', its tokens still counted) — never a guess. An endpoint's
 *   own stated price stays in the native usage card (`/api/runtime/metrics`), which says where a price
 *   came from; a `SessionMeta` has no field for "stated", and a number without its source is the thing
 *   this product refuses.
 * - A run is one message from the person (the runtime's own rule), so `user_message_count` is the run
 *   count and the timestamps are the runs' starts. Nothing is invented for what the journal does not
 *   carry (git lines, per-turn active time, the context gauge): those stay absent, and the capability
 *   row (`HARNESS_CAPABILITIES.agentistics`) says N/A rather than zero.
 * - Never persisted (`consolidate.ts` skips it): the engine's store is the source and re-stating it on
 *   every read cannot go stale.
 */
import type { ModelUsage, SessionMeta } from '@agentistics/core'

/** Structurally the engine's `NativeSessionFacts` (this repository does not import the engine). */
export interface NativeSessionFactsWire {
  sessionId: string
  title?: string
  cwd: string
  workspaceRoot: string
  status: string
  provider: string
  model: string
  createdAt: string
  updatedAt: string
  archivedAt?: string
  messageCount: number
  runCount: number
  models: { model: string; provider: string; responses: number; input: number; output: number; cacheRead: number; cacheWrite: number; partial: boolean; statedUSD: number | null }[]
  tools: Record<string, { calls: number; errors: number }>
  runs: { startedAt: string; endedAt?: string; status: string }[]
}

const isIso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v))
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

/** PURE. One session's facts → its `SessionMeta`; `null` for a record that is not a session (a malformed answer is skipped, never drawn). */
export function nativeSessionMeta(f: NativeSessionFactsWire): SessionMeta | null {
  if (!f || typeof f.sessionId !== 'string' || !f.sessionId || !isIso(f.createdAt)) return null
  const runs = Array.isArray(f.runs) ? f.runs.filter(r => isIso(r.startedAt)) : []
  const starts = runs.map(r => r.startedAt).sort()
  const ends = runs.map(r => r.endedAt).filter(isIso).sort()
  const start = starts[0] ?? f.createdAt
  // An open session with a run in flight has no end yet; an idle one ends where it was last touched.
  const lastTouched = isIso(f.updatedAt) ? f.updatedAt : start
  const end = ends.length > 0 && ends.length === runs.length ? ends[ends.length - 1]! : lastTouched
  const minutes = Math.round((Date.parse(end) - Date.parse(start)) / 60000)

  const modelUsage: Record<string, ModelUsage> = {}
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0
  let dominant = { model: '', tokens: -1 }
  for (const m of Array.isArray(f.models) ? f.models : []) {
    const tokens = count(m.input) + count(m.output) + count(m.cacheRead) + count(m.cacheWrite)
    input += count(m.input); output += count(m.output); cacheRead += count(m.cacheRead); cacheWrite += count(m.cacheWrite)
    if (!m.model) continue // tokens a call left unattributed still count in the totals above
    const u = modelUsage[m.model] ??= { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 }
    u.inputTokens += count(m.input); u.outputTokens += count(m.output)
    u.cacheReadInputTokens += count(m.cacheRead); u.cacheCreationInputTokens += count(m.cacheWrite)
    const total = usageTotal(u)
    if (total > dominant.tokens) dominant = { model: m.model, tokens: total }
  }
  const model = dominant.model || f.model || undefined

  const toolCounts: Record<string, number> = {}
  let toolErrors = 0
  for (const [name, t] of Object.entries(f.tools ?? {})) {
    toolCounts[name] = count(t.calls)
    toolErrors += count(t.errors)
  }
  const userMessages = count(f.runCount)
  const timestamps = starts

  return {
    session_id: f.sessionId,
    project_path: f.workspaceRoot || f.cwd,
    ...(f.cwd ? { current_cwd: f.cwd } : {}),
    start_time: start,
    end_time: end,
    duration_minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 0,
    user_message_count: userMessages,
    assistant_message_count: Math.max(count(f.messageCount) - userMessages, 0),
    tool_counts: toolCounts,
    tool_output_tokens: {},
    agent_file_reads: {},
    languages: [],
    git_commits: 0,
    git_pushes: 0,
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    ...(Object.keys(modelUsage).length > 0 ? { model_usage: modelUsage } : {}),
    first_prompt: f.title ?? '',
    ...(f.title ? { title: f.title } : {}),
    user_interruptions: 0,
    user_response_times: [],
    tool_errors: toolErrors,
    tool_error_categories: toolErrors > 0 ? { tool_result: toolErrors } : {},
    uses_task_agent: Object.keys(toolCounts).some(n => n.startsWith('agent.')),
    uses_mcp: false,
    uses_web_search: false,
    uses_web_fetch: false,
    lines_added: 0,
    lines_removed: 0,
    files_modified: 0,
    message_hours: timestamps.map(t => new Date(t).getHours()),
    user_message_timestamps: timestamps,
    ...(model ? { model } : {}),
    harness: 'agentistics',
    _source: 'meta',
  }
}

function usageTotal(u: ModelUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens
}

/** PURE. A facts answer → rows, newest first. */
export function nativeSessionsFrom(body: unknown): SessionMeta[] {
  const list = body && typeof body === 'object' ? (body as { sessions?: unknown }).sessions : undefined
  if (!Array.isArray(list)) return []
  const rows: SessionMeta[] = []
  for (const f of list) {
    const row = nativeSessionMeta(f as NativeSessionFactsWire)
    if (row) rows.push(row)
  }
  return rows.sort((a, b) => b.start_time.localeCompare(a.start_time))
}

export const NATIVE_FACTS_PATH = '/api/runtime/sessions/facts'

/**
 * The native sessions of THIS machine, or `[]`: the native runtime is experimental (`native-gate.ts` — the
 * flag off means no native figure anywhere), a central has none, and an engine that is absent, older than
 * this route, or failing answers nothing rather than breaking the data build.
 */
export async function loadNativeSessions(opts: {
  central?: boolean
  on?: boolean
  fetch?: (path: string) => Promise<Response | null>
} = {}): Promise<SessionMeta[]> {
  if (opts.central) return []
  const { nativeExperimentalOn } = await import('./native-gate')
  if (!(opts.on ?? nativeExperimentalOn())) return []
  try {
    const ask = opts.fetch ?? (async (p: string) => (await import('./engine/load')).engineFetch(p))
    const res = await ask(NATIVE_FACTS_PATH)
    if (!res || !res.ok) return []
    return nativeSessionsFrom(await res.json())
  } catch {
    return []
  }
}
