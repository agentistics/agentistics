/**
 * account-isolation.ts — PURE (PLAN.ACCOUNTS). The ONE environment variable each harness reads to
 * move its whole config/login directory, or `null` where none exists (antigravity, opencode: one
 * login per computer). A leaf with no I/O so `spawn-spec.ts` can apply it without importing the
 * account registry.
 */
import type { HarnessId } from '@agentistics/core'

export const ISOLATION_ENV: Record<HarnessId, string | null> = {
  claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME', copilot: 'COPILOT_HOME',
  gemini: 'GEMINI_CLI_HOME', kimi: 'KIMI_CODE_HOME', antigravity: null,
  opencode: null,
}
