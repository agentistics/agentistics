/**
 * integrations/claude/replay-agents.ts — PURE. The session, the run, and every agent: when each
 * started and ended, keyed on the entities `replay-core.ts` derives and the fold shape `replay.ts`
 * documents.
 *
 * ## What this module owns, and what it does not
 *
 * A transcript is read TWICE by this integration: once as the MAIN conversation (`role: 'main'`),
 * once per claimed `subagents/agent-<id>.jsonl` (`role: 'subagent'`). Both roles fold through the
 * SAME functions here, because a subagent's own lifecycle (when it started, when it ended) is
 * exactly the same kind of fact as the main conversation's — only WHO opens it differs:
 *
 * - `role: 'main'` opens the Session, the Run and the main Agent, on the first line that carries a
 *   usable timestamp, and folds the parent's own `Agent`/`Skill` launches (`agent-metrics.ts`'s
 *   `AgentMetricsState`) so `launchedInvocations` can hand them to the join.
 * - `role: 'subagent'` opens NOTHING — a subagent's `agent.started` is emitted once, by
 *   `subagentLaunchEvents`, at the moment the join (or a nested transcript's own meta) says it
 *   exists. Folding a subagent transcript only ever CLOSES it (`agent.ended`) and, via
 *   `replay-model.ts`/`replay-tools.ts` in the sibling folds `replay.ts` runs alongside this one,
 *   reports what it did.
 *
 * `subagentLaunchEvents` is deliberately given an already-decided `SubagentLaunch[]`, not the raw
 * `AgentJoinPlan` from `subagent-join.ts` — this module has no import of that file and no opinion on
 * HOW a transcript was matched to an invocation. The caller (`./index.ts`, the IO half) runs
 * `planAgentJoin`, reads each `agent-<id>.meta.json`, and turns the result — the join's `reads` for
 * the conversation's TOP-LEVEL launches, plus every entry whose OWN meta names a `parentAgentId`
 * (a NESTED launch, which `planAgentJoin` deliberately never offers as a candidate to any plan) —
 * into the flat, already-resolved list this module turns into events. That split keeps the PURE
 * question ("given these decided facts, what events do they mean") separate from the IO question
 * ("which files exist, and which transcript answers which launch").
 *
 * ## Ids for a launch nothing measured
 *
 * A CLAIMED launch (the join found `agent-<agentId>.jsonl`) is `subagentIdOf(conversationId,
 * agentId)` — the harness's own name, so it is stable across replays. An UNMEASURED one (no
 * transcript on disk — the async launch the parent never got a numbered answer for, and the join
 * could not pair with anything under `subagents/`) has no harness id to hash, so it is derived from
 * the parent's own `tool_use.id` instead (`fallbackSubagentAgentId`) — stable for the same reason
 * every id in `replay-core.ts` is: the same input hashes to the same id on every replay of the same
 * conversation, so a resumed or re-run replay never mints a second entity for one launch.
 */

import {
  sha256Hex,
  type AgentInvocation,
  type Confidence,
  type Id,
} from '@agentistics/core'
import { emptyAgentMetrics, finishAgentMetrics, foldAgentEntry, type AgentMetricsState } from '../../agent-metrics'
import {
  CLAUDE_SOURCE_ID,
  lineRef,
  makeEvent,
  str,
  subagentIdOf,
  type ClaudeReplayContext,
  type EmitEvent,
} from './replay-core'

/**
 * `'main' | 'subagent'` — kept as a literal here rather than imported from `./replay.ts`, which
 * defines the very same union as `ClaudeTranscriptRole`: `replay.ts` imports THIS module, so an
 * import the other way would be a cycle. Both names mean the same thing; TypeScript's structural
 * typing makes the duplication free.
 */
type Role = 'main' | 'subagent'

/** Where, in the LAUNCHING transcript, a `tool_use` id first appeared. */
interface LaunchSite {
  lineNo: number
  occurredAt: string
}

/**
 * The walk this module keeps between folds — see `replay.ts`'s `ClaudeReplayState` for how it sits
 * beside the model and tool folds. Every field moves only forward, per CLAUDE.md's rule for a walk
 * that must give the same answer whether it is folded in one call or in a hundred uneven ones.
 */
