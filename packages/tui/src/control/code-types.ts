/**
 * code-types.ts — the `code` tab's vocabulary. Since engine-api 1.8 the contract lives in
 * `@agentistics/engine-api` (`code-host.ts`), the ONE definition the ENGINE implements and this tab folds;
 * this file only re-exports it under the names the tab already uses (`CodeHost` = the typed port, as
 * `asCodePort()` hands it over). The port's later members (`cycleMode`, `recentSessions`, `rename`,
 * `promptHistory`) are optional: the tab degrades — says so in words — when the engine offers none of them.
 */
export type {
  CodeAsk,
  CodeAvailability,
  CodeDefaults,
  CodeDiff,
  CodeDiffFile,
  CodeDiffHunk,
  CodeDiffLine,
  CodeDiffOp,
  CodeEvent,
  CodeHistoryTurn,
  CodeLaunch,
  CodeModeId,
  CodeModelChoice,
  CodePlanItem,
  CodePolicyDecision,
  CodePromptRecord,
  CodeRecentSession,
  CodeResult,
  CodeSessionFacts,
  CodeSessionRule,
  CodeStartInput,
  CodeTaskOption,
  CodeToolCall,
  CodeToolState,
  CodeUsage,
} from '@agentistics/engine-api'
export type { CodeHostPort as CodeHost } from '@agentistics/engine-api'

/** CD-17: the host's `$VISUAL`/`$EDITOR` door (it owns the tty) — a HOST capability, not the engine's. */
export type CodeDraftEditor = (draft: string) => Promise<import('@agentistics/engine-api').CodeResult<{ text: string; sentence: string }>>
