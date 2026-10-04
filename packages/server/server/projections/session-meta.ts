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
 * D21 (2026-09-26): `model.completed.usage` carries only the counters its source actually reported
 * (`ModelUsageCounters`, a `Partial<TokenBreakdown>`) — an absent one is never folded in as a 0. The
 * fold sums only what each event reports and separately remembers, per main-agent counter, whether
 * ANY event left it out (`AgentAcc.absentCounters`); FINISH turns that into a `caveats` row per
 * affected token field plus one for `costUSD` (priced from the very same, now-partial, counters) —
 * so a reader sees the number AND is told it is a partial sum, never a confident wrong one. When no
 * event ever lacked a counter this adds nothing: no caveat, and the output is byte-identical to the
 * pre-D21 projection.
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
 *
 * Human turns (D22, `turn.started`) follow the same rule under `TURNS_SINCE`: a walk replayed
 * before the adapter emitted them carries none, and `user_message_count: 0` there would claim a
 * session nobody ever typed into. What they make projectable is exactly what legacy derives from the
 * human line ALONE — its count, its timestamp, and `count - 1` interruptions.
 *
 * Turn CLOSES (D25, `turn.ended`) and the last assistant line before each prompt
 * (`turn.started.previousAssistantAt`) make the two remaining turn figures projectable, under their
 * own gate `TURN_END_SINCE`: `active_minutes` is `activeMinutesOf` (`activeTime.ts`) — never a second
 * implementation of the rule — over one `TurnEvent` per exact prompt plus the LAST close of that turn
 * (a resumed transcript may close one turn several times; the last word wins), and
 * `user_response_times` is legacy's own arithmetic over `previousAssistantAt`. A walk still open (its
 * last turn not yet closed) reports no `active_minutes` and says so, like `end_time`. `message_hours`
 * stays in `NOT_PROJECTABLE` by decision (D25): it is the local hour of EVERY timestamped line, which
 * an event stream of turns cannot reproduce.
 */
import {
  absentUsageCounters,
  calcCost,
  sessionCostUSD,
  totalTokens,
  USAGE_COUNTERS,
  activeMinutesOf,
  SURFACE_HARNESS_ORDER,
  type AnyAgentisticsEvent,
  type HarnessId,
  type ModelUsageCounters,
  type Projection,
  type SessionMeta,
  type TurnEvent,
  type UsageCounter,
} from '@agentistics/core'
import { WEB_FETCH_TOOLS as AGY_WEB_FETCH, WEB_SEARCH_TOOLS as AGY_WEB_SEARCH } from '../adapters/antigravity-parse'

// ── What the projection says about itself ───────────────────────────────────────────────────────

/** A legacy field (or derived figure) the events cannot produce, with the reason. */
export interface NotProjectable {
  field: string
  reason: string
}

/**
 * The one turn-family field left legacy-only, BY DECISION (D25, 2026-09-26) rather than for want of
 * an event: it is a per-LINE fact, and the events are per-turn.
 */
const MESSAGE_HOURS = 'legacy takes the local hour of EVERY timestamped transcript line (every role, system '
  + 'lines, attachments, tool results); an event stream of turns cannot reproduce it (measured: 1 of 477 '
  + 'sessions equal, A2.7), so it is left legacy-only by decision D25'
const DAILY_MESSAGES = 'its `messages` counts every user- and assistant-role LINE (tool results included) and '
  + 'its `hours` every timestamped line; events cover a subset of lines. Tokens are in `daily_tokens`'

/**
 * Every legacy `SessionMeta` field this projection deliberately does NOT produce. Static: the reason
 * is a fact about the event vocabulary, not about a session. `session-meta.test.ts` checks that no
 * key of `meta` is also listed here, and that every `SessionMeta` field is either projected, listed
 * here, partial, or stamped from outside the transcript.
 */