export interface LifecycleFoldState {
  /** The last line folded that carried a usable `timestamp`, 1-based; 0 = none yet. */
  lastLineNo: number
  /**
   * That line's `occurredAt`. `null` means nothing timestamped has been folded — which is also how
   * `finishLifecycleFold` knows a transcript with no timestamped line ever opened anything, so it
   * must close nothing.
   */
  lastOccurredAt: string | null
  /**
   * The `lastLineNo` `*.ended` was already emitted for, or `null` before the first `finish`.
   * `finishLifecycleFold` re-emits only when `lastLineNo` has moved past this — the idempotence a
   * resumed live transcript needs: a second `finish` with nothing new folded since emits nothing,
   * and a `finish` after MORE lines were folded closes again, at the new true end.
   */
  closedThroughLine: number | null
  /**
   * The first `claude-*` model observed on or before the line that opens the main agent —
   * `agent.started.model` (main role only; a subagent's own model is decided by `subagentLaunchEvents`
   * from its meta, never from here).
   */
  openModel?: string
  /** The parent's own `Agent`/`Skill` launches — folded for `role: 'main'` only; see `launchedInvocations`. */
  agents: AgentMetricsState
  /** Every `tool_use.id` seen for an `Agent` or `Skill` block, and where — main role only. */
  launchSites: Map<string, LaunchSite>
  /**
   * Set by the CALLER, never by folding: a subagent's own transcript carries no self-reported
   * failure marker, so whether its `agent.ended` reads `failed` instead of `completed` is a fact
   * the join already knows (`AgentInvocation.status`) before this state's `finish` runs. Read only
   * for `role: 'subagent'`.
   */
  subagentFailed: boolean
}

function cloneAgentMetricsState(a: AgentMetricsState): AgentMetricsState {
  return {
    pendingAgents: new Map(a.pendingAgents),
    invocations: a.invocations.map(inv => ({ ...inv, toolStats: { ...inv.toolStats } })),
    recordedAgentIds: new Set(a.recordedAgentIds),
  }
}

export function emptyLifecycleFold(): LifecycleFoldState {
  return {
    lastLineNo: 0,
    lastOccurredAt: null,
    closedThroughLine: null,
    agents: emptyAgentMetrics(),
    launchSites: new Map(),
    subagentFailed: false,
  }
}

export function cloneLifecycleFold(s: LifecycleFoldState): LifecycleFoldState {
  return {
    lastLineNo: s.lastLineNo,
    lastOccurredAt: s.lastOccurredAt,
    closedThroughLine: s.closedThroughLine,
    ...(s.openModel ? { openModel: s.openModel } : {}),
    agents: cloneAgentMetricsState(s.agents),
    launchSites: new Map(s.launchSites),
    subagentFailed: s.subagentFailed,
  }
}

/** `entry.message.model`, when it is a string and looks like a Claude model id. */
function modelOf(entry: Record<string, unknown>): string | undefined {
  const msg = entry.message as Record<string, unknown> | undefined
  const m = msg?.model
  return typeof m === 'string' && m.startsWith('claude') ? m : undefined
}

/** Record where every `Agent`/`Skill` `tool_use` in this (assistant) line appeared. */
function recordLaunchSites(s: LifecycleFoldState, entry: Record<string, unknown>, site: LaunchSite): void {
  if (entry.type !== 'assistant') return
  const msg = entry.message as Record<string, unknown> | undefined
  if (!Array.isArray(msg?.content)) return
  for (const item of msg!.content as Record<string, unknown>[]) {
    if (item?.type !== 'tool_use') continue
    if (item.name !== 'Agent' && item.name !== 'Skill') continue
    const id = item.id
    if (typeof id === 'string' && id && !s.launchSites.has(id)) s.launchSites.set(id, site)
  }
}

/**
 * Advance over ONE already-parsed entry. See `replay.ts`'s `foldClaudeReplayEntry`, which calls this
 * alongside the model and tool folds.
 */
export function foldLifecycleEntry(
  s: LifecycleFoldState,
  ctx: ClaudeReplayContext,
  role: Role,
  entry: Record<string, unknown>,
  lineNo: number,
  emit: EmitEvent,
): void {
  const occurredAt = str(entry.timestamp)
  if (occurredAt === undefined) return

  const isFirst = s.lastOccurredAt === null

  if (role === 'main') {
    foldAgentEntry(s.agents, entry)
    recordLaunchSites(s, entry, { lineNo, occurredAt })
    if (!s.openModel) {
      const m = modelOf(entry)
      if (m) s.openModel = m
    }
  }

  s.lastLineNo = lineNo
  s.lastOccurredAt = occurredAt

  if (role !== 'main' || !isFirst) return

  const ref = lineRef(ctx, lineNo)
  const cwd = str(entry.cwd)
  const harnessVersion = str(entry.version)
  const base = {
    sourceRef: ref,
    occurredAt,
    confidence: 'exact' as Confidence,
    ...(harnessVersion ? { harnessVersion } : {}),
  }

  emit(makeEvent(ctx, 'session.started', {
    origin: 'adapter',
    ...(cwd ? { projectPath: cwd } : {}),
  }, { ...base, agentId: null }))

  emit(makeEvent(ctx, 'run.started', {
    harness: 'claude',
    ...(harnessVersion ? { harnessVersion } : {}),
    conversationId: ctx.conversationId,
    conversationLink: 'observed',
    ...(cwd ? { cwd } : {}),
  }, { ...base, agentId: null }))

  emit(makeEvent(ctx, 'agent.started', {
    kind: 'main',
    ...(s.openModel ? { model: s.openModel } : {}),
  }, base))
}

/**
 * Emit what only the end of the walk can say — see `replay.ts`'s `FinishOptions`. Idempotent: a
 * second `final: true` call with nothing new folded since emits nothing; a `final: true` call after
 * MORE lines were folded closes again, at the new last line (a resumed conversation ends again).
 */
