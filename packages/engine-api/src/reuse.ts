/**
 * reuse.ts — the public functions an engine reuses, and the types they name (contract 1.2).
 *
 * An engine never deep-imports the public tree: the host builds these as VALUES
 * (`packages/server/server/engine/reuse-surface.ts`) and hands them over in
 * `EngineHostServices.readers`. This package may import no platform package, so every type a member
 * names is RE-DECLARED here structurally, under the host's own name; the host proves each still
 * agrees — and that its real functions are assignable to these members — in
 * `packages/server/server/engine/engine-api-mirrors.test.ts`, so a public refactor that changes a
 * signature fails the public build where it happens.
 *
 * Growing the surface is a minor bump; changing or removing a member is a major one. The member
 * list is exactly what the engine's integrations, its provider verb and its provider route use —
 * nothing is here "in case".
 */
import type { HarnessId } from './mirrors'

// ── antigravity ──────────────────────────────────────────────────────────────────────────────────

/** Mirrors `adapters/antigravity-parse.ts` — one line of agy's global `history.jsonl`. */
export interface AntigravityHistoryEntry {
  display: string
  timestamp: number
  workspace: string
  conversationId?: string
  isSlashCommand: boolean
}

/** Mirrors `adapters/antigravity-parse.ts` — a `conversation_summaries.db` row. */
export interface AntigravityConversationSummary {
  conversation_id: string
  parent_conversation_id?: string
  nesting_depth?: number
  title?: string
  preview?: string
  workspace_uris?: string
}

/** Mirrors `adapters/antigravity-protobuf.ts` — one decoded `gen_metadata` blob. */
export interface GenMetadata {
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  thinkingTokens: number
  completionTokens: number
  systemInstructionTokens: number
  contextTokens: number
  contextWindow: number
  modelId: string
  modelDisplay: string
}

// ── kimi ─────────────────────────────────────────────────────────────────────────────────────────

/** Mirrors `adapters/kimi-parse.ts` — a session's `state.json`. */
export interface KimiState {
  title?: string
  workDir?: string
  createdAt?: string | number
  updatedAt?: string | number
  agents?: Record<string, { parentAgentId?: string | null } | undefined>
}

// ── agent metrics ────────────────────────────────────────────────────────────────────────────────

/** Mirrors core's `AgentInvocation` — must stay EQUAL. */
export interface EngineAgentInvocation {
  toolUseId: string
  agentId?: string
  agentType: string
  description: string
  status: 'completed' | 'failed'
  unmeasured?: true
  totalTokens: number
  totalDurationMs: number
  totalToolUseCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  toolStats: {
    readCount: number
    searchCount: number
    bashCount: number
    editFileCount: number
    linesAdded: number
    linesRemoved: number
    otherToolCount: number
  }
  costUSD: number
}

/** Mirrors core's `SessionAgentMetrics` — must stay EQUAL. */
export interface EngineSessionAgentMetrics {
  invocations: EngineAgentInvocation[]
  totalInvocations: number
  unmeasuredInvocations?: number
  totalTokens: number
  totalDurationMs: number
  totalCostUSD: number
}

/** Mirrors `agent-metrics.ts`'s private launch record (the values of `pendingAgents`). */
export interface AgentToolUseRecord {
  id: string
  input: {
    description?: string
    subagent_type?: string
    prompt?: string
  }
}

/** Mirrors `agent-metrics.ts` — the resumable agent-metrics walk. */
export interface AgentMetricsState {
  pendingAgents: Map<string, AgentToolUseRecord>
  invocations: EngineAgentInvocation[]
  recordedAgentIds: Set<string>
}

/** Mirrors `subagent-join.ts` — an `agent-<id>.meta.json`. */
export interface AgentMeta {
  agentType?: string
  description?: string
  toolUseId?: string
  parentAgentId?: string
  spawnDepth?: number
  isFork?: boolean
  name?: string
  model?: string
}

/** Mirrors `subagent-join.ts`. */
export interface AgentEntry {
  agentId: string
  meta: AgentMeta | null
}

