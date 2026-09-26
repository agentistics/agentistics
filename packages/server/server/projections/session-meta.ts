/**
 * projections/session-meta.ts — PURE, version 1. Canonical events → the legacy `SessionMeta`.
 *
 * This is the projection the P1 differential measures parity against (P1 spec §1 item 6, §8, §12.3):
 * fold a session's events, finish, and compare field by field with what `jsonl.ts` computed from the
 * very same transcript. It reproduces the legacy SEMANTICS and re-derives none of them — the token
 * arithmetic is `tokens.ts`, the price is `sessionCostUSD` (so the projection is priced exactly the
 * way the legacy path prices, and says `costSource: 'table'`), the context gauge is a LEVEL (the last
 * response's, never a sum), the agent rollup excludes unmeasured invocations from its totals and
 * counts them apart.
 *
 * ## The fold is order independent and idempotent, by construction
 *
 * A `Projection` is resumable (`projection.ts`), and P1 §8 adds two properties: shuffling the
 * ingestion order of events that carry distinct source ordinals changes nothing, and folding the same
 * events twice changes nothing. Both are met the same way — every accumulator is a SUM over a set of
 * distinct events, a MIN/MAX over an order key, or a keyed record with a deterministic tie-break —
 * and every summing event is remembered by its `eventId` so a repeat adds nothing. What is therefore
 * decided at FINISH, never at fold time, is everything that needs the whole picture: which agent is
 * the main one, which subagent a nested one rolls into, which tool a failure belonged to. A fold that
 * decided those as events arrived would give a different answer for a different arrival order.
 *
 * "Last" (the context gauge, the session's model) means last by the ORDER KEY — the record's line
 * ordinal parsed off `sourceRef`, then `occurredAt`, then `eventId` — never by arrival.
 *
 * ## What is NOT here, and why it is said rather than approximated
 *
 * `NOT_PROJECTABLE` lists every legacy field the events cannot yet produce, each with its reason;
 * `PARTIAL_FIELDS` the ones produced from only a half of the legacy rule. `caveats` on the result
 * are the reasons that apply to THIS walk (a session still open, an adapter that recorded no
 * compactions). A field in any of these is absent from `meta`: an approximation from model events
 * would be exactly the confident wrong number the differential exists to catch.
 *
 * Compactions are read off the MAIN agent only (a subagent runs its own context and the legacy
 * `compact_count` counts the main transcript), and only when EVERY event of that agent came from an
 * adapter version that records them (`COMPACTION_SINCE`): a walk replayed at Claude adapter 1.0.0
 * carries no `context.compacted` at all, and reading that as `0` would claim a session that
 * compacted five times never did.
 */
import {
  calcCost,
  sessionCostUSD,
  totalTokens,
  type AnyAgentisticsEvent,
  type HarnessId,
  type Projection,
  type SessionMeta,
} from '@agentistics/core'

// ── What the projection says about itself ───────────────────────────────────────────────────────

/** A legacy field (or derived figure) the events cannot produce, with the reason. */
export interface NotProjectable {
  field: string
  reason: string
}

const HUMAN_TURN = 'needs the human-turn event, which does not exist yet (decision pending) — '
  + 'never approximated from model events'

/**
 * Every legacy `SessionMeta` field this projection deliberately does NOT produce. Static: the reason
 * is a fact about the event vocabulary, not about a session. `session-meta.test.ts` checks that no
 * key of `meta` is also listed here, and that every `SessionMeta` field is either projected, listed
 * here, partial, or stamped from outside the transcript.
 */
