/**
 * projections/adapter-versions.ts — the adapter versions running NOW, by `source.id` (master spec
 * §19.4, §45). A materialised projection records the set it was built under; when this set changes the
 * catch-up pass rebuilds it from the journal (`catalog.ts`, `planProjection`) — the re-projection lever,
 * with no file to touch and no cache to delete.
 *
 * Read off each integration's own exported constant — never restated here — and keyed by `HARNESS_ORDER`
 * so a harness added without an entry here is a compile error rather than a silently unversioned one.
 */
import type { HarnessId } from '@agentistics/core'
import { ANTIGRAVITY_ADAPTER_VERSION, ANTIGRAVITY_SOURCE_ID } from '../integrations/antigravity/replay-core'
import { CLAUDE_ADAPTER_VERSION, CLAUDE_SOURCE_ID } from '../integrations/claude/replay-core'
import { CODEX_ADAPTER_VERSION, CODEX_SOURCE_ID } from '../integrations/codex/replay-core'
import { COPILOT_ADAPTER_VERSION, COPILOT_SOURCE_ID } from '../integrations/copilot/replay-core'
import { GEMINI_ADAPTER_VERSION, GEMINI_SOURCE_ID } from '../integrations/gemini/replay-core'
import { KIMI_ADAPTER_VERSION, KIMI_SOURCE_ID } from '../integrations/kimi/replay-core'
import { OPENCODE_ADAPTER_VERSION, OPENCODE_SOURCE_ID } from '../integrations/opencode/replay-core'

const BY_HARNESS: Record<HarnessId, readonly [string, string]> = {
  claude: [CLAUDE_SOURCE_ID, CLAUDE_ADAPTER_VERSION],
  codex: [CODEX_SOURCE_ID, CODEX_ADAPTER_VERSION],
  gemini: [GEMINI_SOURCE_ID, GEMINI_ADAPTER_VERSION],
  copilot: [COPILOT_SOURCE_ID, COPILOT_ADAPTER_VERSION],
  antigravity: [ANTIGRAVITY_SOURCE_ID, ANTIGRAVITY_ADAPTER_VERSION],
  kimi: [KIMI_SOURCE_ID, KIMI_ADAPTER_VERSION],
  opencode: [OPENCODE_SOURCE_ID, OPENCODE_ADAPTER_VERSION],
}

export const CURRENT_ADAPTER_VERSIONS: Readonly<Record<string, string>> = Object.fromEntries(Object.values(BY_HARNESS))