/** Mirrors `subagent-join.ts`. */
export interface AgentJoinPlan {
  reads: { invocation: EngineAgentInvocation; agentId: string | null }[]
  unclaimed: AgentEntry[]
}

// ── edits ────────────────────────────────────────────────────────────────────────────────────────

/** Mirrors `edit-lines.ts`. */
export interface EditDelta {
  added: number
  removed: number
}

// ── transcript path memo ─────────────────────────────────────────────────────────────────────────

/** Mirrors `sessions/transcript-path-memo.ts`. */
export interface TranscriptPathMemo {
  get(id: string): string | undefined
  remember(id: string, path: string): void
  forget(id: string): void
  missed(id: string, now: number): void
  mayScan(id: string, now: number): boolean
  clear(): void
}

/** Mirrors `sessions/transcript-path-memo.ts`. */
export type PathExists = (path: string) => Promise<boolean>

/** Mirrors `sessions/transcript-path-memo.ts`. */
export interface MemoizedResolve {
  exists: PathExists
  direct?: () => Promise<string | null>
  scan: () => Promise<string | null>
  now: number
}

// ── transcript cursor ────────────────────────────────────────────────────────────────────────────

/** Mirrors `transcript-cursor.ts`. */
export interface TranscriptCursor {
  offset: number
  size: number
  mtimeMs: number
  anchor: string
  anchorBytes: number
}

/** Mirrors `transcript-cursor.ts`. */
export interface TranscriptStat {
  size: number
  mtimeMs: number
}

/** Mirrors `transcript-cursor.ts`. */
export type RereadReason = 'no-cursor' | 'shrank' | 'rewritten' | 'anchor-mismatch'

/** Mirrors `transcript-cursor.ts`. */
export type TranscriptReadPlan =
  | { mode: 'unchanged' }
  | { mode: 'full'; reason: RereadReason }
  | { mode: 'append'; readFrom: number; verifyBytes: number; lineFrom: number; to: number }

/** Mirrors `transcript-cursor.ts`. */
export interface CursorUse {
  usedMs: number
}

// ── the surface ──────────────────────────────────────────────────────────────────────────────────

/**
 * The 48 public functions and constants an engine reuses, grouped by the host module that owns
 * each. A host offers ALL of them or the engine refuses the surface whole: mixing two builds of one
 * parser family is two answers to one question.
 */
