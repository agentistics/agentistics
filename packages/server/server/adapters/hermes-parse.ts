/**
 * adapters/hermes-parse.ts — PURE: one Hermes `state.db` session row (+ its messages) → `SessionMeta`.
 *
 * The rules are the engine replay's (`integrations/hermes`), so both sides count the same:
 * - **Usage is the session row's cumulative counters.** `session_model_usage` is the same spend split
 *   per model and is never read here, so it can never be added twice. `input` excludes the cache;
 *   `reasoning` is already inside `output`.
 * - **Cost** Hermes states wins: `actual_cost_usd ?? estimated_cost_usd`, unless `cost_status` is
 *   `unknown` or absent (Hermes then writes `COALESCE(?, 0)`, which is not a price) — those sessions
 *   are priced by the table, and a model the table does not know has no cost, never 0.
 * - **Copied history is not new work**: `/branch` and a compression rotation copy the parent's rows into
 *   the child (same role, timestamp and tool ids). Those rows are skipped; the child's counters are its own.
 * - A `delegate_task` subagent's or an automation source's (cron, kanban, tool, a2a) `user` rows are
 *   instructions, not a person's messages: they bound active time and nothing else.
 * - A turn runs from a `user` row to the last row before the next one (`activeMinutesOf`).
 * - A tool call counts once per call id (the assistant row's request, else its result row). Hermes records
 *   no failure flag, so no tool error is claimed. Context and git lines are not claimed either
 *   (`HARNESS_CAPABILITIES.hermes`).
 */
import { activeMinutesOf, emptyModelUsage, hermesModelId, type SessionMeta, type TurnEvent } from '@agentistics/core'
import { canonicalTool, countGitCommands } from '../harness-activity'

export interface HermesSessionDbRow {
  id: string
  source: string | null
  model: string | null
  parent_session_id: string | null
  model_config: string | null
  cwd: string | null
  title: string | null
  started_at: number
  ended_at: number | null
  last_activity_at: number | null
  api_call_count: number | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  estimated_cost_usd: number | null
  actual_cost_usd: number | null
  cost_status: string | null
  /** Who billed the session — the only proof a model was local. Absent on a file without the column. */
  billing_provider?: string | null
}

