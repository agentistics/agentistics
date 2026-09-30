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
import type * as Api from '@agentistics/engine-api'
import { claudeReplay } from './claude'
import * as claudeCore from './claude/replay-core'
import { CLAUDE_ADAPTER_VERSION } from './claude/replay-core'
import { codexReplay } from './codex'
import * as codexCore from './codex/replay-core'
import { CODEX_ADAPTER_VERSION } from './codex/replay-core'
import { antigravityReplay } from './antigravity'
import { geminiReplay } from './gemini'
import { copilotReplay } from './copilot'
import { kimiReplay } from './kimi'
import * as kimiCore from './kimi/replay-core'
import { KIMI_ADAPTER_VERSION } from './kimi/replay-core'
import * as copilotCore from './copilot/replay-core'
import { COPILOT_ADAPTER_VERSION } from './copilot/replay-core'
import * as geminiCore from './gemini/replay-core'
import { GEMINI_ADAPTER_VERSION } from './gemini/replay-core'
import * as antigravityCore from './antigravity/replay-core'
import { ANTIGRAVITY_ADAPTER_VERSION } from './antigravity/replay-core'
import { opencodeReplay } from './opencode'
import * as opencodeCore from './opencode/replay-core'
import { OPENCODE_ADAPTER_VERSION } from './opencode/replay-core'

/**
 * The replay contract itself is `@agentistics/engine-api`'s, instantiated with this repository's
 * canonical event — declared THERE so the public journal can drive a replay without importing this
 * directory, and re-exported here so nothing that already imports it changes.
 */
export type ReplaySource = Api.ReplaySource
export type ReplayCursor = Api.ReplayCursor
export type ReplayBatch = Api.ReplayBatch<AgentisticsEvent>
export type HarnessReplay = Api.HarnessReplay<AgentisticsEvent>
export type HarnessLive = Api.HarnessLive<AgentisticsEvent>
export type HarnessEntityIds = Api.HarnessEntityIds

interface IntegrationBase {
  id: HarnessId
  /** The `adapterVersion` every event this integration emits carries. Non-empty. */
  version: string
  /** The A1.4 states for this harness — read, not restated. */
  capabilities: Readonly<Record<CapabilityMetric, CapabilityState>>
  live?: HarnessLive
  /** The id derivations the journal's store import shares with the replay (`replay-core`). */
  entityIds?: HarnessEntityIds
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

/**
 * Since A3 (P2 §1), every harness has a replay — each proven by its own parity differential
 * (`projections/differential-<id>.ts`). A future harness without one must still say why, in
 * `replayAbsent`; the type forbids an entry that does neither.
 */
export const INTEGRATIONS: Record<HarnessId, HarnessIntegration> = {
  claude: {
    id: 'claude',
    version: CLAUDE_ADAPTER_VERSION,
    capabilities: CAPABILITY_STATES.claude,
    replay: claudeReplay,
    entityIds: claudeCore,
  },
  codex: {
    id: 'codex',
    version: CODEX_ADAPTER_VERSION,
    capabilities: CAPABILITY_STATES.codex,
    replay: codexReplay,
    entityIds: codexCore,
  },
  gemini: {
    id: 'gemini',
    version: GEMINI_ADAPTER_VERSION,
    capabilities: CAPABILITY_STATES.gemini,
    replay: geminiReplay,
    entityIds: geminiCore,
  },
  copilot: {
    id: 'copilot',
    version: COPILOT_ADAPTER_VERSION,
    capabilities: CAPABILITY_STATES.copilot,
    replay: copilotReplay,
    entityIds: copilotCore,
  },
  antigravity: {
    id: 'antigravity',
    version: ANTIGRAVITY_ADAPTER_VERSION,
    capabilities: CAPABILITY_STATES.antigravity,
    replay: antigravityReplay,
    entityIds: antigravityCore,
  },
  kimi: {
    id: 'kimi',
    version: KIMI_ADAPTER_VERSION,
    capabilities: CAPABILITY_STATES.kimi,
    replay: kimiReplay,
    entityIds: kimiCore,
  },
  // No legacy adapter exists for opencode (CLAUDE.md "Adding a harness" step 4, skipped by scope) —
  // it never produces a SessionMeta and therefore never appears on any surface. It still has a full
  // replay integration (this is the P2 half of the checklist, which does not depend on step 4).
  opencode: {
    id: 'opencode',
    version: OPENCODE_ADAPTER_VERSION,
    capabilities: CAPABILITY_STATES.opencode,
    replay: opencodeReplay,
    entityIds: opencodeCore,
  },
}

/** The registry in `HARNESS_ORDER`. Returns the entries themselves. */
export function integrationsInOrder(): HarnessIntegration[] {
  return HARNESS_ORDER.map(id => INTEGRATIONS[id])
}
