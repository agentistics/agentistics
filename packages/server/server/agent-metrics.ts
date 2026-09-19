import { readFile } from 'fs/promises'
import { basename } from 'path'
import { calcCost } from '@agentistics/core'
import { totalsOf } from './subagent-parse'
import { enrichFromSubagentTranscripts } from './subagent-metrics'
import type { AgentInvocation, SessionAgentMetrics } from '@agentistics/core'

interface ToolUseRecord {
  id: string
  input: {
    description?: string
    subagent_type?: string
    prompt?: string
  }
}

interface ToolUseResult {
  status?: string
  agentType?: string
  agentId?: string
  totalDurationMs?: number
  totalTokens?: number
  totalToolUseCount?: number
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  toolStats?: {
    readCount?: number
    searchCount?: number
    bashCount?: number
    editFileCount?: number
    linesAdded?: number
    linesRemoved?: number
    otherToolCount?: number
  }
}

/**
 * A walk over a transcript's agent launches, paused between reads.
 *
 * Kept as its own type for the reason `ActiveTimeState` is: a LIVE transcript is read in pieces as
 * its session writes it (`transcript-cursor.ts`), and the alternative is re-reading the whole file
 * on every poll to re-derive a handful of rows.
 */
export interface AgentMetricsState {
  /** Agent `tool_use` ids still waiting for the result that answers them. */
  pendingAgents: Map<string, ToolUseRecord>
  /** Rows built so far. They carry `costUSD: 0` until `finishAgentMetrics` prices them. */
  invocations: AgentInvocation[]
  /** Every agent already given a row, so a later report ON one cannot open a second. */
  recordedAgentIds: Set<string>
}

/** A walk that has seen nothing. */
export function emptyAgentMetrics(): AgentMetricsState {
  return { pendingAgents: new Map(), invocations: [], recordedAgentIds: new Set() }
}

/**
 * Advance `state` over ONE already-parsed entry. Mutates `state`; returns nothing.
 *
 * This is the entry-level half of the fold, and it exists so the MAIN transcript walk in
 * `jsonl.ts` can hand over the object it has already parsed. Agent metrics used to be a second
 * full pass over the same file — `JSON.parse` run again on every line of a transcript that reaches
 * tens of megabytes, to find a handful of rows. The rule below is unchanged; only who calls it is.
 */
