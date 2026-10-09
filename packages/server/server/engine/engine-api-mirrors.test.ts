/**
 * `@agentistics/engine-api` is Apache-2.0 and may import no platform package, so it RE-DECLARES the
 * few host types its contract names (`mirrors.ts`, `host.ts`). This file is where the host proves
 * the two still agree: every assertion below is checked by `tsc`, so a drift fails the public build
 * at the place it happens. The runtime `it` blocks only keep the file a test.
 */
import { describe, expect, it } from 'bun:test'
import { HARNESS_ORDER, type AgentisticsEvent, type HarnessId, type ProviderId } from '@agentistics/core'
import type { CapabilityState } from '@agentistics/core'
import type {
  CapabilityName,
  EngineCapabilityState,
  EngineEvent,
  EngineHealthIssue,
  HarnessId as ApiHarnessId,
  ProviderId as ApiProviderId,
  ReadJsonLimited,
  SafeError,
  EngineAuditAction,
  EngineAuditEvent,
  EngineAgentInvocation,
  EngineSessionAgentMetrics,
  AntigravityHistoryEntry as ApiAntigravityHistoryEntry,
  AntigravityConversationSummary as ApiAntigravityConversationSummary,
  GenMetadata as ApiGenMetadata,
  KimiState as ApiKimiState,
  AgentMetricsState as ApiAgentMetricsState,
  AgentMeta as ApiAgentMeta,
  AgentEntry as ApiAgentEntry,
  AgentJoinPlan as ApiAgentJoinPlan,
  EditDelta as ApiEditDelta,
  TranscriptPathMemo as ApiTranscriptPathMemo,
  MemoizedResolve as ApiMemoizedResolve,
  TranscriptCursor as ApiTranscriptCursor,
  TranscriptStat as ApiTranscriptStat,
  TranscriptReadPlan as ApiTranscriptReadPlan,
  CursorUse as ApiCursorUse,
  ReuseSurface,
  EngineSessionActivity,
  EngineChatTurn,
  EngineShellRun,
  EngineShellOutput,
} from '@agentistics/engine-api'
import type { SessionActivity } from '../sessions/types'
import type { ChatTurn, ShellOutput, ShellRun } from '@agentistics/core'
import type { HealthIssue } from '@agentistics/core'
import type { Capabilities } from '../exposure'
import type { readJsonLimited } from '../limits'
import type { safeError } from '../errors'
import type { AgentInvocation, SessionAgentMetrics } from '@agentistics/core'
import type { AuditAction, AuditInput } from '../audit'
import type { AntigravityConversationSummary, AntigravityHistoryEntry } from '../adapters/antigravity-parse'
import type { GenMetadata } from '../adapters/antigravity-protobuf'
import type { KimiState } from '../adapters/kimi-parse'
import type { AgentMetricsState } from '../agent-metrics'
import type { AgentEntry, AgentJoinPlan, AgentMeta } from '../subagent-join'
import type { EditDelta } from '../edit-lines'
import type { MemoizedResolve, TranscriptPathMemo } from '../sessions/transcript-path-memo'
import type { CursorUse, TranscriptCursor, TranscriptReadPlan, TranscriptStat } from '../transcript-cursor'
import type { buildReuseSurface } from './reuse-surface'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Assignable<From, To> = [From] extends [To] ? true : false
const ok = <T extends true>(): T => true as T

// Equal unions — a harness, provider or capability added on either side fails here.
ok<Equal<HarnessId, ApiHarnessId>>()
ok<Equal<ProviderId, ApiProviderId>>()
ok<Equal<keyof Capabilities, CapabilityName>>()

// The host's richer types are ASSIGNABLE to the contract's minimal mirrors.
ok<Assignable<AgentisticsEvent, EngineEvent>>()
ok<Assignable<CapabilityState, EngineCapabilityState>>()
ok<Assignable<HealthIssue, EngineHealthIssue>>()
ok<Assignable<typeof readJsonLimited, ReadJsonLimited>>()
ok<Assignable<typeof safeError, SafeError>>()

// 1.2 — the audit action is the host's own union, and an engine event is the host's audit input.
ok<Equal<AuditAction, EngineAuditAction>>()
ok<Assignable<EngineAuditEvent, AuditInput>>()

// 1.2 — every type the reuse surface names is EQUAL to the host's, so an engine reading a member
// sees exactly what the host returns.
ok<Equal<AgentInvocation, EngineAgentInvocation>>()
ok<Equal<SessionAgentMetrics, EngineSessionAgentMetrics>>()
ok<Equal<AntigravityHistoryEntry, ApiAntigravityHistoryEntry>>()
ok<Equal<AntigravityConversationSummary, ApiAntigravityConversationSummary>>()
ok<Equal<GenMetadata, ApiGenMetadata>>()
ok<Equal<KimiState, ApiKimiState>>()
ok<Equal<AgentMetricsState, ApiAgentMetricsState>>()
ok<Equal<AgentMeta, ApiAgentMeta>>()
ok<Equal<AgentEntry, ApiAgentEntry>>()
ok<Equal<AgentJoinPlan, ApiAgentJoinPlan>>()
ok<Equal<EditDelta, ApiEditDelta>>()
ok<Equal<TranscriptPathMemo, ApiTranscriptPathMemo>>()
ok<Equal<MemoizedResolve, ApiMemoizedResolve>>()
ok<Equal<TranscriptCursor, ApiTranscriptCursor>>()
ok<Equal<TranscriptStat, ApiTranscriptStat>>()
ok<Equal<TranscriptReadPlan, ApiTranscriptReadPlan>>()
ok<Equal<CursorUse, ApiCursorUse>>()
// …and the value the host builds IS the contract's surface (`reuse-surface.ts` is typed by it; this
// keeps the claim from depending on that annotation staying there).
ok<Assignable<Awaited<ReturnType<typeof buildReuseSurface>>, ReuseSurface>>()

// 1.4 — a fleet transition's activities are the host's own, word for word.
ok<Equal<SessionActivity, EngineSessionActivity>>()

// 1.9 — the chat channel's turn is core's `ChatTurn`, field for field.
ok<Equal<ChatTurn, EngineChatTurn>>()
ok<Equal<ShellRun, EngineShellRun>>()
ok<Equal<ShellOutput, EngineShellOutput>>()

describe('engine-api mirrors', () => {
  it('lists the same harnesses the host orders', () => {
    const ids: readonly ApiHarnessId[] = HARNESS_ORDER
    expect(ids.length).toBe(HARNESS_ORDER.length)
  })
})