export const NOT_PROJECTABLE: readonly NotProjectable[] = [
  { field: 'rounds', reason: HUMAN_TURN },
  { field: 'user_message_count', reason: HUMAN_TURN },
  { field: 'user_interruptions', reason: HUMAN_TURN },
  { field: 'user_response_times', reason: HUMAN_TURN },
  { field: 'user_message_timestamps', reason: HUMAN_TURN },
  { field: 'message_hours', reason: HUMAN_TURN },
  { field: 'active_minutes', reason: `turn boundaries: ${HUMAN_TURN}` },
  { field: 'assistant_message_count', reason: 'legacy counts transcript LINES; an event is one billed response' },
  { field: 'user_chars', reason: 'the journal carries no conversation text or text sizes (D5)' },
  { field: 'user_char_messages', reason: 'the journal carries no conversation text or text sizes (D5)' },
  { field: 'assistant_chars', reason: 'the journal carries no conversation text or text sizes (D5)' },
  { field: 'assistant_char_messages', reason: 'the journal carries no conversation text or text sizes (D5)' },
  { field: 'first_prompt', reason: 'the journal carries no conversation text (D5)' },
  { field: 'title', reason: 'the journal carries no conversation text (D5)' },
  { field: 'current_cwd', reason: 'events carry the first working directory only, not where the session ended' },
  { field: 'tool_output_tokens', reason: 'no event links a tool call to the response that requested it' },
  { field: 'agent_file_reads', reason: 'a file read is not evented; paths travel only on completed edits' },
  { field: 'languages', reason: 'legacy also reads Read paths, which no event carries' },
  { field: 'git_commits', reason: 'a shell command travels as a summary, not the command line legacy counts' },
  { field: 'git_pushes', reason: 'a shell command travels as a summary, not the command line legacy counts' },
  { field: 'skill_uses', reason: 'a Skill tool call does not carry the skill name in its event' },
  { field: 'daily', reason: 'its message and hour counts need the human-turn event; tokens are in `daily_tokens`' },
  { field: 'agentMetrics.totalDurationMs', reason: 'events do not span every line of a subagent transcript' },
  { field: 'agentMetrics.invocations[].toolUseId', reason: 'the launching tool_use id is not in agent.started' },
  { field: 'agentMetrics.invocations[].totalDurationMs', reason: 'events do not span every line of a subagent transcript' },
  { field: 'agentMetrics.invocations[].toolStats.linesAdded', reason: 'legacy reads structuredPatch hunks, events carry request deltas' },
  { field: 'agentMetrics.invocations[].toolStats.linesRemoved', reason: 'legacy reads structuredPatch hunks, events carry request deltas' },
]

/** Fields produced from only part of the legacy rule — present, and NOT expected to be equal. */
export const PARTIAL_FIELDS: readonly NotProjectable[] = [
  { field: 'lines_added', reason: 'edit-derived half only: legacy counts edits at request time and takes max() with git diff' },
  { field: 'lines_removed', reason: 'edit-derived half only: legacy counts edits at request time and takes max() with git diff' },
  { field: 'files_modified', reason: 'files of completed edits only: legacy counts at request time, excludes NotebookEdit, takes max() with git' },
]

export interface Caveat {
  field: string
  reason: string
}

/** The first adapter version, per source, that records compactions as events. */
export const COMPACTION_SINCE: Readonly<Record<string, string>> = { claude: '1.1.0' }

// ── The result ──────────────────────────────────────────────────────────────────────────────────

export interface ProjectedInvocation {
  /** The agent ENTITY id (`agt_…`), not the harness's `agent-<id>` name. */
  agentId: string
  agentType?: string
  description?: string
  /** `unmeasured` is a status: the numbers below are zeros only because the type has no other value. */
  status: 'completed' | 'failed' | 'unmeasured' | 'running'
  unmeasured?: true
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalToolUseCount: number
  toolStats: { readCount: number; searchCount: number; bashCount: number; editFileCount: number; otherToolCount: number }
  costUSD: number
}

export interface ProjectedAgentMetrics {
  invocations: ProjectedInvocation[]
  totalInvocations: number
  unmeasuredInvocations: number
  /** Measured invocations only. */
  totalTokens: number
  totalCostUSD: number
}