export function foldAgentEntry(state: AgentMetricsState, e: Record<string, unknown>): void {
  // Scan assistant messages for Agent tool_use items
  if (e.type === 'assistant') {
    const msg = e.message as Record<string, unknown> | undefined
    if (!Array.isArray(msg?.content)) return

    for (const item of msg!.content as Record<string, unknown>[]) {
      if (
        item.type === 'tool_use' &&
        item.name === 'Agent' &&
        typeof item.id === 'string'
      ) {
        const input = (item.input ?? {}) as ToolUseRecord['input']
        state.pendingAgents.set(item.id as string, {
          id: item.id as string,
          input,
        })
      }
    }
    return
  }

  // Scan user messages for toolUseResult + tool_result content correlation
  if (e.type === 'user') {
    // The toolUseResult is at message envelope level (not inside content)
    const toolUseResult = e.toolUseResult as ToolUseResult | undefined
    if (!toolUseResult) return

    const msg = e.message as Record<string, unknown> | undefined
    const contentArr = Array.isArray(msg?.content)
      ? (msg!.content as Record<string, unknown>[])
      : []

    // Find the tool_result item(s) in this message content — they carry the tool_use_id
    for (const item of contentArr) {
      if (item.type !== 'tool_result') continue
      const toolUseId = item.tool_use_id as string | undefined
      if (!toolUseId) continue

      const pending = state.pendingAgents.get(toolUseId)
      // A result that NAMES an agent is a launch whatever tool produced it — that is the
      // background forked skill, whose `Skill` call left nothing pending here. It is not a launch
      // when the agent already has a row: a later tool reporting on one is a report, not a spawn.
      const named = typeof toolUseResult.agentId === 'string' ? toolUseResult.agentId : ''
      if (!pending && (!named || state.recordedAgentIds.has(named))) continue

      // We have a match — build the AgentInvocation
      state.pendingAgents.delete(toolUseId)
      if (named) state.recordedAgentIds.add(named)
      const input = pending?.input ?? {}

      /**
       * Did this result carry NUMBERS at all?
       *
       * Since Claude Code made the `Agent` tool asynchronous (measured: the shape changed on
       * 2026-08-14) the result is only `{ agentId, description, isAsync, outputFile,
       * resolvedModel, status: 'async_launched' }` — no `usage`, no totals, no `toolStats`. Every
       * `?? 0` below then fired at once and the invocation was published priced at nothing, which
       * is exactly the confident zero this repository forbids: the panel kept rendering rows and
       * only the values were gone, which is why it went unnoticed for three weeks.
       *
       * So a result with no numbers is marked UNMEASURED here and enriched from the subagent's own
       * transcript by `subagent-metrics.ts`. What cannot be found there stays unmeasured, and the
       * surface renders N/A.
       */
      const measured =
        toolUseResult.usage !== undefined ||
        toolUseResult.totalTokens !== undefined ||
        toolUseResult.totalDurationMs !== undefined ||
        toolUseResult.totalToolUseCount !== undefined ||
        toolUseResult.toolStats !== undefined

      const usage = toolUseResult.usage ?? {}
      const toolStats = toolUseResult.toolStats ?? {}

      const inputTokens = usage.input_tokens ?? 0
      const outputTokens = usage.output_tokens ?? 0
      const cacheReadTokens = usage.cache_read_input_tokens ?? 0
      const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0

      state.invocations.push({
        toolUseId,
        ...(toolUseResult.agentId ? { agentId: toolUseResult.agentId } : {}),
        ...(measured ? {} : { unmeasured: true as const }),
        agentType: toolUseResult.agentType ?? input.subagent_type ?? 'unknown',
        description: input.description ?? '',
        status: (toolUseResult.status === 'failed') ? 'failed' : 'completed',
        totalTokens: toolUseResult.totalTokens ?? (inputTokens + outputTokens),
        totalDurationMs: toolUseResult.totalDurationMs ?? 0,
        totalToolUseCount: toolUseResult.totalToolUseCount ?? 0,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        toolStats: {
          readCount: toolStats.readCount ?? 0,
          searchCount: toolStats.searchCount ?? 0,
          bashCount: toolStats.bashCount ?? 0,
          editFileCount: toolStats.editFileCount ?? 0,
          linesAdded: toolStats.linesAdded ?? 0,
          linesRemoved: toolStats.linesRemoved ?? 0,
          otherToolCount: toolStats.otherToolCount ?? 0,
        },
        costUSD: 0,
      })
    }
  }
}

/**
 * Advance `state` over `lines`, in transcript order. Mutates `state`; returns nothing.
 *
 * The rule is `extractAgentMetrics`'s own, unchanged — see its header for the three shapes an
 * agent launch takes. The one thing that moved is PRICING: a row is folded with `costUSD: 0` and
 * priced in `finishAgentMetrics` instead. It has to be, and not only for tidiness: the model id
 * this prices against is the FIRST `claude-*` model in the whole transcript, which a fold that is
 * still reading has not necessarily seen yet. Pricing where the row is built would bill an early
 * agent at whatever was known when the poll that found it landed — a number that depends on when
 * somebody opened the dashboard. Priced at the end, every row gets the same id the one-shot reader
 * has always given it.
 */
export function foldAgentMetrics(state: AgentMetricsState, lines: Iterable<string>): void {
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    let e: Record<string, unknown>
    try { e = JSON.parse(line) } catch { continue }
    foldAgentEntry(state, e)
  }
}

/**
 * The metrics as of right now, WITHOUT ending the walk.
 *
 * `state` is left untouched — the pending launches are drained into a COPY of the rows, because a
 * launch the parent has not answered YET is not the same thing as one it never will, and the next
 * fold may still answer it.
 */