export interface ReuseSurface {
  // adapters/antigravity
  toSqliteUriPath: (file: string) => string
  // adapters/antigravity-parse
  REPLAY_TYPES: Set<string>
  extractUserRequest: (content: string) => string
  isSlashCommandPrompt: (text: string) => boolean
  EDIT_TOOLS: Set<string>
  FILE_URI_RE: RegExp
  collectSubagentChildIds: (transcript: string) => string[]
  countLines: (text: unknown) => number
  fileUriToPath: (uri: string) => string
  buildAntigravityParentMap: (
    transcripts: Iterable<readonly [string, string]>,
    summaries?: readonly AntigravityConversationSummary[],
  ) => Map<string, string>
  buildAntigravityWorkspaceMap: (entries: AntigravityHistoryEntry[]) => Map<string, string>
  firstHistoryPrompt: (entries: AntigravityHistoryEntry[], conversationId: string) => string
  parseAntigravityHistory: (content: string) => AntigravityHistoryEntry[]
  // adapters/antigravity-protobuf
  parseGenMetadataBlob: (data: Uint8Array | null | undefined) => GenMetadata | null
  // adapters/gemini-parse
  extractMessageText: (msg: any) => string
  isGenuineUserMessage: (text: string) => boolean
  // adapters/kimi-parse
  kimiAgentIds: (state: KimiState | null) => string[]
  parseKimiState: (text: string) => KimiState | null
  isToolError: (ev: Record<string, unknown>) => boolean
  stripProvider: (model: string) => string
  isoFromKimiTime: (v: string | number | undefined) => string
  // agent-metrics
  emptyAgentMetrics: () => AgentMetricsState
  finishAgentMetrics: (state: AgentMetricsState, modelId: string) => EngineSessionAgentMetrics
  foldAgentEntry: (state: AgentMetricsState, e: Record<string, unknown>) => void
  // edit-lines
  editDelta: (tool: string, input: unknown) => EditDelta
  // harness-activity
  canonicalTool: (harness: HarnessId, name: string) => string
  // jsonl
  iterLines: (content: string) => Generator<string>
  isHumanUserEntry: (e: Record<string, unknown>) => boolean
  contextOfUsage: (u: Record<string, number> | undefined) => number
  // sessions/shell-writes
  commandSummary: (command: string) => string
  // sessions/transcript-path-memo
  createTranscriptPathMemo: (ttlMs?: number) => TranscriptPathMemo
  resolveMemoizedPath: (memo: TranscriptPathMemo, id: string, o: MemoizedResolve) => Promise<string | null>
  // subagent-join
  describedFrom: (invocation: EngineAgentInvocation, meta: AgentMeta | null) => EngineAgentInvocation
  isNestedAgent: (meta: AgentMeta | null) => boolean
  parseAgentMeta: (text: string) => AgentMeta | null
  planAgentJoin: (invocations: readonly EngineAgentInvocation[], entries: readonly AgentEntry[]) => AgentJoinPlan
  // transcript-cursor
  anchorHex: (chunk: Uint8Array) => string
  consumedEnd: (chunk: Uint8Array) => number
  cursorFrom: (buf: Uint8Array, bufEnd: number, offset: number, stat: TranscriptStat) => TranscriptCursor
  evictTranscriptStates: (
    entries: Iterable<readonly [string, CursorUse]>,
    now: number,
    opts: { ttlMs: number; max: number },
  ) => string[]
  planTranscriptRead: (prev: TranscriptCursor | null | undefined, stat: TranscriptStat) => TranscriptReadPlan
  // transcript-state
  MAX_STATES: number
  STATE_TTL_MS: number
  // utils
  safeReadDir: (dirPath: string) => Promise<string[]>
  safeReadJson: <T>(filePath: string) => Promise<T | null>
  // cli-ui
  confirm: (message: string, initial?: boolean) => Promise<boolean>
  maskedInput: (message: string) => Promise<string>
  // cors
  originAllowed: (origin: string | null, allowlist: string[], dev: boolean) => boolean
}

/** Every member name, in declaration order — what an engine checks a host's surface against. */
export const REUSE_SURFACE_MEMBERS = [
  'toSqliteUriPath',
  'REPLAY_TYPES', 'extractUserRequest', 'isSlashCommandPrompt', 'EDIT_TOOLS', 'FILE_URI_RE',
  'collectSubagentChildIds', 'countLines', 'fileUriToPath', 'buildAntigravityParentMap',
  'buildAntigravityWorkspaceMap', 'firstHistoryPrompt', 'parseAntigravityHistory',
  'parseGenMetadataBlob',
  'extractMessageText', 'isGenuineUserMessage',
  'kimiAgentIds', 'parseKimiState', 'isToolError', 'stripProvider', 'isoFromKimiTime',
  'emptyAgentMetrics', 'finishAgentMetrics', 'foldAgentEntry',
  'editDelta',
  'canonicalTool',
  'iterLines', 'isHumanUserEntry', 'contextOfUsage',
  'commandSummary',
  'createTranscriptPathMemo', 'resolveMemoizedPath',
  'describedFrom', 'isNestedAgent', 'parseAgentMeta', 'planAgentJoin',
  'anchorHex', 'consumedEnd', 'cursorFrom', 'evictTranscriptStates', 'planTranscriptRead',
  'MAX_STATES', 'STATE_TTL_MS',
  'safeReadDir', 'safeReadJson',
  'confirm', 'maskedInput',
  'originAllowed',
] as const satisfies readonly (keyof ReuseSurface)[]

/** PURE. The members `offered` lacks — empty means the surface is complete. */
export function missingReuseMembers(offered: object): (keyof ReuseSurface)[] {
  const o = offered as Partial<Record<keyof ReuseSurface, unknown>>
  return REUSE_SURFACE_MEMBERS.filter(k => typeof o[k] === 'undefined')
}
