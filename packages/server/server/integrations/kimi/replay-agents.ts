/**
 * integrations/kimi/replay-agents.ts — PURE. The Session, the Run, and one Agent per kimi agent id
 * (`state.json`'s own `agents` map, or `['main']` when it is absent — `kimiAgentIds()`, reused
 * verbatim from `adapters/kimi-parse.ts`).
 *
 * ## The improvement (P2 §2)
 * Legacy folds every agent's wire into ONE flat set of session totals with no per-agent breakdown
 * at all — `adapters/kimi.ts`'s `loadSessions` calls `accumulateKimiWire(text, totals, ...)` once
 * PER AGENT into the SAME `totals` accumulator. This replay instead gives every agent id its OWN
 * `Agent` entity — its own `agent.started`/`agent.ended`, and (via `replay-model.ts`/
 * `replay-tools.ts`) every model/tool event tagged with ITS OWN `agentId` — real per-agent
 * granularity the legacy `SessionMeta` shape has no column for.
 *
 * ## Why `main` is `kind: 'main'` and every OTHER agent id is `kind: 'subagent'`
 * `state.json`'s own `agents` map already states this: `main` carries no `parentAgentId` (or an
 * explicit `null` one); every other entry names its `parentAgentId` (`adapters/kimi-parse.ts`'s own
 * `KimiState` doc comment: "`main` has a null parent; subagents point at their parent"). That is the
 * honest entity model, and it is what makes the SESSION-LEVEL fields free: `projections/
 * session-meta.ts`'s shared rollup treats only `kind: 'main'` agents as contributing to
 * `input_tokens`/`tool_counts`/etc, exactly as it does for Claude, while a `kind: 'subagent'`
 * agent's own figures roll into `agentMetrics` instead.
 *
 * **Measured limit, stated rather than assumed away**: all 16 real kimi sessions on this machine
 * carry exactly one agent (`main`), so this integration's real-store differential never exercises
 * the multi-agent case. A session with a genuine subagent would show legacy's flat session-level
 * total EXCEEDING this replay's (main-only) one by precisely the subagent's own tokens — a real,
 * provable divergence between the two AGGREGATION SCOPES, not a bug, and not silently forced equal
 * by mislabelling a subagent as `main`. See this integration's handback for the synthetic fixture
 * that exercises it and the exact reconciliation.
 *
 * ## No turn events (yet)
 * See `replay.ts`'s header — `turn.started`/`turn.ended` are not emitted by this adapter version.
 */
import type { AgentEndedData, AgentStartedData, RunEndedData, RunStartedData, SessionStartedData } from '@agentistics/core'
import { kimiAgentIds, type KimiState } from '../../adapters/kimi-parse'
import { agentContext, lineRef, makeEvent, stateRef, type EmitEvent, type KimiReplayContext } from './replay-core'

export { kimiAgentIds }

/** `main` has no parent; every other kimi agent id is a subagent. */
export function agentKindOf(kimiAgentId: string): 'main' | 'subagent' {
  return kimiAgentId === 'main' ? 'main' : 'subagent'
}

/** The kimi agent id THIS agent's `parentAgentId` names — `state.agents[id].parentAgentId` when
 *  present and non-null, `main` otherwise (the only sensible default: every subagent seen so far on
 *  this integration's real store belongs to a session whose only OTHER agent is `main`). */
export function parentAgentIdOf(state: KimiState | null, kimiAgentId: string): string {
  if (kimiAgentId === 'main') return 'main'
  const p = state?.agents?.[kimiAgentId]?.parentAgentId
  return typeof p === 'string' && p ? p : 'main'
}

export interface SessionBounds {
  /** ISO instant. The primary source (`state.json`'s `createdAt`/`updatedAt`) when present; a
   *  wire-derived fallback otherwise (`index.ts`'s IO half decides which). */
  at: string
  exact: boolean
}

/**
 * The Session, the Run, and one Agent per id — emitted on EVERY replay call, unconditionally. Safe:
 * every id (`sessionIdOf`/`runIdOf`/`agentIdOf`) is deterministic, so a repeat is the SAME event,
 * deduped by the journal's `UNIQUE(event_id)` — the property `deriveEventId` exists for. This
 * mirrors P1's own rule that a cold re-derivation of a fact is never a correctness fallback, only an
 * optimisation this integration does not bother making (state.json is cheap to re-read).
 */
export function lifecycleStartEvents(
  kimiSessionId: string, state: KimiState | null, agentIds: readonly string[],
  bounds: SessionBounds, cwd: string | undefined, recordedAt: string, emit: EmitEvent,
): void {
  const mainCtx = agentContext(kimiSessionId, 'main', recordedAt)
  const confidence = bounds.exact ? 'exact' as const : 'estimated' as const
  const sourceRef = stateRef(kimiSessionId)

  const startedData: SessionStartedData = { origin: 'adapter' }
  if (state?.title) startedData.title = state.title
  if (cwd) startedData.projectPath = cwd
  emit(makeEvent(mainCtx, 'session.started', startedData, {
    sourceRef, occurredAt: bounds.at, confidence, agentId: null,
  }))

  const runData: RunStartedData = { harness: 'kimi', conversationId: kimiSessionId, conversationLink: 'observed' }
  if (cwd) runData.cwd = cwd
  emit(makeEvent(mainCtx, 'run.started', runData, {
    sourceRef, occurredAt: bounds.at, confidence, agentId: null,
  }))

  for (const agentId of agentIds) {
    const ctx = agentContext(kimiSessionId, agentId, recordedAt)
    const kind = agentKindOf(agentId)
    const data: AgentStartedData = { kind }
    if (kind === 'subagent') {
      const parentKimiId = parentAgentIdOf(state, agentId)
      data.parentAgentId = agentContext(kimiSessionId, parentKimiId, recordedAt).agentId
    }
    emit(makeEvent(ctx, 'agent.started', data, {
      sourceRef: lineRef(ctx, 0), occurredAt: bounds.at, confidence,
    }))
  }
}

/** The end half — called only once the session is judged SETTLED (see `index.ts`). */
export function lifecycleEndEvents(
  kimiSessionId: string, agentIds: readonly string[], bounds: SessionBounds, recordedAt: string, emit: EmitEvent,
): void {
  const mainCtx = agentContext(kimiSessionId, 'main', recordedAt)
  const confidence = bounds.exact ? 'exact' as const : 'estimated' as const
  const sourceRef = stateRef(kimiSessionId)

  emit(makeEvent(mainCtx, 'session.ended', {}, { sourceRef, occurredAt: bounds.at, confidence, agentId: null }))
  const runEnded: RunEndedData = { status: 'completed' }
  emit(makeEvent(mainCtx, 'run.ended', runEnded, { sourceRef, occurredAt: bounds.at, confidence, agentId: null }))
  for (const agentId of agentIds) {
    const ctx = agentContext(kimiSessionId, agentId, recordedAt)
    const data: AgentEndedData = { status: 'completed' }
    emit(makeEvent(ctx, 'agent.ended', data, { sourceRef: lineRef(ctx, 0), occurredAt: bounds.at, confidence }))
  }
}
