/**
 * journal/import-store.ts — the COARSE event set a consolidate-store entry becomes (P2 §4). PURE.
 *
 * The consolidate store (`~/.agentistics/sessions/<harness>/<id>.json`) holds COMPUTED sessions: a
 * `SessionMeta` per conversation, written by every build and never deleted. When a conversation's
 * own artifacts are gone (Claude's 30-day cleanup, a wiped `~/.codex`) that record is the only thing
 * left, and the historical import turns it into the honest floor of events: the lifecycle of one
 * session / run / main agent, plus the token totals it recorded. Nothing finer can be recovered —
 * there are no per-call timestamps, no per-call ids and no tool calls in a computed record — so none
 * is invented.
 *
 * ## The rules
 *
 * - **Confidence (D17).** Every counter is carried VERBATIM from the store: a deterministic reading
 *   of exact inputs, so `exact`. A figure priced from a table would be `estimated` — and the coarse
 *   set carries none: `ModelCompletedData.costUSD` exists only for a cost the SOURCE stated
 *   (event.ts), so a table price has no field to travel in. The projection prices the counters
 *   through `calcCost` and marks THAT result as the table's, exactly as it does for a replayed
 *   event. `coarseConfidence` is the one place the rule is written, so a future priced field cannot
 *   be added without choosing.
 * - **Absent, never 0 (D21).** A counter the store does not hold is absent. Where the harness's
 *   capability for tokens is `partial`, a stored `0` is indistinguishable from "not read" (the
 *   adapter wrote a 0 for a counter it cannot produce — Codex's cache-write, Gemini's append-journal
 *   shape), so a `0` there is absent too; only a `supported` capability makes a `0` a measurement.
 *   A session with no counter left emits no `model.completed` at all.
 * - **No conversation text (D5).** No `title`, no `first_prompt`, no note — only ids, counters,
 *   paths and the model name.
 * - **Ids are DERIVED** (`deriveEventId`) from `import:<harness>:<session_id>` plus the type and an
 *   ordinal, so a re-import re-derives the same ids and the journal's `UNIQUE(event_id)` makes it a
 *   no-op. The entity ids (session / run / main agent) are the HARNESS INTEGRATION's own
 *   (`runIdOf(conversationId)` …), handed in by the caller — which is what lets the import ask the
 *   journal "does this run already hold replayed events?" and refuse to lay a coarse copy over them.
 * - **Timestamps are normalised** to `Date#toISOString()`: the journal stores instants in exactly
 *   that form and rejects anything else as `bad-timestamp`, while the store holds whatever the
 *   adapter wrote (`…Z` without milliseconds, an epoch number repaired to a string). A record with no
 *   parseable start has nothing to order its events by and is REFUSED, by reason.
 */
import {
  CANONICAL_EVENT_SCHEMA,
  deriveEventId,
  resolveProvider,
  type AgentisticsEvent,
  type CapabilityState,
  type Confidence,
  type EventData,
  type EventType,
  type HarnessId,
  type ModelUsageCounters,
  type SessionMeta,
} from '@agentistics/core'

/** `adapterVersion` on every coarse event. Bump it when the mapping below changes.
 *  1.0.0 — first version: lifecycle + one `model.completed` per model. */
export const IMPORT_STORE_ADAPTER_VERSION = '1.0.0'

/** `source.id` on every coarse event — how the import's own rows are told apart in the journal. */
export const IMPORT_STORE_SOURCE_ID = 'agentistics-import'

/** The entity-id derivations of one harness integration (its `replay-core.ts` exports). */
export interface HarnessEntityIds {
  sessionIdOf(conversationId: string): string
  runIdOf(conversationId: string): string
  mainAgentIdOf(conversationId: string): string
}

export interface StoreEventContext {
  harness: HarnessId
  ids: HarnessEntityIds
  /** The harness's canonical tokens capability — decides whether a stored 0 is a measurement. */
  tokens: CapabilityState
  /** Re-readable: the store file, relative to the store root (`claude/<id>.json`). */
  sourceRef: string
  /** `recordedAt` on every event — the caller's clock, so the mapping stays pure. */
  recordedAt: string
}

export type StoreEventFailure = 'no-session-id' | 'no-timestamps'

export type StoreEventResult =
  | { ok: true; events: AgentisticsEvent[]; runId: string; start: string }
  | { ok: false; reason: StoreEventFailure }

/** D17, written once. `counter` = copied from the store; `priced` = computed from a price table. */
export function coarseConfidence(kind: 'counter' | 'priced'): Confidence {
  return kind === 'counter' ? 'exact' : 'estimated'
}

/** An instant in the journal's normalised form, or `null` when the value names no instant. */
export function normaliseInstant(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString()
  if (typeof v !== 'string' || v.trim() === '') return null
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** A stored counter as the event will carry it — `undefined` = absent (D21). */
export function storedCounter(v: unknown, tokens: CapabilityState): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined
  if (tokens.state === 'supported') return v
  if (tokens.state === 'partial') return v > 0 ? v : undefined
  return undefined
}

function usageOf(
  u: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown },
  tokens: CapabilityState,
): ModelUsageCounters {
  const out: ModelUsageCounters = {}
  const input = storedCounter(u.input, tokens)
  const output = storedCounter(u.output, tokens)
  const cacheRead = storedCounter(u.cacheRead, tokens)
  const cacheWrite = storedCounter(u.cacheWrite, tokens)
  if (input !== undefined) out.input = input
  if (output !== undefined) out.output = output
  if (cacheRead !== undefined) out.cacheRead = cacheRead
  if (cacheWrite !== undefined) out.cacheWrite = cacheWrite
  return out
}

