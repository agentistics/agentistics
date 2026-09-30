/**
 * reuse.ts — the reuse surface (spec §6) as every engine module sees it.
 *
 * The integrations and the provider verb import the public functions they reuse FROM HERE and never
 * from the public tree: one parser, one answer, with the dependency declared in one place. Each name
 * is a live binding (`export let`), so `installReaders` can swap the whole surface to the host's
 * `readers` without any importer changing.
 *
 * WHICH values: the host's, when `host.readers` carries EVERY member (a partial surface is refused
 * whole — mixing two builds of one parser family is two answers to one question); otherwise the
 * transitional `public-bridge.ts`. `readersSource()` says which, and `createEngine` reports it.
 */
import { BRIDGE, type ReuseReaders } from './public-bridge'

export type { ReuseReaders }
export type { AntigravityConversationSummary, AntigravityHistoryEntry, KimiState, AgentMetricsState, EditDelta, TranscriptPathMemo, AgentEntry, TranscriptCursor, TranscriptStat } from './public-bridge'

export let toSqliteUriPath = BRIDGE.toSqliteUriPath
export let REPLAY_TYPES = BRIDGE.REPLAY_TYPES
export let extractUserRequest = BRIDGE.extractUserRequest
export let isSlashCommandPrompt = BRIDGE.isSlashCommandPrompt
export let EDIT_TOOLS = BRIDGE.EDIT_TOOLS
export let FILE_URI_RE = BRIDGE.FILE_URI_RE
export let collectSubagentChildIds = BRIDGE.collectSubagentChildIds
export let countLines = BRIDGE.countLines
export let fileUriToPath = BRIDGE.fileUriToPath
export let buildAntigravityParentMap = BRIDGE.buildAntigravityParentMap
export let buildAntigravityWorkspaceMap = BRIDGE.buildAntigravityWorkspaceMap
export let firstHistoryPrompt = BRIDGE.firstHistoryPrompt
export let parseAntigravityHistory = BRIDGE.parseAntigravityHistory
export let parseGenMetadataBlob = BRIDGE.parseGenMetadataBlob
export let extractMessageText = BRIDGE.extractMessageText
export let isGenuineUserMessage = BRIDGE.isGenuineUserMessage
export let kimiAgentIds = BRIDGE.kimiAgentIds
export let parseKimiState = BRIDGE.parseKimiState
export let isToolError = BRIDGE.isToolError
export let stripProvider = BRIDGE.stripProvider
export let isoFromKimiTime = BRIDGE.isoFromKimiTime
export let emptyAgentMetrics = BRIDGE.emptyAgentMetrics
export let finishAgentMetrics = BRIDGE.finishAgentMetrics
export let foldAgentEntry = BRIDGE.foldAgentEntry
export let editDelta = BRIDGE.editDelta
export let canonicalTool = BRIDGE.canonicalTool
export let iterLines = BRIDGE.iterLines
export let isHumanUserEntry = BRIDGE.isHumanUserEntry
export let contextOfUsage = BRIDGE.contextOfUsage
export let commandSummary = BRIDGE.commandSummary
export let createTranscriptPathMemo = BRIDGE.createTranscriptPathMemo
export let resolveMemoizedPath = BRIDGE.resolveMemoizedPath
export let describedFrom = BRIDGE.describedFrom
export let isNestedAgent = BRIDGE.isNestedAgent
export let parseAgentMeta = BRIDGE.parseAgentMeta
export let planAgentJoin = BRIDGE.planAgentJoin
export let anchorHex = BRIDGE.anchorHex
export let consumedEnd = BRIDGE.consumedEnd
export let cursorFrom = BRIDGE.cursorFrom
export let evictTranscriptStates = BRIDGE.evictTranscriptStates
export let planTranscriptRead = BRIDGE.planTranscriptRead
export let MAX_STATES = BRIDGE.MAX_STATES
export let STATE_TTL_MS = BRIDGE.STATE_TTL_MS
export let safeReadDir = BRIDGE.safeReadDir
export let safeReadJson = BRIDGE.safeReadJson
export let confirm = BRIDGE.confirm
export let maskedInput = BRIDGE.maskedInput
export let originAllowed = BRIDGE.originAllowed
export let originPolicy = BRIDGE.originPolicy

/** Every member the engine reuses — the list `installReaders` checks a host surface against. */
export const READER_NAMES = Object.keys(BRIDGE) as (keyof ReuseReaders)[]

let source: 'host' | 'bridge' = 'bridge'

export function readersSource(): 'host' | 'bridge' {
  return source
}

/** PURE. The members `offered` lacks — empty means the host's surface is complete. */
export function missingReaders(offered: object): (keyof ReuseReaders)[] {
  const o = offered as Partial<Record<keyof ReuseReaders, unknown>>
  return READER_NAMES.filter(k => typeof o[k] === 'undefined')
}

/**
 * Takes the host's surface when it is complete, else keeps (or goes back to) the bridge. Returns what
 * is now in force.
 */
export function installReaders(offered: object): 'host' | 'bridge' {
  const use = (missingReaders(offered).length === 0 ? offered : BRIDGE) as ReuseReaders
  source = use === BRIDGE ? 'bridge' : 'host'
  toSqliteUriPath = use.toSqliteUriPath
  REPLAY_TYPES = use.REPLAY_TYPES
  extractUserRequest = use.extractUserRequest
  isSlashCommandPrompt = use.isSlashCommandPrompt
  EDIT_TOOLS = use.EDIT_TOOLS
  FILE_URI_RE = use.FILE_URI_RE
  collectSubagentChildIds = use.collectSubagentChildIds
  countLines = use.countLines
  fileUriToPath = use.fileUriToPath
  buildAntigravityParentMap = use.buildAntigravityParentMap
  buildAntigravityWorkspaceMap = use.buildAntigravityWorkspaceMap
  firstHistoryPrompt = use.firstHistoryPrompt
  parseAntigravityHistory = use.parseAntigravityHistory
  parseGenMetadataBlob = use.parseGenMetadataBlob
  extractMessageText = use.extractMessageText
  isGenuineUserMessage = use.isGenuineUserMessage
  kimiAgentIds = use.kimiAgentIds
  parseKimiState = use.parseKimiState
  isToolError = use.isToolError
  stripProvider = use.stripProvider
  isoFromKimiTime = use.isoFromKimiTime
  emptyAgentMetrics = use.emptyAgentMetrics
  finishAgentMetrics = use.finishAgentMetrics
  foldAgentEntry = use.foldAgentEntry
  editDelta = use.editDelta
  canonicalTool = use.canonicalTool
  iterLines = use.iterLines
  isHumanUserEntry = use.isHumanUserEntry
  contextOfUsage = use.contextOfUsage
  commandSummary = use.commandSummary
  createTranscriptPathMemo = use.createTranscriptPathMemo
  resolveMemoizedPath = use.resolveMemoizedPath
  describedFrom = use.describedFrom
  isNestedAgent = use.isNestedAgent
  parseAgentMeta = use.parseAgentMeta
  planAgentJoin = use.planAgentJoin
  anchorHex = use.anchorHex
  consumedEnd = use.consumedEnd
  cursorFrom = use.cursorFrom
  evictTranscriptStates = use.evictTranscriptStates
  planTranscriptRead = use.planTranscriptRead
  MAX_STATES = use.MAX_STATES
  STATE_TTL_MS = use.STATE_TTL_MS
  safeReadDir = use.safeReadDir
  safeReadJson = use.safeReadJson
  confirm = use.confirm
  maskedInput = use.maskedInput
  originAllowed = use.originAllowed
  originPolicy = use.originPolicy
  return source
}
