/**
 * engine/reuse-surface.ts — the host builds the `ReuseSurface` an engine reuses (contract 1.2).
 *
 * Each member is the host's OWN function, read from the module that owns it; the return type is the
 * contract's, so `tsc` proves every real signature still satisfies its member and a public refactor
 * that changes one fails here, in the public build. Imported lazily by `hostServices()` — only a
 * process that loads an engine pays for these modules.
 */
import type { ReuseSurface } from '@agentistics/engine-api'

export async function buildReuseSurface(): Promise<ReuseSurface> {
  const [
    antigravity, antigravityParse, antigravityProtobuf, geminiParse, kimiParse,
    agentMetrics, editLines, harnessActivity, jsonl, shellWrites, pathMemo,
    subagentJoin, transcriptCursor, transcriptState, utils, cliUi, cors,
  ] = await Promise.all([
    import('../adapters/antigravity'),
    import('../adapters/antigravity-parse'),
    import('../adapters/antigravity-protobuf'),
    import('../adapters/gemini-parse'),
    import('../adapters/kimi-parse'),
    import('../agent-metrics'),
    import('../edit-lines'),
    import('../harness-activity'),
    import('../jsonl'),
    import('../sessions/shell-writes'),
    import('../sessions/transcript-path-memo'),
    import('../subagent-join'),
    import('../transcript-cursor'),
    import('../transcript-state'),
    import('../utils'),
    import('../cli-ui'),
    import('../cors'),
  ])
  return {
    toSqliteUriPath: antigravity.toSqliteUriPath,
    REPLAY_TYPES: antigravityParse.REPLAY_TYPES,
    extractUserRequest: antigravityParse.extractUserRequest,
    isSlashCommandPrompt: antigravityParse.isSlashCommandPrompt,
    EDIT_TOOLS: antigravityParse.EDIT_TOOLS,
    FILE_URI_RE: antigravityParse.FILE_URI_RE,
    collectSubagentChildIds: antigravityParse.collectSubagentChildIds,
    countLines: antigravityParse.countLines,
    fileUriToPath: antigravityParse.fileUriToPath,
    buildAntigravityParentMap: antigravityParse.buildAntigravityParentMap,
    buildAntigravityWorkspaceMap: antigravityParse.buildAntigravityWorkspaceMap,
    firstHistoryPrompt: antigravityParse.firstHistoryPrompt,
    parseAntigravityHistory: antigravityParse.parseAntigravityHistory,
    parseGenMetadataBlob: antigravityProtobuf.parseGenMetadataBlob,
    extractMessageText: geminiParse.extractMessageText,
    isGenuineUserMessage: geminiParse.isGenuineUserMessage,
    kimiAgentIds: kimiParse.kimiAgentIds,
    parseKimiState: kimiParse.parseKimiState,
    isToolError: kimiParse.isToolError,
    stripProvider: kimiParse.stripProvider,
    isoFromKimiTime: kimiParse.isoFromKimiTime,
    emptyAgentMetrics: agentMetrics.emptyAgentMetrics,
    finishAgentMetrics: agentMetrics.finishAgentMetrics,
    foldAgentEntry: agentMetrics.foldAgentEntry,
    editDelta: editLines.editDelta,
    canonicalTool: harnessActivity.canonicalTool,
    iterLines: jsonl.iterLines,
    isHumanUserEntry: jsonl.isHumanUserEntry,
    contextOfUsage: jsonl.contextOfUsage,
    commandSummary: shellWrites.commandSummary,
    createTranscriptPathMemo: pathMemo.createTranscriptPathMemo,
    resolveMemoizedPath: pathMemo.resolveMemoizedPath,
    describedFrom: subagentJoin.describedFrom,
    isNestedAgent: subagentJoin.isNestedAgent,
    parseAgentMeta: subagentJoin.parseAgentMeta,
    planAgentJoin: subagentJoin.planAgentJoin,
    anchorHex: transcriptCursor.anchorHex,
    consumedEnd: transcriptCursor.consumedEnd,
    cursorFrom: transcriptCursor.cursorFrom,
    evictTranscriptStates: transcriptCursor.evictTranscriptStates,
    planTranscriptRead: transcriptCursor.planTranscriptRead,
    MAX_STATES: transcriptState.MAX_STATES,
    STATE_TTL_MS: transcriptState.STATE_TTL_MS,
    safeReadDir: utils.safeReadDir,
    safeReadJson: utils.safeReadJson,
    confirm: cliUi.confirm,
    maskedInput: cliUi.maskedInput,
    originAllowed: cors.originAllowed,
  }
}
