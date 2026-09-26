/**
 * integrations/types.ts — the registry of harness integrations (P1 §3, §4.3; master §16).
 *
 * An INTEGRATION is what turns one harness's own record into canonical events. This file holds the
 * CONTRACT and the registry, nothing that reads a file: `claude/replay.ts` (A2.2) is the first thing
 * to plug into it.
 *
 * `INTEGRATIONS` is a `Record<HarnessId, …>`, so the compiler fails the build when a harness is
 * missing, and `types.test.ts` compares its keys with `HARNESS_ORDER` so removing one fails the
 * tests too (P1 §12, item 7). Iteration goes through `integrationsInOrder()` — the order is
 * `HARNESS_ORDER`'s, never a list written out here (CLAUDE.md: five places once did, and a new
 * harness vanished from all of them while the build stayed green).
 *
 * **A missing `replay` is a DECLARED ABSENCE, never a crash.** The type makes an entry say either
 * "here is my replay" or "here is, in one sentence, why I have none" — an entry that says neither
 * does not compile, so "not built yet" and "forgotten" cannot look alike.
 *
 * P1 writes no conversation text into the journal: whatever a replay emits carries counters, ids,
 * names and summaries only (a shell command through `commandSummary`, never raw), each event with a
 * non-empty `adapterVersion` (the entry's `version`), a `confidence` and a re-readable `sourceRef`,
 * and its id from `deriveEventId`. An event states facts and carries no instruction (master §38).
 */
import {
  CAPABILITY_STATES,
  HARNESS_ORDER,
  type AgentisticsEvent,
  type CapabilityMetric,
  type CapabilityState,
  type HarnessId,
} from '@agentistics/core'
import { claudeReplay } from './claude'
import { CLAUDE_ADAPTER_VERSION } from './claude/replay-core'

/** One thing a replay can be pointed at — a transcript, a database, a session directory. */
export interface ReplaySource {
  /** The harness's own id for the conversation. */
  sessionId: string
  /** What `sourceRef` on every event read from it resolves to: something a person can re-open. */
  sourceRef: string
}

/**
 * Where a replay stopped, opaque to everything but the integration that issued it. `null` is the
 * start. It is a string so it can be stored beside the journal (Claude's is a byte offset plus the
 * anchor `transcript-cursor.ts` checks), and an integration that cannot trust a stored cursor
 * re-reads from the start rather than resuming from it.
 */
export type ReplayCursor = string | null

export interface ReplayBatch {
  events: AgentisticsEvent[]
  /** Pass back to `replay` to read only what is new. */
  cursor: ReplayCursor
}

/**
 * Reading a harness's stored record back as canonical events. `discover` and `replay` are the IO
 * halves; the fold that turns entries into events is PURE and lives beside each integration.
 */
export interface HarnessReplay {
  /** Every source this integration can currently replay. Total: an unreadable store yields `[]`. */
  discover(): Promise<ReplaySource[]>
  /** The events of `source` written since `cursor`. Folding it in N chunks equals folding it whole. */
  replay(source: ReplaySource, cursor: ReplayCursor): Promise<ReplayBatch>
}

/** Following a live harness as it writes. Nothing implements it in P1 — the slot is the contract. */
export interface HarnessLive {
  /** Starts delivering events; the returned function stops it. */
  watch(emit: (event: AgentisticsEvent) => void): () => void
}

interface IntegrationBase {
  id: HarnessId
  /** The `adapterVersion` every event this integration emits carries. Non-empty. */
  version: string
  /** The A1.4 states for this harness — read, not restated. */
  capabilities: Readonly<Record<CapabilityMetric, CapabilityState>>
  live?: HarnessLive
}

export type HarnessIntegration = IntegrationBase &
  (
    | { replay: HarnessReplay; replayAbsent?: undefined }
    /** `replayAbsent` is the one sentence saying why there is no replay. */
    | { replay?: undefined; replayAbsent: string }
  )

/** Narrows an entry to one that can replay. False is a declared absence, not an error. */
export function hasReplay(
  integration: HarnessIntegration,
): integration is IntegrationBase & { replay: HarnessReplay; replayAbsent?: undefined } {
  return integration.replay !== undefined
}

/** Every entry below starts here; the integration that gets built bumps its own. */
const UNIMPLEMENTED = '0.0.0'

/** The one place the P1 scoping sentence for the five absences is worded. */
const P1_CLAUDE_ONLY = 'P1 replays Claude Code transcripts only'

export const INTEGRATIONS: Record<HarnessId, HarnessIntegration> = {
  claude: {
    id: 'claude',
    version: CLAUDE_ADAPTER_VERSION,
    capabilities: CAPABILITY_STATES.claude,
    replay: claudeReplay,
  },
  codex: {
    id: 'codex',
    version: UNIMPLEMENTED,
    capabilities: CAPABILITY_STATES.codex,
    replayAbsent: `${P1_CLAUDE_ONLY}; Codex rollouts (~/.codex/sessions) are still read only by adapters/codex.ts.`,
  },
  gemini: {
    id: 'gemini',
    version: UNIMPLEMENTED,
    capabilities: CAPABILITY_STATES.gemini,
    replayAbsent: `${P1_CLAUDE_ONLY}; Gemini chat journals (~/.gemini/tmp) are still read only by adapters/gemini.ts.`,
  },
  copilot: {
    id: 'copilot',
    version: UNIMPLEMENTED,
    capabilities: CAPABILITY_STATES.copilot,
    replayAbsent: `${P1_CLAUDE_ONLY}; Copilot session events (~/.copilot/session-state) are still read only by adapters/copilot.ts.`,
  },
  antigravity: {
    id: 'antigravity',
    version: UNIMPLEMENTED,
    capabilities: CAPABILITY_STATES.antigravity,
    replayAbsent: `${P1_CLAUDE_ONLY}; agy transcripts and gen_metadata databases are still read only by adapters/antigravity.ts.`,
  },
  kimi: {
    id: 'kimi',
    version: UNIMPLEMENTED,
    capabilities: CAPABILITY_STATES.kimi,
    replayAbsent: `${P1_CLAUDE_ONLY}; Kimi wire streams (~/.kimi-code/sessions) are still read only by adapters/kimi.ts.`,
  },
}

/** The registry in `HARNESS_ORDER`. Returns the entries themselves. */
export function integrationsInOrder(): HarnessIntegration[] {
  return HARNESS_ORDER.map(id => INTEGRATIONS[id])
}
