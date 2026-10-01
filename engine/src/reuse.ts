/**
 * reuse.ts — the reuse surface (spec §6) as every engine module sees it.
 *
 * The integrations and the provider verb import the public functions they reuse FROM HERE and never
 * from the public tree: one parser, one answer, with the dependency declared in one place. Each name
 * is a live binding (`export let`), filled by `installReaders` from the host's `readers` — contract
 * 1.2's `ReuseSurface`, whose 48 members are exactly these.
 *
 * There is no fallback. A host that offers an INCOMPLETE surface is refused whole, in a sentence
 * naming what is missing (mixing two builds of one parser family is two answers to one question), so
 * `createEngine` throws and the host runs as a community build. Before a surface is installed every
 * binding is `undefined`: a caller that reaches one has run without `createEngine` (tests install
 * the public host's own surface in `test/preload.ts`).
 */
import { missingReuseMembers, type ReuseSurface } from '@agentistics/engine-api'

export type { ReuseSurface }
export type {
  AntigravityConversationSummary,
  AntigravityHistoryEntry,
  KimiState,
  AgentMetricsState,
  EditDelta,
  TranscriptPathMemo,
  AgentEntry,
  TranscriptCursor,
  TranscriptStat,
} from '@agentistics/engine-api'

export let toSqliteUriPath!: ReuseSurface['toSqliteUriPath']
export let REPLAY_TYPES!: ReuseSurface['REPLAY_TYPES']
export let extractUserRequest!: ReuseSurface['extractUserRequest']
export let isSlashCommandPrompt!: ReuseSurface['isSlashCommandPrompt']
export let EDIT_TOOLS!: ReuseSurface['EDIT_TOOLS']
export let FILE_URI_RE!: ReuseSurface['FILE_URI_RE']
export let collectSubagentChildIds!: ReuseSurface['collectSubagentChildIds']
export let countLines!: ReuseSurface['countLines']
export let fileUriToPath!: ReuseSurface['fileUriToPath']
export let buildAntigravityParentMap!: ReuseSurface['buildAntigravityParentMap']
export let buildAntigravityWorkspaceMap!: ReuseSurface['buildAntigravityWorkspaceMap']
export let firstHistoryPrompt!: ReuseSurface['firstHistoryPrompt']
export let parseAntigravityHistory!: ReuseSurface['parseAntigravityHistory']
export let parseGenMetadataBlob!: ReuseSurface['parseGenMetadataBlob']
export let extractMessageText!: ReuseSurface['extractMessageText']
export let isGenuineUserMessage!: ReuseSurface['isGenuineUserMessage']
export let kimiAgentIds!: ReuseSurface['kimiAgentIds']
export let parseKimiState!: ReuseSurface['parseKimiState']
export let isToolError!: ReuseSurface['isToolError']
export let stripProvider!: ReuseSurface['stripProvider']
export let isoFromKimiTime!: ReuseSurface['isoFromKimiTime']
export let emptyAgentMetrics!: ReuseSurface['emptyAgentMetrics']
export let finishAgentMetrics!: ReuseSurface['finishAgentMetrics']
export let foldAgentEntry!: ReuseSurface['foldAgentEntry']
export let editDelta!: ReuseSurface['editDelta']
export let canonicalTool!: ReuseSurface['canonicalTool']
export let iterLines!: ReuseSurface['iterLines']
export let isHumanUserEntry!: ReuseSurface['isHumanUserEntry']
export let contextOfUsage!: ReuseSurface['contextOfUsage']
export let commandSummary!: ReuseSurface['commandSummary']
export let createTranscriptPathMemo!: ReuseSurface['createTranscriptPathMemo']
export let resolveMemoizedPath!: ReuseSurface['resolveMemoizedPath']
export let describedFrom!: ReuseSurface['describedFrom']
export let isNestedAgent!: ReuseSurface['isNestedAgent']
export let parseAgentMeta!: ReuseSurface['parseAgentMeta']
export let planAgentJoin!: ReuseSurface['planAgentJoin']
export let anchorHex!: ReuseSurface['anchorHex']
export let consumedEnd!: ReuseSurface['consumedEnd']
export let cursorFrom!: ReuseSurface['cursorFrom']
export let evictTranscriptStates!: ReuseSurface['evictTranscriptStates']
export let planTranscriptRead!: ReuseSurface['planTranscriptRead']
export let MAX_STATES!: ReuseSurface['MAX_STATES']
export let STATE_TTL_MS!: ReuseSurface['STATE_TTL_MS']
export let safeReadDir!: ReuseSurface['safeReadDir']
export let safeReadJson!: ReuseSurface['safeReadJson']
export let confirm!: ReuseSurface['confirm']
export let maskedInput!: ReuseSurface['maskedInput']
export let originAllowed!: ReuseSurface['originAllowed']

