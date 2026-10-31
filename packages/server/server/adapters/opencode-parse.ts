/** PURE OpenCode SQLite rows → SessionMeta. Count message usage ONLY: session totals and
 * step-finish parts repeat it. Reasoning is additive (OpenCode 1.17.9 session.getUsage).
 * https://github.com/anomalyco/opencode/blob/v1.17.9/packages/opencode/src/session/session.ts
 */
import { activeMinutesOf, emptyModelUsage, isLocalModelId, type ModelUsage, type SessionMeta, type TurnEvent } from '@agentistics/core'

export interface OpencodeSessionRow {
  id: string; directory: string; title: string; time_created: number; time_updated: number
}
export interface OpencodeMessageRow {
  id: string; session_id: string; time_created: number; time_updated: number; data: string
}
export interface OpencodePartRow {
  id: string; message_id: string; session_id: string; time_created: number; data: string
}
export type OpencodeModels = Record<string, { models?: Record<string, { limit?: { context?: number } }> }>

function object(value: unknown): Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}
function json(value: string): Record<string, any> { try { return object(JSON.parse(value)) } catch { return {} } }
const num = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
const str = (v: unknown): string => typeof v === 'string' ? v : ''
const iso = (v: number): string => v > 0 && Number.isFinite(v) && !Number.isNaN(new Date(v).getTime()) ? new Date(v).toISOString() : ''

/** Preserve unknown routes: a custom provider naming a known model is NOT a known price.
 * OpenCode free variants keep their route so a paid model prefix cannot price them. */
export function opencodeModel(model: string, provider: string): string {
  const routed = `${provider || 'unknown-opencode-provider'}/${model}`
  if (isLocalModelId(routed)) return routed
  if (provider === 'opencode' && (model.endsWith('-free') || model === 'big-pickle')) return routed
  if (['anthropic', 'openai', 'google', 'opencode'].includes(provider)) return model
  return routed
}

export function parseOpencodeSession(
  row: OpencodeSessionRow, messages: readonly OpencodeMessageRow[], parts: readonly OpencodePartRow[] = [],
  models: OpencodeModels = {},
): SessionMeta | null {
  const start = iso(row.time_created)
  if (!start) return null
  const sorted = [...new Map(messages.map(m => [m.id, m])).values()].sort((a, b) => a.time_created - b.time_created || a.id.localeCompare(b.id))
  const usage: Record<string, ModelUsage> = {}
  const events: TurnEvent[] = []
  const hours: number[] = [], timestamps: string[] = []
  let input = 0, output = 0, read = 0, write = 0, users = 0, assistants = 0, sawUsage = false
  let model: string | undefined, context: number | undefined, window: number | undefined
  let latest = -1, firstPrompt = ''
  const text = new Map<string, string>()
  for (const p of [...parts].sort((a, b) => a.time_created - b.time_created || a.id.localeCompare(b.id))) {
    const d = json(p.data)
    if (d.type === 'text' && typeof d.text === 'string' && !d.synthetic && !d.ignored) {
      text.set(p.message_id, (text.get(p.message_id) ?? '') + d.text)
    }
  }
  for (const m of sorted) {
    const d = json(m.data), t = object(d.time)
    const at = num(t.created) || m.time_created
    if (d.role === 'user') {
      users++
      if (!firstPrompt) firstPrompt = text.get(m.id) ?? ''
      if (iso(at)) { timestamps.push(iso(at)); hours.push(new Date(at).getHours()); events.push({ ts: at, userPrompt: true }) }
      continue
    }
    if (d.role !== 'assistant') continue
    assistants++
    const end = num(t.completed) || m.time_updated
    if (iso(end)) events.push({ ts: end })
    // Pending streaming rows may contain placeholder zeros. Wait until the response settles.
    if (!d.finish && !d.error && !num(t.completed)) continue
    if (!d.tokens || typeof d.tokens !== 'object') continue
    sawUsage = true
    const u = object(d.tokens), cache = object(u.cache)
    const i = num(u.input), o = num(u.output) + num(u.reasoning), r = num(cache.read), w = num(cache.write)
    input += i; output += o; read += r; write += w
    const raw = str(d.modelID), provider = str(d.providerID)
    const id = raw ? opencodeModel(raw, provider) : 'unknown-opencode-model'
    const bucket = usage[id] ??= emptyModelUsage()
    bucket.inputTokens += i; bucket.outputTokens += o
    bucket.cacheReadInputTokens += r; bucket.cacheCreationInputTokens += w
    if (end >= latest) {
      latest = end
      model = raw ? id : undefined
      // In getUsage, input is normalized inputTokens minus both cache counters. Their sum
      // reconstructs contextTokens, never the session lifetime total or response output.
      context = i + r + w || undefined
      const limit = models[provider]?.models?.[raw]?.limit?.context
      window = num(limit) || undefined
    }
  }
  if (!users && !assistants) return null
  return {
    session_id: row.id, project_path: row.directory, title: row.title,
    start_time: start, end_time: iso(row.time_updated) || undefined,
    duration_minutes: Math.max(0, Math.round(((num(row.time_updated) || row.time_created) - row.time_created) / 60000)),
    active_minutes: activeMinutesOf(events.sort((a, b) => a.ts - b.ts)),
    user_message_count: users, assistant_message_count: assistants,
    input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write,
    ...(sawUsage ? { model_usage: usage } : { tokens_unavailable: true as const }),
    model, context_tokens: context, context_window: window,
    tool_counts: {}, tool_output_tokens: {}, agent_file_reads: {}, languages: [], git_commits: 0, git_pushes: 0,
    first_prompt: firstPrompt, user_interruptions: 0, user_response_times: [], tool_errors: 0,
    tool_error_categories: {}, uses_task_agent: false, uses_mcp: false, uses_web_search: false, uses_web_fetch: false,
    lines_added: 0, lines_removed: 0, files_modified: 0, message_hours: hours, user_message_timestamps: timestamps,
    harness: 'opencode', _source: 'jsonl',
  }
}
