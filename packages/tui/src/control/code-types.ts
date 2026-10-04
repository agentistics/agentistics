/**
 * code-types.ts — the  tab's vocabulary. Since engine-api 1.8 the contract lives in
 * `@agentistics/engine-api` (`code-host.ts`), the ONE definition the ENGINE implements and this tab folds;
 * this file only re-exports it under the names the tab already uses (`CodeHost` = the typed port).
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
  CodeModelChoice,
  CodePlanItem,
  CodeResult,
  CodeSessionFacts,
  CodeStartInput,
  CodeTaskOption,
  CodeToolCall,
  CodeToolState,
  CodeUsage,
} from '@agentistics/engine-api'
export type { CodeHostPort as CodeHost } from '@agentistics/engine-api'