/** The per-model usage the record states: `model_usage` when present, else one row for `model`. */
function modelRows(meta: SessionMeta, tokens: CapabilityState): { model: string; usage: ModelUsageCounters }[] {
  const rows: { model: string; usage: ModelUsageCounters }[] = []
  const mu = meta.model_usage
  if (mu && typeof mu === 'object' && Object.keys(mu).length > 0) {
    for (const model of Object.keys(mu).sort()) {
      const u = mu[model] as unknown as Record<string, unknown> | undefined
      if (!u) continue
      rows.push({
        model,
        usage: usageOf({
          input: u.inputTokens, output: u.outputTokens,
          cacheRead: u.cacheReadInputTokens, cacheWrite: u.cacheCreationInputTokens,
        }, tokens),
      })
    }
  } else {
    rows.push({
      model: typeof meta.model === 'string' ? meta.model : '',
      usage: usageOf({
        input: meta.input_tokens, output: meta.output_tokens,
        cacheRead: meta.cache_read_input_tokens, cacheWrite: meta.cache_creation_input_tokens,
      }, tokens),
    })
  }
  return rows.filter(r => Object.keys(r.usage).length > 0)
}

/**
 * The coarse event set for one stored session. Total: a record it cannot order is a named refusal.
 * Order of emission: session.started, run.started, agent.started, model.completed…, agent.ended,
 * run.ended, session.ended.
 */
export function storeSessionEvents(meta: SessionMeta, ctx: StoreEventContext): StoreEventResult {
  const conversationId = typeof meta.session_id === 'string' ? meta.session_id : ''
  if (conversationId === '') return { ok: false, reason: 'no-session-id' }
  const start = normaliseInstant(meta.start_time)
  if (start === null) return { ok: false, reason: 'no-timestamps' }
  const endRaw = normaliseInstant(meta.end_time)
  // A stored end before the start is not an end: fall back to the start rather than order an event
  // before the thing it closes.
  const end = endRaw !== null && endRaw >= start ? endRaw : start

  const sessionId = ctx.ids.sessionIdOf(conversationId)
  const runId = ctx.ids.runIdOf(conversationId)
  const agentId = ctx.ids.mainAgentIdOf(conversationId)
  const idRef = `import:${ctx.harness}:${conversationId}`
  const exact = coarseConfidence('counter')
  const events: AgentisticsEvent[] = []

  function push<T extends EventType>(type: T, occurredAt: string, data: EventData[T], ordinal: number, withAgent: boolean): void {
    const e: AgentisticsEvent<T> = {
      eventId: deriveEventId({ sourceKind: 'adapter', sourceId: IMPORT_STORE_SOURCE_ID, sourceRef: idRef, type, ordinal }),
      schema: CANONICAL_EVENT_SCHEMA,
      type,
      occurredAt,
      recordedAt: ctx.recordedAt,
      sessionId,
      runId,
      source: { kind: 'adapter', id: IMPORT_STORE_SOURCE_ID, version: IMPORT_STORE_ADAPTER_VERSION },
      provenance: { mode: 'replayed', confidence: exact, adapterVersion: IMPORT_STORE_ADAPTER_VERSION, sourceRef: ctx.sourceRef },
      data,
    }
    if (withAgent) e.agentId = agentId
    events.push(e as AgentisticsEvent)
  }

  const projectPath = typeof meta.project_path === 'string' && meta.project_path !== '' ? meta.project_path : undefined
  const cwd = typeof meta.current_cwd === 'string' && meta.current_cwd !== '' ? meta.current_cwd : projectPath
  const sessionData: EventData['session.started'] = { origin: 'imported' }
  if (projectPath !== undefined) sessionData.projectPath = projectPath
  if (typeof meta.git_remote === 'string') sessionData.repoKey = meta.git_remote
  push('session.started', start, sessionData, 0, false)

  const runData: EventData['run.started'] = { harness: ctx.harness, conversationId, conversationLink: 'observed' }
  if (cwd !== undefined) runData.cwd = cwd
  push('run.started', start, runData, 0, false)

  const agentData: EventData['agent.started'] = { kind: 'main' }
  if (typeof meta.model === 'string' && meta.model !== '') agentData.model = meta.model
  push('agent.started', start, agentData, 0, true)

  const rows = modelRows(meta, ctx.tokens)
  rows.forEach((row, i) => {
    const data: EventData['model.completed'] = {
      provider: resolveProvider(row.model).id,
      model: row.model,
      usage: row.usage,
      status: 'completed',
    }
    // The context gauge is the LAST turn's; it belongs to the session's own model, and only there.
    if (row.model !== '' && row.model === meta.model) {
      if (typeof meta.context_tokens === 'number' && meta.context_tokens > 0) data.contextTokens = meta.context_tokens
      if (typeof meta.context_window === 'number' && meta.context_window > 0) data.contextWindow = meta.context_window
    }
    push('model.completed', end, data, i, true)
  })

  push('agent.ended', end, { status: 'completed' }, 0, true)
  push('run.ended', end, { status: 'completed' }, 0, false)
  push('session.ended', end, {}, 0, false)
  return { ok: true, events, runId, start }
}