export type ProjectedSessionMeta =
  & Pick<SessionMeta,
    | 'tool_counts' | 'tool_errors' | 'tool_error_categories'
    | 'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens'
    | 'uses_task_agent' | 'uses_mcp' | 'uses_web_search' | 'uses_web_fetch'
    | 'lines_added' | 'lines_removed' | 'files_modified'>
  & Partial<Pick<SessionMeta,
    | 'session_id' | 'project_path' | 'start_time' | 'end_time' | 'duration_minutes'
    | 'cache_creation_1h_input_tokens' | 'cache_creation_5m_input_tokens'
    | 'context_tokens' | 'context_window'
    | 'compact_count' | 'compact_ms' | 'compact_dropped_tokens'
    | 'model' | 'harness'>>
  & {
    /** Four counters per UTC day, the day of the response's first line — legacy `daily[day].*_tokens`. */
    daily_tokens?: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>
    agentMetrics?: ProjectedAgentMetrics
  }

export interface SessionMetaProjection {
  meta: ProjectedSessionMeta
  /** `sessionCostUSD` of the projected counters; `null` when no model was seen (never a zero). */
  costUSD: number | null
  /** The price comes from the built-in table, exactly as the legacy path — never a provider's own. */
  costSource: 'table'
  notProjectable: readonly NotProjectable[]
  partialFields: readonly NotProjectable[]
  /** Reasons that apply to THIS walk. */
  caveats: Caveat[]
  eventsFolded: number
}

// ── State ───────────────────────────────────────────────────────────────────────────────────────

interface OrderKey { ord: number; at: string; id: string }

function compareKey(a: OrderKey, b: OrderKey): number {
  if (a.ord !== b.ord) return a.ord - b.ord
  if (a.at !== b.at) return a.at < b.at ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function keyOf(e: AnyAgentisticsEvent): OrderKey {
  const m = /:(\d+)$/.exec(e.provenance.sourceRef ?? '')
  return { ord: m ? Number(m[1]) : -1, at: e.occurredAt, id: e.eventId }
}

interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number }
const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
function add(into: Tokens, u: Tokens): void {
  into.input += u.input; into.output += u.output; into.cacheRead += u.cacheRead; into.cacheWrite += u.cacheWrite
}

/** Everything one agent's events add up to. Main is chosen from these at FINISH. */
interface AgentAcc {
  tokens: Tokens
  byModel: Map<string, Tokens>
  daily: Map<string, Tokens>
  sawTtl: boolean
  ttl1h: number
  ttl5m: number
  toolNames: Map<string, number>
  linesAdded: number
  linesRemoved: number
  files: Set<string>
  compactCount: number
  compactMs: number
  compactDropped: number | undefined
  /** Every event of this agent came from an adapter that records compactions. */
  compactionRecorded: boolean
  gauge: { key: OrderKey; tokens: number; window: number | undefined } | undefined
  firstModel: { key: OrderKey; model: string } | undefined
}

function emptyAcc(): AgentAcc {
  return {
    tokens: zero(), byModel: new Map(), daily: new Map(), sawTtl: false, ttl1h: 0, ttl5m: 0,
    toolNames: new Map(), linesAdded: 0, linesRemoved: 0, files: new Set(),
    compactCount: 0, compactMs: 0, compactDropped: undefined, compactionRecorded: true,
    gauge: undefined, firstModel: undefined,
  }
}

interface StartedRecord {
  id: string
  kind: 'main' | 'subagent'
  parentAgentId?: string
  agentType?: string
  description?: string
  model?: string
  at: string
}

export interface SessionMetaState {
  /** Every event id already folded — the idempotency memory (one id per event, session-scoped). */
  seen: Set<string>
  agents: Map<string, AgentAcc>
  started: Map<string, StartedRecord>
  ended: Map<string, { id: string; status: string }>
  toolNameById: Map<string, string>
  failures: { agentId: string; toolExecutionId: string; status: string }[]
  /** The session.started that wins the order key — it names the project path. */
  sessionStart: { key: OrderKey; projectPath?: string } | undefined
  /** The earliest session.started `occurredAt`. */
  startAt: string | undefined
  sessionEnd: string | undefined
  run: { key: OrderKey; conversationId?: string; harness: string } | undefined
}

const NO_AGENT = ''

function accOf(s: SessionMetaState, agentId: string | undefined): AgentAcc {
  const k = agentId ?? NO_AGENT
  let a = s.agents.get(k)
  if (!a) { a = emptyAcc(); s.agents.set(k, a) }
  return a
}