export function finishLifecycleFold(
  s: LifecycleFoldState,
  ctx: ClaudeReplayContext,
  role: Role,
  final: boolean,
  emit: EmitEvent,
): void {
  if (!final) return
  if (s.lastOccurredAt === null) return
  if (s.closedThroughLine === s.lastLineNo) return

  const base = {
    sourceRef: lineRef(ctx, s.lastLineNo),
    occurredAt: s.lastOccurredAt,
    confidence: 'exact' as Confidence,
  }

  if (role === 'main') {
    emit(makeEvent(ctx, 'agent.ended', { status: 'completed' }, base))
    emit(makeEvent(ctx, 'run.ended', { status: 'completed' }, { ...base, agentId: null }))
    emit(makeEvent(ctx, 'session.ended', {}, { ...base, agentId: null }))
  } else {
    emit(makeEvent(ctx, 'agent.ended', { status: s.subagentFailed ? 'failed' : 'completed' }, base))
  }

  s.closedThroughLine = s.lastLineNo
}

/**
 * The main conversation's own `Agent`/`Skill` launches, seen so far — answered ones AND ones the
 * parent transcript never resolved (a background agent still running at EOF). `state` is read, not
 * mutated: `finishAgentMetrics` already promises this, which is what lets the caller ask again after
 * folding more lines without losing anything.
 *
 * The empty model id costs nothing here: the caller (`./index.ts`) hands this list to
 * `planAgentJoin`, which reads `toolUseId`/`agentId`/`agentType`/`description`, never `costUSD` — so
 * pricing every row at the fallback rate is simply unused work, not a wrong answer reaching anyone.
 */
export function launchedInvocations(s: LifecycleFoldState): AgentInvocation[] {
  return finishAgentMetrics(s.agents, '').invocations
}

/**
 * One subagent, already decided by the caller — the join's pairing for a top-level launch, or a
 * nested entry's own meta naming its `parentAgentId`. Never a fork: an entry `planAgentJoin` leaves
 * in `AgentJoinPlan.unclaimed` has no launch to attribute it to and is never turned into one of
 * these — the caller reports its count itself (`plan.unclaimed.length`), and this module never sees
 * it, which is what "forks produce nothing" means for a fold that is only ever given launches.
 */
export interface SubagentLaunch {
  /**
   * The harness's own `agent-<id>` name, when a transcript exists — absent only for an UNMEASURED
   * top-level launch the join could not pair with anything under `subagents/`.
   */
  agentId: string | null
  /** The agent that launched this one: the main agent, or (nested) the spawning subagent's own id. */
  parentAgentId: Id
  agentType?: string
  description?: string
  /** From the subagent's own `agent-<id>.meta.json` `model` field, when the harness stated it. */
  model?: string
  /** The parent's launch line, when the caller could resolve one (`LifecycleFoldState.launchSites`). */
  launchSite?: LaunchSite
  /** The parent's own `tool_use.id` — required to derive a stable id for an UNMEASURED launch. */
  toolUseId: string
}

/** A stable id for a launch the join could not pair with any transcript. See this module's header. */
export function fallbackSubagentAgentId(conversationId: string, toolUseId: string): Id {
  return `agt_${sha256Hex(
    JSON.stringify(['agentistics.claude-entity/v1-unmeasured', conversationId, toolUseId]),
  ).slice(0, 24)}`
}

/**
 * Turn a decided `SubagentLaunch[]` into `agent.started` (every launch) and `agent.ended` (only the
 * UNMEASURED ones — a claimed launch's real end comes from folding its own transcript with
 * `role: 'subagent'`, which is what `finishLifecycleFold` closes there).
 */
export function subagentLaunchEvents(
  ctx: ClaudeReplayContext,
  plan: readonly SubagentLaunch[],
  emit: EmitEvent,
): void {
  for (const launch of plan) {
    const agentId = launch.agentId
      ? subagentIdOf(ctx.conversationId, launch.agentId)
      : fallbackSubagentAgentId(ctx.conversationId, launch.toolUseId)

    const site = launch.launchSite
    const sourceRef = site
      ? lineRef(ctx, site.lineNo)
      : `${CLAUDE_SOURCE_ID}:${ctx.conversationId}/subagents/${launch.agentId ?? launch.toolUseId}:meta`
    const occurredAt = site?.occurredAt ?? ctx.recordedAt

    const base = { sourceRef, occurredAt, confidence: 'exact' as Confidence }

    emit(makeEvent(ctx, 'agent.started', {
      kind: 'subagent',
      parentAgentId: launch.parentAgentId,
      ...(launch.agentType ? { agentType: launch.agentType } : {}),
      ...(launch.description ? { description: launch.description } : {}),
      ...(launch.model ? { model: launch.model } : {}),
    }, { ...base, agentId }))

    if (!launch.agentId) {
      emit(makeEvent(ctx, 'agent.ended', { status: 'unmeasured' }, { ...base, agentId }))
    }
  }
}