export interface HermesMessageDbRow {
  session_id: string
  role: string
  /** Only a user row's text is read (the first prompt); `null` otherwise. */
  content: string | null
  tool_call_id: string | null
  tool_calls: string | null
  tool_name: string | null
  /** Seconds since the epoch. */
  timestamp: number | null
  message_uid: string | null
  _compressed_summary: number | null
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
const isoOf = (seconds: unknown): string | undefined => {
  const ms = num(seconds) * 1000
  return ms > 0 ? new Date(ms).toISOString() : undefined
}

function callIds(raw: string | null): string {
  if (!raw) return ''
  try {
    const arr: unknown = JSON.parse(raw)
    return Array.isArray(arr)
      ? arr.map(c => (c && typeof c === 'object' ? String((c as { id?: unknown; call_id?: unknown }).id ?? (c as { call_id?: unknown }).call_id ?? '') : '')).join(',')
      : ''
  } catch { return '' }
}

const copyKey = (m: HermesMessageDbRow): string =>
  JSON.stringify([m.role, m.timestamp, m.tool_call_id ?? null, callIds(m.tool_calls)])

function isDelegated(modelConfig: string | null): boolean {
  if (!modelConfig) return false
  try {
    const v = JSON.parse(modelConfig) as { _delegate_from?: unknown } | null
    return typeof v?._delegate_from === 'string' && v._delegate_from !== ''
  } catch { return false }
}

/** The roles that are a turn (the engine reader's rule); a `system` row is nobody's time. */
const TURN_ROLES: ReadonlySet<string> = new Set(['user', 'assistant', 'tool'])

/** Turn rows of this session that are not copies of the parent's. */
function ownMessages(messages: HermesMessageDbRow[], parent: HermesMessageDbRow[]): HermesMessageDbRow[] {
  const keys = new Set(parent.map(copyKey))
  const uids = new Set(parent.flatMap(m => (m.message_uid ? [m.message_uid] : [])))
  return messages.filter(m => TURN_ROLES.has(m.role) && !m._compressed_summary && !keys.has(copyKey(m)) && !(m.message_uid && uids.has(m.message_uid)))
}

/** `sessions.source` values no person types into (`agent/session_source.py`). */
const AUTOMATION_SOURCES: ReadonlySet<string> = new Set(['cron', 'kanban', 'tool', 'a2a', 'subagent'])

/** Hermes' own tool names → the shared vocabulary (the engine replay's table). */
const HERMES_TOOLS: Record<string, string> = {
  terminal: 'Bash', read_file: 'Read', write_file: 'Write', patch: 'Edit', search_files: 'Grep', delegate_task: 'Task',
}
const toolName = (raw: string): string => HERMES_TOOLS[raw] ?? canonicalTool('hermes', raw)

interface ToolCall { id: string; name: string; args: Record<string, unknown> }

function object(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') { try { return object(JSON.parse(v)) } catch { return {} } }
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
}

function toolCalls(raw: string | null): ToolCall[] {
  if (!raw) return []
  try {
    const arr: unknown = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.flatMap(c => {
      const call = object(c), fn = object(call.function)
      const id = String(call.id ?? call.call_id ?? '')
      if (!id) return []
      return [{ id, name: String(fn.name ?? call.name ?? 'unknown_tool'), args: object(fn.arguments ?? call.arguments) }]
    })
  } catch { return [] }
}

/** Tool, git and file counts over a session's own rows. */
function toolActivity(own: HermesMessageDbRow[]) {
  const toolCounts: Record<string, number> = {}
  const edited = new Set<string>()
  const seen = new Set<string>()
  let commits = 0, pushes = 0
  const count = (name: string): void => { const n = toolName(name); toolCounts[n] = (toolCounts[n] ?? 0) + 1 }
  for (const m of own) {
    if (m.role === 'assistant') {
      for (const call of toolCalls(m.tool_calls)) {
        if (seen.has(call.id)) continue // a rewritten copy of the same call is the same execution
        seen.add(call.id)
        count(call.name)
        if (call.name === 'terminal' && typeof call.args.command === 'string') {
          const git = countGitCommands(call.args.command)
          commits += git.commits; pushes += git.pushes
        }
        if ((call.name === 'write_file' || call.name === 'patch') && typeof call.args.path === 'string') edited.add(call.args.path)
      }
    } else if (m.role === 'tool' && m.tool_call_id && !seen.has(m.tool_call_id)) {
      // Its request row was deleted by a rewrite: the result is the execution's only record.
      seen.add(m.tool_call_id)
      count(m.tool_name || 'unknown_tool')
    }
  }
  return { toolCounts, commits, pushes, files: edited.size }
}

/** Turn boundaries and a person's response times (`[0, 3600)` s after the last assistant row). */
function turnTiming(own: HermesMessageDbRow[], human: boolean) {
  const events: TurnEvent[] = []
  const responseTimes: number[] = []
  let lastAssistant: number | undefined
  for (const m of own) {
    if (typeof m.timestamp !== 'number' || m.timestamp <= 0) continue
    const prompt = m.role === 'user'
    events.push({ ts: Math.round(m.timestamp * 1000), ...(prompt ? { userPrompt: true } : {}) })
    if (m.role === 'assistant') lastAssistant = Math.max(lastAssistant ?? 0, m.timestamp)
    else if (prompt && human && lastAssistant !== undefined) {
      const delta = m.timestamp - lastAssistant
      if (delta >= 0 && delta < 3600) responseTimes.push(Math.round(delta))
    }
  }
  return { activeMinutes: activeMinutesOf(events), responseTimes }
}

/** The cost Hermes states, or `null` when it states none. */
export function hermesStatedCostUSD(row: Pick<HermesSessionDbRow, 'cost_status' | 'actual_cost_usd' | 'estimated_cost_usd'>): number | null {
  if (!row.cost_status || row.cost_status === 'unknown') return null
  const v = row.actual_cost_usd ?? row.estimated_cost_usd
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

/** `null` for a session that never did anything (no message of its own and no billed call). */
export function parseHermesSession(row: HermesSessionDbRow, messages: HermesMessageDbRow[], parentMessages: HermesMessageDbRow[] = []): SessionMeta | null {
  const own = ownMessages(messages, parentMessages)
  const input = num(row.input_tokens), output = num(row.output_tokens)
  const cacheRead = num(row.cache_read_tokens), cacheWrite = num(row.cache_write_tokens)
  const hasTokens = input + output + cacheRead + cacheWrite > 0
  const billed = hasTokens || num(row.api_call_count) > 0
  const human = !isDelegated(row.model_config) && !AUTOMATION_SOURCES.has(row.source ?? '')
  const people = human ? own.filter(m => m.role === 'user') : []
  const assistants = own.filter(m => m.role === 'assistant').length
  if (own.length === 0 && !billed) return null

  const timed = own.map(m => m.timestamp).filter((t): t is number => typeof t === 'number' && t > 0)
  const start = isoOf(row.started_at) ?? ''
  const endSeconds = Math.max(num(row.ended_at), num(row.last_activity_at), ...timed, 0)
  const end = isoOf(endSeconds)

  const activity = toolActivity(own)
  const timing = turnTiming(own, human)
  const model = hermesModelId(row.model, { provider: row.billing_provider }) || undefined
  const stated = billed ? hermesStatedCostUSD(row) : null
  const usage = stated === null
    ? undefined
    : {
        [model ?? 'unknown']: {
          ...emptyModelUsage(),
          inputTokens: input, outputTokens: output,
          cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheWrite,
          costUSD: stated, costSource: 'harness' as const,
        },
      }

  return {
    session_id: row.id,
    project_path: row.cwd ?? '',
    ...(row.title ? { title: row.title } : {}),
    start_time: start,
    ...(end ? { end_time: end } : {}),
    ...(endSeconds > 0 && num(row.started_at) > 0 ? { duration_minutes: Math.max(0, Math.round((endSeconds - row.started_at) / 60)) } : {}),
    ...(timing.activeMinutes !== undefined ? { active_minutes: timing.activeMinutes } : {}),
    user_message_count: people.length,
    assistant_message_count: assistants,
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    ...(!billed ? { tokens_unavailable: true as const } : {}),
    ...(usage ? { model_usage: usage } : {}),
    ...(model ? { model } : {}),
    tool_counts: activity.toolCounts, tool_output_tokens: {}, agent_file_reads: {}, languages: [],
    git_commits: activity.commits, git_pushes: activity.pushes,
    first_prompt: people.find(m => m.content)?.content?.slice(0, 500) ?? '',
    user_interruptions: 0, user_response_times: timing.responseTimes, tool_errors: 0, tool_error_categories: {},
    uses_task_agent: (activity.toolCounts.Task ?? 0) > 0, uses_mcp: false, uses_web_search: false, uses_web_fetch: false,
    lines_added: 0, lines_removed: 0, files_modified: activity.files,
    message_hours: timed.map(t => new Date(t * 1000).getHours()),
    user_message_timestamps: people.flatMap(m => isoOf(m.timestamp) ?? []),
    harness: 'hermes',
    _source: 'jsonl',
  }
}