export function finishAgentMetrics(state: AgentMetricsState, modelId: string): SessionAgentMetrics {
  const invocations = state.invocations.map(inv => ({
    ...inv,
    costUSD: calcCost(
      {
        inputTokens: inv.inputTokens,
        outputTokens: inv.outputTokens,
        cacheReadInputTokens: inv.cacheReadTokens,
        cacheCreationInputTokens: inv.cacheWriteTokens,
        webSearchRequests: 0,
        costUSD: 0,
      },
      modelId
    ),
  }))

  /**
   * Every launch the parent never answered — the plain background agent.
   *
   * Appended after the answered ones rather than woven back into their place: the transcript gives
   * no moment at which they finished, and any position chosen for them would be invented. They
   * carry no numbers here; the transcript beside the session does.
   */
  for (const [toolUseId, pending] of state.pendingAgents) {
    invocations.push({
      toolUseId,
      unmeasured: true as const,
      agentType: pending.input.subagent_type ?? 'unknown',
      description: pending.input.description ?? '',
      status: 'completed',
      totalTokens: 0,
      totalDurationMs: 0,
      totalToolUseCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      toolStats: {
        readCount: 0, searchCount: 0, bashCount: 0, editFileCount: 0,
        linesAdded: 0, linesRemoved: 0, otherToolCount: 0,
      },
      costUSD: 0,
    })
  }

  return totalsOf(invocations)
}

/**
 * Parse JSONL lines from a session file and extract agent invocation metrics.
 *
 * Key JSONL structure:
 * - Assistant messages have `content` items with `type: "tool_use"` and `name: "Agent"`
 * - The input has: `{ description, subagent_type, prompt }`
 * - Correlating user messages have `toolUseResult` at the message level with usage/timing info
 * - Correlation: match by `tool_use_id` in the tool_result content array
 *
 * **An agent is not defined by the tool that launched it.** Three shapes reach this reader, and for
 * a release only the first of them produced a row (measured 2026-09-06, one machine, 541 subagent
 * transcripts on disk):
 *
 * 1. An `Agent` tool_use answered by a `tool_result` — 528 of them, and all this used to read.
 * 2. A `tool_result` naming an agent with NO `Agent` call before it. A skill run in the BACKGROUND
 *    is a `Skill` tool_use whose result is `{status:'forked', background:true, agentId}` — the
 *    parent names the agent perfectly well, and keying on the tool name made the whole run vanish.
 * 3. An `Agent` tool_use the parent NEVER answered — launched and left running. It used to sit in
 *    the pending map to the end of the file and be dropped, although it had a full transcript.
 *
 * Shapes 2 and 3 are recorded UNMEASURED here and measured from the subagent's own transcript by
 * `subagent-metrics.ts`, which joins the two sides through `subagent-join.ts`. An agent already
 * recorded never opens a second row: a later tool reporting ON an agent is not another launch.
 */
export function extractAgentMetrics(lines: Iterable<string>, modelId: string): SessionAgentMetrics {
  const state = emptyAgentMetrics()
  foldAgentMetrics(state, lines)
  return finishAgentMetrics(state, modelId)
}

/**
 * Read a JSONL file and extract agent metrics from it.
 * Used for meta-sourced sessions that have agent tool usage.
 */
export async function extractAgentMetricsFromFile(filePath: string): Promise<SessionAgentMetrics> {
  const empty: SessionAgentMetrics = { invocations: [], totalInvocations: 0, unmeasuredInvocations: 0, totalTokens: 0, totalDurationMs: 0, totalCostUSD: 0 }
  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch {
    return empty
  }

  const lines = content.split('\n')

  // Extract model ID from first assistant message
  let modelId = ''
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    try {
      const e = JSON.parse(line) as Record<string, unknown>
      if (e.type === 'assistant') {
        const msg = e.message as Record<string, unknown> | undefined
        if (typeof msg?.model === 'string') { modelId = msg.model; break }
      }
    } catch { continue }
  }

  // The session id is the file's own name — which is exactly what names the `subagents/` directory
  // holding each subagent's transcript.
  const sessionId = basename(filePath).replace(/\.jsonl$/, '')
  return enrichFromSubagentTranscripts(extractAgentMetrics(lines, modelId), filePath, sessionId)
}
