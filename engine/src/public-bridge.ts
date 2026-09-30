/**
 * public-bridge.ts — TRANSITIONAL. The ONE production file in this repository that imports the
 * public server tree.
 *
 * Spec §6: the engine may import `@agentistics/core` and `@agentistics/engine-api` and NOTHING
 * ELSE from the public tree; everything else arrives as VALUES in `host.readers: ReuseSurface`.
 * Contract 1.1 declares `ReuseSurface` EMPTY ("members join as the integrations move") and the
 * public host passes `readers: {}`, so until the public side grows it (engine-api 1.2 + the host
 * building the value — step 4 of the migration) this file builds the very same functions from the
 * public checkout the engine is linked against. `reuse.ts` prefers `host.readers` whenever the
 * host offers every member, and this file is deleted the day it always does.
 *
 * `BRIDGE`'s TYPE is the proposal for engine-api 1.2's `ReuseSurface`: exactly these members,
 * nothing more. `reuse-surface.lint.test.ts` holds every other file to the §6 rule.
 */
import * as AdaptersAntigravityMod from '@agentistics/server/server/adapters/antigravity'
import * as AdaptersAntigravityParseMod from '@agentistics/server/server/adapters/antigravity-parse'
export type { AntigravityConversationSummary, AntigravityHistoryEntry } from '@agentistics/server/server/adapters/antigravity-parse'
import * as AdaptersAntigravityProtobufMod from '@agentistics/server/server/adapters/antigravity-protobuf'
import * as AdaptersGeminiParseMod from '@agentistics/server/server/adapters/gemini-parse'
import * as AdaptersKimiParseMod from '@agentistics/server/server/adapters/kimi-parse'
export type { KimiState } from '@agentistics/server/server/adapters/kimi-parse'
import * as AgentMetricsMod from '@agentistics/server/server/agent-metrics'
export type { AgentMetricsState } from '@agentistics/server/server/agent-metrics'
import * as EditLinesMod from '@agentistics/server/server/edit-lines'
export type { EditDelta } from '@agentistics/server/server/edit-lines'
import * as HarnessActivityMod from '@agentistics/server/server/harness-activity'
import * as JsonlMod from '@agentistics/server/server/jsonl'
import * as SessionsShellWritesMod from '@agentistics/server/server/sessions/shell-writes'
import * as SessionsTranscriptPathMemoMod from '@agentistics/server/server/sessions/transcript-path-memo'
export type { TranscriptPathMemo } from '@agentistics/server/server/sessions/transcript-path-memo'
import * as SubagentJoinMod from '@agentistics/server/server/subagent-join'
export type { AgentEntry } from '@agentistics/server/server/subagent-join'
import * as TranscriptCursorMod from '@agentistics/server/server/transcript-cursor'
export type { TranscriptCursor, TranscriptStat } from '@agentistics/server/server/transcript-cursor'
import * as TranscriptStateMod from '@agentistics/server/server/transcript-state'
import * as UtilsMod from '@agentistics/server/server/utils'
import * as CliUiMod from '@agentistics/server/server/cli-ui'
import * as CorsMod from '@agentistics/server/server/cors'
import { ALLOWED_ORIGINS } from '@agentistics/server/server/config'

/**
 * CONTRACT GAP, carried here until the contract has a member for it: `provider-web.ts` runs a
 * browser-provenance check STRICTER than the host's CSRF gate (`same-site` refused), and that check
 * needs the host's origin allowlist and whether it runs as a dev server. `EngineHostServices` names
 * neither. Proposal: `EngineHostServices.originPolicy(): { allowedOrigins: string[]; dev: boolean }`
 * (a minor bump). The values below are exactly what `engine/in-tree.ts` passes today.
 */
function originPolicy(): { allowedOrigins: string[]; dev: boolean } {
  return { allowedOrigins: [...ALLOWED_ORIGINS], dev: process.env.SERVE_STATIC !== '1' }
}