function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** Whether `version` is at least `floor`. An unparsable version is treated as older, never newer. */
function atLeast(version: string, floor: string): boolean {
  const a = parseVersion(version)
  const b = parseVersion(floor)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!
  return true
}

function recordsCompaction(e: AnyAgentisticsEvent): boolean {
  const since = COMPACTION_SINCE[e.source.id]
  return since !== undefined && atLeast(e.provenance.adapterVersion, since)
}

const HARNESS_IDS: readonly string[] = ['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi']

// ── Fold ────────────────────────────────────────────────────────────────────────────────────────

function foldOne(s: SessionMetaState, e: AnyAgentisticsEvent): void {
  // One id, one effect: a repeated event adds nothing, whatever its type.
  if (s.seen.has(e.eventId)) return
  s.seen.add(e.eventId)

  // Every event of an agent bears on whether that agent's compactions were recorded at all.
  const acc = accOf(s, e.agentId)
  if (!recordsCompaction(e)) acc.compactionRecorded = false

  switch (e.type) {
    case 'session.started': {
      const key = keyOf(e)
      if (s.startAt === undefined || e.occurredAt < s.startAt) s.startAt = e.occurredAt
      if (!s.sessionStart || compareKey(key, s.sessionStart.key) < 0) {
        s.sessionStart = { key, ...(e.data.projectPath ? { projectPath: e.data.projectPath } : {}) }
      }
      return
    }
    case 'session.ended': {
      if (s.sessionEnd === undefined || e.occurredAt > s.sessionEnd) s.sessionEnd = e.occurredAt
      return
    }
    case 'run.started': {
      const key = keyOf(e)
      if (!s.run || compareKey(key, s.run.key) < 0) {
        s.run = { key, harness: e.data.harness, ...(e.data.conversationId ? { conversationId: e.data.conversationId } : {}) }
      }
      return
    }
    case 'agent.started': {
      const id = e.agentId
      if (!id) return
      const prev = s.started.get(id)
      if (prev && prev.id <= e.eventId) return
      s.started.set(id, {
        id: e.eventId, kind: e.data.kind === 'main' ? 'main' : 'subagent',
        ...(e.data.parentAgentId ? { parentAgentId: e.data.parentAgentId } : {}),
        ...(e.data.agentType ? { agentType: e.data.agentType } : {}),
        ...(e.data.description ? { description: e.data.description } : {}),
        ...(e.data.model ? { model: e.data.model } : {}),
        at: e.occurredAt,
      })
      return
    }
    case 'agent.ended': {
      const id = e.agentId
      if (!id) return
      const prev = s.ended.get(id)
      if (prev && prev.id <= e.eventId) return
      s.ended.set(id, { id: e.eventId, status: e.data.status })
      return
    }
    case 'model.completed': {
      const u = e.data.usage
      add(acc.tokens, u)
      let m = acc.byModel.get(e.data.model)
      if (!m) { m = zero(); acc.byModel.set(e.data.model, m) }
      add(m, u)
      const day = e.occurredAt.slice(0, 10)
      if (day.length === 10) {
        let d = acc.daily.get(day)
        if (!d) { d = zero(); acc.daily.set(day, d) }
        add(d, u)
      }
      if (e.data.cacheWriteByTtl) {
        acc.sawTtl = true
        acc.ttl1h += e.data.cacheWriteByTtl.ephemeral_1h ?? 0
        acc.ttl5m += e.data.cacheWriteByTtl.ephemeral_5m ?? 0
      }
      const key = keyOf(e)
      if (e.data.contextTokens !== undefined && e.data.contextTokens > 0
        && (!acc.gauge || compareKey(key, acc.gauge.key) > 0)) {
        acc.gauge = { key, tokens: e.data.contextTokens, window: e.data.contextWindow }
      }
      if (!acc.firstModel || compareKey(key, acc.firstModel.key) < 0) acc.firstModel = { key, model: e.data.model }
      return
    }
    case 'tool.requested': {
      acc.toolNames.set(e.data.name, (acc.toolNames.get(e.data.name) ?? 0) + 1)
      s.toolNameById.set(e.data.toolExecutionId, e.data.name)
      return
    }
    case 'tool.completed': {
      acc.linesAdded += e.data.linesAdded ?? 0
      acc.linesRemoved += e.data.linesRemoved ?? 0
      for (const f of e.data.filesTouched ?? []) acc.files.add(f)
      return
    }
    case 'tool.failed': {
      s.failures.push({ agentId: e.agentId ?? NO_AGENT, toolExecutionId: e.data.toolExecutionId, status: e.data.status })
      return
    }
    case 'context.compacted': {
      acc.compactCount++
      acc.compactMs += e.data.durationMs ?? 0
      if (e.data.droppedTokens !== undefined) acc.compactDropped = (acc.compactDropped ?? 0) + e.data.droppedTokens
      return
    }
    default:
      return
  }
}