let installed: ReuseSurface | null = null

/** The surface in force, or `null` before a host has offered one. */
export function installedReaders(): ReuseSurface | null {
  return installed
}

/** Where the reused public functions come from — always the host's, once installed. */
export function readersSource(): 'host' | 'absent' {
  return installed ? 'host' : 'absent'
}

/** Installs the host's surface. Throws, naming every missing member, when it is incomplete. */
export function installReaders(readers: object): void {
  const missing = missingReuseMembers(readers)
  if (missing.length > 0) {
    throw new Error(`the host offered an incomplete reuse surface (missing: ${missing.join(', ')}) — this engine needs contract 1.2`)
  }
  const offered = readers as ReuseSurface
  installed = offered
  toSqliteUriPath = offered.toSqliteUriPath
  REPLAY_TYPES = offered.REPLAY_TYPES
  extractUserRequest = offered.extractUserRequest
  isSlashCommandPrompt = offered.isSlashCommandPrompt
  EDIT_TOOLS = offered.EDIT_TOOLS
  FILE_URI_RE = offered.FILE_URI_RE
  collectSubagentChildIds = offered.collectSubagentChildIds
  countLines = offered.countLines
  fileUriToPath = offered.fileUriToPath
  buildAntigravityParentMap = offered.buildAntigravityParentMap
  buildAntigravityWorkspaceMap = offered.buildAntigravityWorkspaceMap
  firstHistoryPrompt = offered.firstHistoryPrompt
  parseAntigravityHistory = offered.parseAntigravityHistory
  parseGenMetadataBlob = offered.parseGenMetadataBlob
  extractMessageText = offered.extractMessageText
  isGenuineUserMessage = offered.isGenuineUserMessage
  kimiAgentIds = offered.kimiAgentIds
  parseKimiState = offered.parseKimiState
  isToolError = offered.isToolError
  stripProvider = offered.stripProvider
  isoFromKimiTime = offered.isoFromKimiTime
  emptyAgentMetrics = offered.emptyAgentMetrics
  finishAgentMetrics = offered.finishAgentMetrics
  foldAgentEntry = offered.foldAgentEntry
  editDelta = offered.editDelta
  canonicalTool = offered.canonicalTool
  iterLines = offered.iterLines
  isHumanUserEntry = offered.isHumanUserEntry
  contextOfUsage = offered.contextOfUsage
  commandSummary = offered.commandSummary
  createTranscriptPathMemo = offered.createTranscriptPathMemo
  resolveMemoizedPath = offered.resolveMemoizedPath
  describedFrom = offered.describedFrom
  isNestedAgent = offered.isNestedAgent
  parseAgentMeta = offered.parseAgentMeta
  planAgentJoin = offered.planAgentJoin
  anchorHex = offered.anchorHex
  consumedEnd = offered.consumedEnd
  cursorFrom = offered.cursorFrom
  evictTranscriptStates = offered.evictTranscriptStates
  planTranscriptRead = offered.planTranscriptRead
  MAX_STATES = offered.MAX_STATES
  STATE_TTL_MS = offered.STATE_TTL_MS
  safeReadDir = offered.safeReadDir
  safeReadJson = offered.safeReadJson
  confirm = offered.confirm
  maskedInput = offered.maskedInput
  originAllowed = offered.originAllowed
}