export const BRIDGE = {
  // adapters/antigravity
  toSqliteUriPath: AdaptersAntigravityMod.toSqliteUriPath,
  // adapters/antigravity-parse
  REPLAY_TYPES: AdaptersAntigravityParseMod.REPLAY_TYPES,
  extractUserRequest: AdaptersAntigravityParseMod.extractUserRequest,
  isSlashCommandPrompt: AdaptersAntigravityParseMod.isSlashCommandPrompt,
  EDIT_TOOLS: AdaptersAntigravityParseMod.EDIT_TOOLS,
  FILE_URI_RE: AdaptersAntigravityParseMod.FILE_URI_RE,
  collectSubagentChildIds: AdaptersAntigravityParseMod.collectSubagentChildIds,
  countLines: AdaptersAntigravityParseMod.countLines,
  fileUriToPath: AdaptersAntigravityParseMod.fileUriToPath,
  buildAntigravityParentMap: AdaptersAntigravityParseMod.buildAntigravityParentMap,
  buildAntigravityWorkspaceMap: AdaptersAntigravityParseMod.buildAntigravityWorkspaceMap,
  firstHistoryPrompt: AdaptersAntigravityParseMod.firstHistoryPrompt,
  parseAntigravityHistory: AdaptersAntigravityParseMod.parseAntigravityHistory,
  // adapters/antigravity-protobuf
  parseGenMetadataBlob: AdaptersAntigravityProtobufMod.parseGenMetadataBlob,
  // adapters/gemini-parse
  extractMessageText: AdaptersGeminiParseMod.extractMessageText,
  isGenuineUserMessage: AdaptersGeminiParseMod.isGenuineUserMessage,
  // adapters/kimi-parse
  kimiAgentIds: AdaptersKimiParseMod.kimiAgentIds,
  parseKimiState: AdaptersKimiParseMod.parseKimiState,
  isToolError: AdaptersKimiParseMod.isToolError,
  stripProvider: AdaptersKimiParseMod.stripProvider,
  isoFromKimiTime: AdaptersKimiParseMod.isoFromKimiTime,
  // agent-metrics
  emptyAgentMetrics: AgentMetricsMod.emptyAgentMetrics,
  finishAgentMetrics: AgentMetricsMod.finishAgentMetrics,
  foldAgentEntry: AgentMetricsMod.foldAgentEntry,
  // edit-lines
  editDelta: EditLinesMod.editDelta,
  // harness-activity
  canonicalTool: HarnessActivityMod.canonicalTool,
  // jsonl
  iterLines: JsonlMod.iterLines,
  isHumanUserEntry: JsonlMod.isHumanUserEntry,
  contextOfUsage: JsonlMod.contextOfUsage,
  // sessions/shell-writes
  commandSummary: SessionsShellWritesMod.commandSummary,
  // sessions/transcript-path-memo
  createTranscriptPathMemo: SessionsTranscriptPathMemoMod.createTranscriptPathMemo,
  resolveMemoizedPath: SessionsTranscriptPathMemoMod.resolveMemoizedPath,
  // subagent-join
  describedFrom: SubagentJoinMod.describedFrom,
  isNestedAgent: SubagentJoinMod.isNestedAgent,
  parseAgentMeta: SubagentJoinMod.parseAgentMeta,
  planAgentJoin: SubagentJoinMod.planAgentJoin,
  // transcript-cursor
  anchorHex: TranscriptCursorMod.anchorHex,
  consumedEnd: TranscriptCursorMod.consumedEnd,
  cursorFrom: TranscriptCursorMod.cursorFrom,
  evictTranscriptStates: TranscriptCursorMod.evictTranscriptStates,
  planTranscriptRead: TranscriptCursorMod.planTranscriptRead,
  // transcript-state
  MAX_STATES: TranscriptStateMod.MAX_STATES,
  STATE_TTL_MS: TranscriptStateMod.STATE_TTL_MS,
  // utils
  safeReadDir: UtilsMod.safeReadDir,
  safeReadJson: UtilsMod.safeReadJson,
  // cli-ui
  confirm: CliUiMod.confirm,
  maskedInput: CliUiMod.maskedInput,
  // cors
  originAllowed: CorsMod.originAllowed,
  // host policy (contract gap — see originPolicy above)
  originPolicy,
}

export type ReuseReaders = typeof BRIDGE