// ── Finish ──────────────────────────────────────────────────────────────────────────────────────

const SEARCH_TOOLS = new Set(['Grep', 'Glob'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

function tokensOfModel(t: Tokens, ttl?: { h1: number; m5: number }) {
  return {
    inputTokens: t.input, outputTokens: t.output, cacheReadInputTokens: t.cacheRead,
    cacheCreationInputTokens: t.cacheWrite,
    ...(ttl ? { cacheCreation1hInputTokens: ttl.h1, cacheCreation5mInputTokens: ttl.m5 } : {}),
    webSearchRequests: 0, costUSD: 0,
  }
}

function finish(s: SessionMetaState): SessionMetaProjection {
  const caveats: Caveat[] = []

  // Which agent is the main one is a fact about the WHOLE walk (see the header).
  const mainKind = [...s.started].filter(([, r]) => r.kind === 'main').map(([id]) => id)
  const subKind = new Set([...s.started].filter(([, r]) => r.kind === 'subagent').map(([id]) => id))
  let mains: string[]
  if (mainKind.length > 0) {
    mains = mainKind
    const unattributed = [...s.agents.keys()].filter(k => k !== NO_AGENT && !s.started.has(k))
    if (unattributed.length > 0) {
      caveats.push({ field: 'agents', reason: `${unattributed.length} agent(s) reported events without an agent.started; their events are counted nowhere` })
    }
  } else {
    mains = [...s.agents.keys()].filter(k => !subKind.has(k))
    if (s.agents.size > 0) caveats.push({ field: 'agents', reason: 'no main agent.started seen; every agent not known to be a subagent is treated as main' })
  }

  const main = emptyAcc()
  const mainToolNames = new Map<string, number>()
  for (const id of mains) {
    const a = s.agents.get(id)
    if (!a) continue
    add(main.tokens, a.tokens)
    for (const [d, t] of a.daily) { const cur = main.daily.get(d) ?? zero(); add(cur, t); main.daily.set(d, cur) }
    main.sawTtl ||= a.sawTtl; main.ttl1h += a.ttl1h; main.ttl5m += a.ttl5m
    for (const [n, c] of a.toolNames) mainToolNames.set(n, (mainToolNames.get(n) ?? 0) + c)
    main.linesAdded += a.linesAdded; main.linesRemoved += a.linesRemoved
    for (const f of a.files) main.files.add(f)
    main.compactCount += a.compactCount; main.compactMs += a.compactMs
    if (a.compactDropped !== undefined) main.compactDropped = (main.compactDropped ?? 0) + a.compactDropped
    if (a.gauge && (!main.gauge || compareKey(a.gauge.key, main.gauge.key) > 0)) main.gauge = a.gauge
    if (a.firstModel && (!main.firstModel || compareKey(a.firstModel.key, main.firstModel.key) < 0)) main.firstModel = a.firstModel
  }
  // Session-level events (no agent) also bear on whether compactions were recorded.
  const recorded = [...mains, NO_AGENT].every(id => s.agents.get(id)?.compactionRecorded ?? true)

  const meta: ProjectedSessionMeta = {
    tool_counts: Object.fromEntries(mainToolNames),
    tool_errors: 0,
    tool_error_categories: {},
    input_tokens: main.tokens.input,
    output_tokens: main.tokens.output,
    cache_read_input_tokens: main.tokens.cacheRead,
    cache_creation_input_tokens: main.tokens.cacheWrite,
    uses_task_agent: false,
    uses_mcp: [...mainToolNames.keys()].some(n => n.startsWith('mcp__')),
    uses_web_search: mainToolNames.has('WebSearch'),
    uses_web_fetch: mainToolNames.has('WebFetch'),
    lines_added: main.linesAdded,
    lines_removed: main.linesRemoved,
    files_modified: main.files.size,
  }

  // Tool errors: a `failed` result is a tool error. A `cancelled` one (the whole call interrupted)
  // lost the is_error flag legacy counts — said, not folded in.
  const mainSet = new Set(mains)
  let cancelled = 0
  for (const f of s.failures) {
    if (!mainSet.has(f.agentId)) continue
    if (f.status === 'cancelled') { cancelled++; continue }
    meta.tool_errors++
    const name = s.toolNameById.get(f.toolExecutionId) ?? 'unknown'
    meta.tool_error_categories[name] = (meta.tool_error_categories[name] ?? 0) + 1
  }
  if (cancelled > 0) {
    caveats.push({ field: 'tool_errors', reason: `${cancelled} interrupted call(s) are not counted; legacy counts their error block` })
  }

  if (s.startAt !== undefined) meta.start_time = s.startAt
  if (s.sessionStart?.projectPath) meta.project_path = s.sessionStart.projectPath
  if (s.sessionEnd !== undefined) {
    meta.end_time = s.sessionEnd
    if (s.startAt !== undefined) {
      meta.duration_minutes = Math.max(0, Math.round((Date.parse(s.sessionEnd) - Date.parse(s.startAt)) / 60000))
    }
  } else if (s.startAt !== undefined) {
    caveats.push({ field: 'end_time', reason: 'no session.ended yet (the transcript is still open); end_time and duration_minutes are absent' })
  }
  if (s.run) {
    if (s.run.conversationId) meta.session_id = s.run.conversationId
    if (HARNESS_IDS.includes(s.run.harness)) meta.harness = s.run.harness as HarnessId
  }
  if (main.firstModel) meta.model = main.firstModel.model
  if (main.gauge) {
    meta.context_tokens = main.gauge.tokens
    if (main.gauge.window !== undefined) meta.context_window = main.gauge.window
  }
  // BOTH-OR-NEITHER, and only when the split reconciles against the counter (the legacy rule).
  if (main.sawTtl && main.ttl1h + main.ttl5m === main.tokens.cacheWrite) {
    meta.cache_creation_1h_input_tokens = main.ttl1h
    meta.cache_creation_5m_input_tokens = main.ttl5m
  }
  if (main.daily.size > 0) {
    meta.daily_tokens = Object.fromEntries([...main.daily].sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, t]) => [d, { ...t }]))
  }
  if (recorded && s.agents.size > 0) {
    meta.compact_count = main.compactCount
    meta.compact_ms = main.compactMs
    if (main.compactDropped !== undefined) meta.compact_dropped_tokens = main.compactDropped
  } else if (s.agents.size > 0) {
    caveats.push({ field: 'compact_count', reason: 'not recorded by this adapter version (events replayed before context.compacted existed); absent, not zero' })
  }

  // ── The agent rollup ──
  const parentOf = (id: string): string | undefined => s.started.get(id)?.parentAgentId
  const rootOf = (id: string): string => {
    const seen = new Set<string>([id])
    let cur = id
    for (;;) {
      const p = parentOf(cur)
      if (!p || !subKind.has(p) || seen.has(p)) return cur
      seen.add(p); cur = p
    }
  }
  const roots = [...subKind].filter(id => rootOf(id) === id)
  const members = new Map<string, string[]>(roots.map(r => [r, [r]]))
  for (const id of subKind) if (rootOf(id) !== id) members.get(rootOf(id))?.push(id)

  const invocations: ProjectedInvocation[] = roots
    .sort((a, b) => {
      const ra = s.started.get(a)!, rb = s.started.get(b)!
      return ra.at !== rb.at ? (ra.at < rb.at ? -1 : 1) : a < b ? -1 : 1
    })
    .map(root => {
      const rec = s.started.get(root)!
      const endStatus = s.ended.get(root)?.status
      const status: ProjectedInvocation['status'] =
        endStatus === 'unmeasured' ? 'unmeasured' : endStatus === 'failed' ? 'failed' : endStatus ? 'completed' : 'running'
      const inv: ProjectedInvocation = {
        agentId: root,
        ...(rec.agentType ? { agentType: rec.agentType } : {}),
        ...(rec.description ? { description: rec.description } : {}),
        status,
        totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        totalToolUseCount: 0,
        toolStats: { readCount: 0, searchCount: 0, bashCount: 0, editFileCount: 0, otherToolCount: 0 },
        costUSD: 0,
      }
      if (status === 'unmeasured') { inv.unmeasured = true; return inv }
      const tokens = zero()
      const byModel = new Map<string, Tokens>()
      for (const id of members.get(root)!) {
        const a = s.agents.get(id)
        if (!a) continue
        add(tokens, a.tokens)
        for (const [m, t] of a.byModel) { const cur = byModel.get(m) ?? zero(); add(cur, t); byModel.set(m, cur) }
        for (const [name, c] of a.toolNames) {
          inv.totalToolUseCount += c
          if (name === 'Read') inv.toolStats.readCount += c
          else if (SEARCH_TOOLS.has(name)) inv.toolStats.searchCount += c
          else if (name === 'Bash') inv.toolStats.bashCount += c
          else if (EDIT_TOOLS.has(name)) inv.toolStats.editFileCount += c
          else inv.toolStats.otherToolCount += c
        }
      }
      inv.inputTokens = tokens.input; inv.outputTokens = tokens.output
      inv.cacheReadTokens = tokens.cacheRead; inv.cacheWriteTokens = tokens.cacheWrite
      inv.totalTokens = totalTokens(tokens)
      // Each model at ITS OWN rate — a haiku subagent under an opus parent is not billed as opus.
      for (const [m, t] of byModel) inv.costUSD += calcCost(tokensOfModel(t), m)
      return inv
    })

  if (invocations.length > 0) {
    const measured = invocations.filter(i => !i.unmeasured)
    meta.agentMetrics = {
      invocations,
      totalInvocations: invocations.length,
      unmeasuredInvocations: invocations.length - measured.length,
      totalTokens: measured.reduce((n, i) => n + i.totalTokens, 0),
      totalCostUSD: measured.reduce((n, i) => n + i.costUSD, 0),
    }
  }
  meta.uses_task_agent = mainToolNames.has('Task') || mainToolNames.has('Agent') || subKind.size > 0

  // Priced exactly as the legacy path prices: `sessionCostUSD` over the projected counters.
  const costUSD = sessionCostUSD({
    ...(meta.model ? { model: meta.model } : {}),
    input_tokens: meta.input_tokens,
    output_tokens: meta.output_tokens,
    cache_read_input_tokens: meta.cache_read_input_tokens,
    cache_creation_input_tokens: meta.cache_creation_input_tokens,
    cache_creation_1h_input_tokens: meta.cache_creation_1h_input_tokens,
    cache_creation_5m_input_tokens: meta.cache_creation_5m_input_tokens,
  })

  return { meta, costUSD, costSource: 'table', notProjectable: NOT_PROJECTABLE, partialFields: PARTIAL_FIELDS, caveats, eventsFolded: s.seen.size }
}

export const sessionMetaProjection: Projection<SessionMetaState, SessionMetaProjection> = {
  name: 'session-meta',
  version: 1,
  empty: () => ({
    seen: new Set(), agents: new Map(), started: new Map(), ended: new Map(), toolNameById: new Map(),
    failures: [], sessionStart: undefined, startAt: undefined, sessionEnd: undefined, run: undefined,
  }),
  fold(state, events) {
    for (const e of events) foldOne(state, e)
  },
  finish,
}