export const NOT_PROJECTABLE: readonly NotProjectable[] = [
  { field: 'message_hours', reason: MESSAGE_HOURS },
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
  { field: 'daily', reason: DAILY_MESSAGES },
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

/** The first adapter version, per source, that records human turns (`turn.started`, D22) as events. */
export const TURNS_SINCE: Readonly<Record<string, string>> = { claude: '1.3.0', codex: '1.0.0', antigravity: '1.0.0', opencode: '1.0.0' }

/**
 * The first adapter version, per source, that records turn CLOSES (`turn.ended`) and
 * `turn.started.previousAssistantAt` (D25) — what `active_minutes` and `user_response_times` need.
 */
export const TURN_END_SINCE: Readonly<Record<string, string>> = { claude: '1.5.0', codex: '1.0.0', antigravity: '1.0.0', opencode: '1.0.0' }

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
    | 'user_message_count' | 'user_interruptions' | 'user_message_timestamps'
    | 'active_minutes' | 'user_response_times'
    | 'model' | 'harness'>>
  & {
    /** Four counters per UTC day, the day of the response's first line — legacy `daily[day].*_tokens`. */
    daily_tokens?: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>
    /**
     * `task-rollup.ts`'s ROUNDS — defined there as `user_message_count`, and projected under that
     * same rule so the differential can compare the figure the board shows, not only its input.
     */
    rounds?: number
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

export interface OrderKey { ord: number; at: string; id: string }

export function compareKey(a: OrderKey, b: OrderKey): number {
  if (a.ord !== b.ord) return a.ord - b.ord
  if (a.at !== b.at) return a.at < b.at ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function keyOf(e: AnyAgentisticsEvent): OrderKey {
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
  /**
   * Counters some `model.completed` event of THIS agent did not report (D21, 2026-09-26). `tokens`
   * already sums only the counters each event DID report — an absent one contributes nothing, never
   * a 0 folded in — so this is purely the record of what happened, spent at FINISH to say the sum is
   * partial rather than silently letting it read as measured.
   */
  absentCounters: Set<UsageCounter>
  sawTtl: boolean
  ttl1h: number
  ttl5m: number
  toolNames: Map<string, number>
  /** Counts by the harness's OWN tool name (`tool.requested.data.name`) — see `HarnessToolRules`. */
  rawToolNames: Map<string, number>
  linesAdded: number
  linesRemoved: number
  files: Set<string>
  compactCount: number
  compactMs: number
  compactDropped: number | undefined
  /** Every event of this agent came from an adapter that records compactions. */
  compactionRecorded: boolean
  /** Human turns (`turn.started`), each with its order key; sorted at finish, never on arrival. */
  turns: TurnStart[]
  /** Every event of this agent came from an adapter that records human turns (`TURNS_SINCE`). */
  turnsRecorded: boolean
  /** Turn closes (`turn.ended`), each with its order key; assigned to their turn at finish. */
  turnEnds: TurnEnd[]
  /** Every event of this agent came from an adapter that records turn closes (`TURN_END_SINCE`). */
  turnEndsRecorded: boolean
  /**
   * Some event of this agent proves the transcript carried a line with a usable timestamp — legacy's
   * `sawTime`, the difference between an `active_minutes` of `0` and an absent one.
   */
  sawTime: boolean
  gauge: { key: OrderKey; tokens: number; window: number | undefined } | undefined
  firstModel: { key: OrderKey; model: string } | undefined
}

function emptyAcc(): AgentAcc {
  return {
    tokens: zero(), byModel: new Map(), daily: new Map(), absentCounters: new Set(), sawTtl: false, ttl1h: 0, ttl5m: 0,
    toolNames: new Map(), rawToolNames: new Map(), linesAdded: 0, linesRemoved: 0, files: new Set(),
    compactCount: 0, compactMs: 0, compactDropped: undefined, compactionRecorded: true,
    turns: [], turnsRecorded: true, turnEnds: [], turnEndsRecorded: true, sawTime: false,
    gauge: undefined, firstModel: undefined,
  }
}

/** Every counter `u` reports, defaulted to 0 for SUMMING purposes only — an absent counter must
 * contribute nothing to a total, which is exactly what adding 0 for it does; `absentUsageCounters`
 * (called by the caller of this) is what remembers that it was never actually reported. */
function materialize(u: ModelUsageCounters): Tokens {
  return { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 }
}

export interface TurnStart { key: OrderKey; at: string; stamped: boolean; previousAssistantAt?: string }
export interface TurnEnd { key: OrderKey; at: string; close: 'measured' | 'last-line'; durationMs?: number }

/** A time usable as a clock — legacy's `Date.parse` filter on a line's timestamp. */
const usableTime = (at: string): boolean => Number.isFinite(Date.parse(at))

/** Lifecycle events: each is stamped with a real transcript line's own time, never the replay clock. */
const LIFECYCLE: ReadonlySet<string> = new Set([
  'session.started', 'session.ended', 'run.started', 'run.ended', 'agent.started', 'agent.ended',
])

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
  toolNameById: Map<string, { canonical: string; raw: string }>
  failures: { agentId: string; toolExecutionId: string; status: string; errorClass?: string }[]
  /** `model.failed` events — a tool error only where `HARNESS_TOOL_RULES` says legacy counts it. */
  modelFailures: { agentId: string; errorClass?: string }[]
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

/** Whether `e`'s adapter is at least the version `table` names for its source. */
function recordsSince(table: Readonly<Record<string, string>>, e: AnyAgentisticsEvent): boolean {
  const since = table[e.source.id]
  return since !== undefined && atLeast(e.provenance.adapterVersion, since)
}

// `SURFACE_HARNESS_ORDER` (core `types.ts`), NEVER a hardcoded array — CLAUDE.md step 3 exists
// precisely because a plain array literal here would silently drop the next harness added to
// `HarnessId` (which this line itself once did: it hardcoded six ids and was found missing 'opencode'
// by the A3.8 ease test, the same class of bug the rule already names). The SURFACE list, so a run of
// the native harness (`run.started.harness: 'agentistics'`) is filed under it rather than left to the
// default.
const HARNESS_IDS: readonly string[] = SURFACE_HARNESS_ORDER

/**
 * How a harness's TOOL facts become the `uses_*` flags and the error figures. The flags are a
 * statement about the harness's OWN tool names (legacy reads them raw), so a harness whose names
 * differ from Claude's needs its own predicates here — never a Claude name tested against it.
 * Absent from `HARNESS_TOOL_RULES` means `DEFAULT_TOOL_RULES` (Claude's names, read off the canonical
 * counts, which for Claude ARE its own names).
 */
interface HarnessToolRules {
  /** Which names the predicates read: the harness's own (`tool.requested.data.name`) or canonical. */
  names: 'raw' | 'canonical'
  /**
   * Which name `tool_counts`, `tool_error_categories` and an invocation's `toolStats` are keyed by.
   * Claude's legacy counts its OWN names — measured: a Claude session can carry a tool literally named
   * `bash`, which `canonicalTool` folds into `Bash` (3 of 495 sessions differed, A3); every other
   * legacy parser counts `canonicalTool` names.
   */
  counts: 'raw' | 'canonical'
  mcp(name: string): boolean
  webSearch(name: string): boolean
  webFetch(name: string): boolean
  taskAgent(name: string): boolean
  /** `tool_error_categories` key: the failing TOOL's name (Claude) or the event's `errorClass`. */
  errorsBy: 'tool' | 'errorClass'
  /** A `model.failed` of a main agent is a legacy tool error (agy counts its ERROR_MESSAGE step). */
  modelFailuresAreErrors: boolean
  /** A failed tool call is a legacy tool error. False where legacy never reads a call's outcome. */
  toolFailuresAreErrors: boolean
  /**
   * Which agents a session's COUNTS are summed over. `'main'` (default, Claude's rule: a subagent's
   * spend is its invocation's, reported under `agentMetrics`) or `'all-agents'` (kimi: `kimi-parse.ts`
   * folds every agent's `wire.jsonl` into one session — tokens, tools, git counts — and only the
   * context gauge stays the main agent's). Measured on the `kimi-replay/subagent` fixture: legacy
   * `input_tokens` 80 (main 50 + worker 30) against 50 while this was main-only (A4, 2026-09-27).
   * The gauge, the model, turns and compactions stay main-only under either scope.
   */
  countScope?: 'main' | 'all-agents'
  /**
   * Whether a started subagent alone makes `uses_task_agent` true (default, Claude's reading: an agent
   * ran, so the session delegated). `false` where legacy reads ONLY the tool name — kimi-parse.ts sets it
   * from `Agent`/`AgentSwarm` tool counts and nothing else (measured on `kimi-replay/subagent`: legacy
   * false, a worker agent present).
   */
  subagentsImplyTaskAgent?: boolean
}

const DEFAULT_TOOL_RULES: HarnessToolRules = {
  names: 'canonical',
  counts: 'canonical',
  mcp: n => n.startsWith('mcp__'),
  webSearch: n => n === 'WebSearch',
  webFetch: n => n === 'WebFetch',
  taskAgent: n => n === 'Task' || n === 'Agent',
  errorsBy: 'tool',
  modelFailuresAreErrors: false,
  toolFailuresAreErrors: true,
}

export const HARNESS_TOOL_RULES: Readonly<Record<string, HarnessToolRules>> = {
  // jsonl.ts counts and flags by the tool's OWN name (see `counts`).
  claude: { ...DEFAULT_TOOL_RULES, names: 'raw', counts: 'raw' },
  // adapters/antigravity-parse.ts's own sets; `mcp_` has ONE underscore there, and legacy names an
  // error category `error_<code>` / `exit_code` / `status_error`, never by tool (A3.5).
  antigravity: {
    names: 'raw',
    counts: 'canonical',
    mcp: n => n.startsWith('mcp_') || n === 'call_mcp_tool',
    webSearch: n => AGY_WEB_SEARCH.has(n),
    webFetch: n => AGY_WEB_FETCH.has(n),
    taskAgent: n => n === 'invoke_subagent',
    errorsBy: 'errorClass',
    modelFailuresAreErrors: true,
    toolFailuresAreErrors: true,
  },
  // copilot-parse.ts derives NONE of the four flags from a tool name — web search / fetch / task are
  // hard-coded false and `uses_mcp` comes from a `session.info` marker no event carries — and never
  // reads `tool.execution_complete.success`. Stated here so the agreement is structural (A3.3).
  copilot: {
    names: 'canonical',
    counts: 'canonical',
    mcp: () => false,
    webSearch: () => false,
    webFetch: () => false,
    taskAgent: () => false,
    errorsBy: 'tool',
    modelFailuresAreErrors: false,
    toolFailuresAreErrors: false,
  },
  // kimi-parse.ts: uses_task_agent is `Agent` OR `AgentSwarm` (A3.4); the rest are Claude's names.
  kimi: { ...DEFAULT_TOOL_RULES, taskAgent: n => n === 'Task' || n === 'Agent' || n === 'AgentSwarm', countScope: 'all-agents', subagentsImplyTaskAgent: false },
}

// ── Fold ────────────────────────────────────────────────────────────────────────────────────────

function foldOne(s: SessionMetaState, e: AnyAgentisticsEvent): void {
  // One id, one effect: a repeated event adds nothing, whatever its type.
  if (s.seen.has(e.eventId)) return
  s.seen.add(e.eventId)

  // Every event of an agent bears on whether that agent's compactions were recorded at all.
  const acc = accOf(s, e.agentId)
  if (!recordsSince(COMPACTION_SINCE, e)) acc.compactionRecorded = false
  if (!recordsSince(TURNS_SINCE, e)) acc.turnsRecorded = false
  if (!recordsSince(TURN_END_SINCE, e)) acc.turnEndsRecorded = false
  if ((LIFECYCLE.has(e.type) || e.type === 'turn.started' || e.type === 'turn.ended')
    && e.provenance.confidence !== 'estimated' && usableTime(e.occurredAt)) acc.sawTime = true

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
      // D21 (2026-09-26): a counter the source did not report is ABSENT, not a 0 — `materialize`
      // sums only what was reported (an absent one contributes nothing, which is arithmetically the
      // same as folding in a 0 for it), and `absentUsageCounters` is what remembers the absence so
      // FINISH can say the total is partial rather than let it read as a measured sum.
      for (const c of absentUsageCounters(e.data.usage)) acc.absentCounters.add(c)
      const u = materialize(e.data.usage)
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
      // A response that names no model (agy's row with no 1.19) never becomes the session's model.
      if (e.data.model && (!acc.firstModel || compareKey(key, acc.firstModel.key) < 0)) acc.firstModel = { key, model: e.data.model }
      return
    }
    case 'tool.requested': {
      // Both names are kept; `HARNESS_TOOL_RULES[harness].counts` decides at finish which one keys the
      // counts (Claude's legacy counts its own names, every other parser `canonicalTool`'s).
      const toolName = e.data.canonicalName
      acc.toolNames.set(toolName, (acc.toolNames.get(toolName) ?? 0) + 1)
      s.toolNameById.set(e.data.toolExecutionId, { canonical: toolName, raw: e.data.name })
      acc.rawToolNames.set(e.data.name, (acc.rawToolNames.get(e.data.name) ?? 0) + 1)
      return
    }
    case 'tool.completed': {
      acc.linesAdded += e.data.linesAdded ?? 0
      acc.linesRemoved += e.data.linesRemoved ?? 0
      for (const f of e.data.filesTouched ?? []) acc.files.add(f)
      return
    }
    case 'tool.failed': {
      s.failures.push({
        agentId: e.agentId ?? NO_AGENT, toolExecutionId: e.data.toolExecutionId, status: e.data.status,
        ...(e.data.errorClass ? { errorClass: e.data.errorClass } : {}),
      })
      return
    }
    case 'model.failed': {
      s.modelFailures.push({ agentId: e.agentId ?? NO_AGENT, ...(e.data.errorClass ? { errorClass: e.data.errorClass } : {}) })
      return
    }
    case 'turn.started': {
      // Counted once per event id (the `seen` gate above); ordered by the source line at finish.
      // A human line the harness did not stamp is still a turn (legacy counts it), but its
      // `occurredAt` is the replay's own clock and the emitter says so with `estimated` confidence —
      // legacy leaves such a line out of `user_message_timestamps`, and so does this projection.
      acc.turns.push({
        key: keyOf(e), at: e.occurredAt, stamped: e.provenance.confidence !== 'estimated',
        ...(e.data.previousAssistantAt !== undefined ? { previousAssistantAt: e.data.previousAssistantAt } : {}),
      })
      return
    }
    case 'turn.ended': {
      acc.turnEnds.push({
        key: keyOf(e), at: e.occurredAt, close: e.data.close,
        ...(e.data.durationMs !== undefined ? { durationMs: e.data.durationMs } : {}),
      })
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

/** Which legacy `SessionMeta` field each usage counter feeds — the caveat names the field a reader
 * actually looks at, not the event-side counter name. */
const TOKEN_FIELD_OF: Record<UsageCounter, 'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens'> = {
  input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_input_tokens', cacheWrite: 'cache_creation_input_tokens',
}

function tokensOfModel(t: Tokens, ttl?: { h1: number; m5: number }) {
  return {
    inputTokens: t.input, outputTokens: t.output, cacheReadInputTokens: t.cacheRead,
    cacheCreationInputTokens: t.cacheWrite,
    ...(ttl ? { cacheCreation1hInputTokens: ttl.h1, cacheCreation5mInputTokens: ttl.m5 } : {}),
    webSearchRequests: 0, costUSD: 0,
  }
}

/**
 * Source order for turn events, with the one tie that matters settled START-first.
 *
 * A `last-line` close is read from the LAST TIMED LINE of its turn (`replay-turns.ts` stamps it with
 * that line's `sourceRef`), and that line can be the prompt itself: a prompt followed only by untimed
 * lines closes on its own line, whether the close comes from the next prompt or from the final finish.
 * The close belongs to the turn that line OPENED, so on a shared line the start sorts first. A close
 * can never share a line with a LATER prompt — the pre-prompt close is stamped with a line strictly
 * before it.
 */
function compareTurnItems(a: { key: OrderKey; end: boolean }, b: { key: OrderKey; end: boolean }): number {
  if (a.key.ord === b.key.ord && a.end !== b.end) return a.end ? 1 : -1
  return compareKey(a.key, b.key)
}

/**
 * PURE. Legacy's two turn-time figures, from the main transcript's turn events.
 *
 * `active_minutes` is `activeMinutesOf` over the `TurnEvent`s that decide legacy's answer: one
 * `{userPrompt}` per EXACT prompt with a usable time (an estimated or unparseable one neither opens
 * nor closes a turn in legacy), then the LAST `turn.ended` before the next such prompt — `measured` as
 * `{measuredMs}` (the harness's own number wins) and `last-line` as `{turnEnd}` at the last timestamped
 * line, which is exactly where legacy closes the turn when the next prompt arrives or the file ends. A
 * resumed transcript can close one turn several times (a finish, then more lines); the last close is
 * the true one. Everything is ordered by SOURCE line (`keyOf`), never by time: legacy walks transcript
 * order, and timestamps can go backwards. A transcript with a usable timestamp and no prompt is `0`, as
 * legacy's `sawTime` makes it; one with none is absent. A turn with no usable close is OPEN — the walk
 * has not seen its end, and a figure would be a partial sum.
 *
 * `user_response_times` is legacy's arithmetic verbatim over each stamped prompt and its
 * `previousAssistantAt`: `(prompt - lastAssistant) / 1000`, kept rounded when in `[0, 3600)`.
 */
export function turnTime(
  turns: readonly TurnStart[], ends: readonly TurnEnd[], sawTime: boolean,
): { activeMinutes?: number; open: boolean; responseTimes: number[] } {
  type Item = { key: OrderKey; end: true; e: TurnEnd } | { key: OrderKey; end: false; t: TurnStart }
  const items: Item[] = [
    ...turns.map(t => ({ key: t.key, end: false as const, t })),
    ...ends.map(e => ({ key: e.key, end: true as const, e })),
  ].sort(compareTurnItems)

  const responseTimes: number[] = []
  const events: TurnEvent[] = []
  let current: TurnStart | null = null
  let close: TurnEnd | null = null
  let open = false
  const flush = (): void => {
    if (!current) return
    events.push({ ts: Date.parse(current.at), userPrompt: true })
    if (close?.close === 'measured' && typeof close.durationMs === 'number'
      && Number.isFinite(close.durationMs) && close.durationMs >= 0) {
      events.push({ ts: Date.parse(close.at), measuredMs: close.durationMs })
    } else if (close?.close === 'last-line' && usableTime(close.at)) {
      events.push({ ts: Date.parse(close.at), turnEnd: true })
    } else {
      open = true
    }
  }
  for (const it of items) {
    if (it.end) { if (current) close = it.e; continue }
    const t = it.t
    if (!t.stamped) continue
    if (t.previousAssistantAt) {
      const delta = (new Date(t.at).getTime() - new Date(t.previousAssistantAt).getTime()) / 1000
      if (delta >= 0 && delta < 3600) responseTimes.push(Math.round(delta))
    }
    if (!usableTime(t.at)) continue
    flush()
    current = t
    close = null
  }
  flush()

  if (open) return { open: true, responseTimes }
  const activeMinutes = events.length > 0 ? activeMinutesOf(events) : (sawTime ? 0 : undefined)
  return { ...(activeMinutes !== undefined ? { activeMinutes } : {}), open: false, responseTimes }
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
  const rules = (s.run && HARNESS_TOOL_RULES[s.run.harness]) || DEFAULT_TOOL_RULES
  const countedNames = (a: AgentAcc) => rules.counts === 'raw' ? a.rawToolNames : a.toolNames
  const mainToolNames = new Map<string, number>()
  const mainRawNames = new Set<string>()
  for (const id of mains) {
    const a = s.agents.get(id)
    if (!a) continue
    add(main.tokens, a.tokens)
    for (const [d, t] of a.daily) { const cur = main.daily.get(d) ?? zero(); add(cur, t); main.daily.set(d, cur) }
    for (const c of a.absentCounters) main.absentCounters.add(c)
    main.sawTtl ||= a.sawTtl; main.ttl1h += a.ttl1h; main.ttl5m += a.ttl5m
    for (const [n, c] of countedNames(a)) mainToolNames.set(n, (mainToolNames.get(n) ?? 0) + c)
    for (const n of a.rawToolNames.keys()) mainRawNames.add(n)
    main.linesAdded += a.linesAdded; main.linesRemoved += a.linesRemoved
    for (const f of a.files) main.files.add(f)
    main.turns.push(...a.turns)
    main.turnEnds.push(...a.turnEnds)
    main.sawTime ||= a.sawTime
    main.compactCount += a.compactCount; main.compactMs += a.compactMs
    if (a.compactDropped !== undefined) main.compactDropped = (main.compactDropped ?? 0) + a.compactDropped
    if (a.gauge && (!main.gauge || compareKey(a.gauge.key, main.gauge.key) > 0)) main.gauge = a.gauge
    if (a.firstModel && (!main.firstModel || compareKey(a.firstModel.key, main.firstModel.key) < 0)) main.firstModel = a.firstModel
  }
  // A harness whose legacy session folds EVERY agent's counts (`countScope`) gets its non-main agents'
  // counts here too — never the gauge, the model, turns or compactions, which stay the main agent's.
  if (rules.countScope === 'all-agents') {
    const mainSet = new Set(mains)
    for (const [id, a] of [...s.agents].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
      if (id === NO_AGENT || mainSet.has(id)) continue
      add(main.tokens, a.tokens)
      for (const [d, t] of a.daily) { const cur = main.daily.get(d) ?? zero(); add(cur, t); main.daily.set(d, cur) }
      for (const c of a.absentCounters) main.absentCounters.add(c)
      main.sawTtl ||= a.sawTtl; main.ttl1h += a.ttl1h; main.ttl5m += a.ttl5m
      for (const [n, c] of countedNames(a)) mainToolNames.set(n, (mainToolNames.get(n) ?? 0) + c)
      for (const n of a.rawToolNames.keys()) mainRawNames.add(n)
      main.linesAdded += a.linesAdded; main.linesRemoved += a.linesRemoved
      for (const f of a.files) main.files.add(f)
    }
  }
  // Session-level events (no agent) also bear on whether compactions were recorded.
  const recorded = [...mains, NO_AGENT].every(id => s.agents.get(id)?.compactionRecorded ?? true)
  // …and on whether human turns were: a turn carries no agent only if the emitter says so.
  const turnsRecorded = [...mains, NO_AGENT].every(id => s.agents.get(id)?.turnsRecorded ?? true)
  const sessionTurns = s.agents.get(NO_AGENT)?.turns ?? []
  const turnEndsRecorded = [...mains, NO_AGENT].every(id => s.agents.get(id)?.turnEndsRecorded ?? true)
  const sessionEnds = s.agents.get(NO_AGENT)?.turnEnds ?? []
  const sawTime = main.sawTime || (s.agents.get(NO_AGENT)?.sawTime ?? false)

  const ruleNames = rules.names === 'raw' ? [...mainRawNames] : [...mainToolNames.keys()]
  const meta: ProjectedSessionMeta = {
    tool_counts: Object.fromEntries(mainToolNames),
    tool_errors: 0,
    tool_error_categories: {},
    input_tokens: main.tokens.input,
    output_tokens: main.tokens.output,
    cache_read_input_tokens: main.tokens.cacheRead,
    cache_creation_input_tokens: main.tokens.cacheWrite,
    uses_task_agent: false,
    uses_mcp: ruleNames.some(rules.mcp),
    uses_web_search: ruleNames.some(rules.webSearch),
    uses_web_fetch: ruleNames.some(rules.webFetch),
    lines_added: main.linesAdded,
    lines_removed: main.linesRemoved,
    files_modified: main.files.size,
  }

  // D21 (2026-09-26): a counter absent from at least one main-agent `model.completed` event means
  // the corresponding field above is a sum over what was reported, not a measured total — said as a
  // caveat per counter, in `USAGE_COUNTERS` order, rather than silently letting it read as exact.
  // The cost is priced from those very counters (`sessionCostUSD` below), so it gets the same caveat.
  if (main.absentCounters.size > 0) {
    const absent = USAGE_COUNTERS.filter(c => main.absentCounters.has(c))
    for (const c of absent) {
      caveats.push({
        field: TOKEN_FIELD_OF[c],
        reason: `at least one main-agent model.completed event did not report ${c}; the figure sums only what was `
          + 'reported and is a PARTIAL total, never a measured one',
      })
    }
    caveats.push({
      field: 'costUSD',
      reason: `priced from a token set missing ${absent.join(', ')} on at least one event; the figure is an `
        + 'estimate over a partial sum, never a measured cost',
    })
  }

  // Tool errors: a `failed` result is a tool error. A `cancelled` one (the whole call interrupted)
  // lost the is_error flag legacy counts — said, not folded in.
  const mainSet = new Set(mains)
  let cancelled = 0
  for (const f of s.failures) {
    if (!mainSet.has(f.agentId) || !rules.toolFailuresAreErrors) continue
    if (f.status === 'cancelled') { cancelled++; continue }
    if (rules.errorsBy === 'errorClass') {
      if (!f.errorClass) continue
      meta.tool_errors++
      meta.tool_error_categories[f.errorClass] = (meta.tool_error_categories[f.errorClass] ?? 0) + 1
      continue
    }
    meta.tool_errors++
    const ref = s.toolNameById.get(f.toolExecutionId)
    const name = ref ? (rules.counts === 'raw' ? ref.raw : ref.canonical) : 'unknown'
    meta.tool_error_categories[name] = (meta.tool_error_categories[name] ?? 0) + 1
  }
  if (rules.modelFailuresAreErrors) {
    for (const f of s.modelFailures) {
      if (!mainSet.has(f.agentId) || !f.errorClass) continue
      meta.tool_errors++
      meta.tool_error_categories[f.errorClass] = (meta.tool_error_categories[f.errorClass] ?? 0) + 1
    }
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
    if (HARNESS_IDS.includes(s.run.harness)) meta.harness = s.run.harness as SessionMeta['harness']
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

  // Human turns — the MAIN transcript's, exactly as legacy counts `isHumanUserEntry` lines there.
  // Same shape as the compactions above: a walk of events that predate `turn.started` says nothing,
  // and a walk of nothing says nothing; only a walk that could have seen a turn reports a count.
  if (turnsRecorded && s.agents.size > 0) {
    const turns = [...main.turns, ...sessionTurns].sort((a, b) => compareKey(a.key, b.key))
    meta.user_message_count = turns.length
    meta.rounds = turns.length
    meta.user_interruptions = Math.max(0, turns.length - 1)
    meta.user_message_timestamps = turns.filter(t => t.stamped).map(t => t.at)
  } else if (s.agents.size > 0) {
    caveats.push({ field: 'user_message_count', reason: 'not recorded by this adapter version (events replayed before turn.started existed); absent, not zero' })
  }

  // Turn time (D25) — `active_minutes` and `user_response_times`, the main transcript's, under their
  // own gate: a walk replayed before `turn.ended` existed cannot vouch for a single close.
  if (turnEndsRecorded && s.agents.size > 0) {
    const t = turnTime([...main.turns, ...sessionTurns], [...main.turnEnds, ...sessionEnds], sawTime)
    meta.user_response_times = t.responseTimes
    if (t.open) {
      caveats.push({ field: 'active_minutes', reason: 'a turn has no usable turn.ended yet (the transcript is still open); absent, not a partial sum' })
    } else if (t.activeMinutes !== undefined) {
      meta.active_minutes = t.activeMinutes
    }
  } else if (s.agents.size > 0) {
    for (const field of ['active_minutes', 'user_response_times']) {
      caveats.push({ field, reason: 'not recorded by this adapter version (events replayed before turn.ended existed); absent, not zero' })
    }
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

  // D21 — a subagent's rollup is a sum too, so an absent counter under it makes THAT invocation's
  // figures partial. Kept apart from the main agent's set: the session totals are not affected.
  const partialInvocations = new Map<string, Set<UsageCounter>>()
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
        if (a.absentCounters.size > 0) {
          const set = partialInvocations.get(root) ?? new Set<UsageCounter>()
          for (const c of a.absentCounters) set.add(c)
          partialInvocations.set(root, set)
        }
        for (const [m, t] of a.byModel) { const cur = byModel.get(m) ?? zero(); add(cur, t); byModel.set(m, cur) }
        for (const [name, c] of countedNames(a)) {
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

  for (const [root, set] of partialInvocations) {
    const absent = USAGE_COUNTERS.filter(c => set.has(c))
    caveats.push({
      field: `agentMetrics.invocations[${root}]`,
      reason: `a model.completed event of this invocation did not report ${absent.join(', ')}; its tokens and `
        + 'cost sum only what was reported and are PARTIAL, never measured',
    })
  }

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
  meta.uses_task_agent = ruleNames.some(rules.taskAgent) || (rules.subagentsImplyTaskAgent !== false && subKind.size > 0)

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
  // v2 (A4, 2026-09-27): `countScope` — kimi sessions sum every agent's counts, as legacy does.
  version: 2,
  empty: () => ({
    seen: new Set(), agents: new Map(), started: new Map(), ended: new Map(), toolNameById: new Map(),
    failures: [], modelFailures: [], sessionStart: undefined, startAt: undefined, sessionEnd: undefined, run: undefined,
  }),
  fold(state, events) {
    for (const e of events) foldOne(state, e)
  },
  finish,
}
