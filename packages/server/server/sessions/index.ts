/**
 * index.ts — the only place that branches on platform.
 *
 * ## Why there is still no native Windows backend
 *
 * The design called for a per-session ConPTY host here. It is not written, and the reason is worth
 * recording so nobody re-derives it:
 *
 *  - **Bun.Terminal exists** (Bun >= 1.3.5; ConPTY on Windows from 1.3.14) and was measured to
 *    survive `bun build --compile` — docs/superpowers/research/14-pty-shell-options.md. The earlier
 *    claim here, that Bun has no PTY primitive, is false.
 *  - **It still cannot replace tmux, and that is the real limit.** `Bun.Terminal` is in-process and
 *    exposes no fd a second process can join, so a session hosted on it cannot be attached from
 *    another process (the cockpit, `agentop session attach`, the VS Code extension) and cannot
 *    survive an `agentop server` restart. tmux gives both because the pty outlives the process that
 *    opened it.
 *
 * So the honest state is: Windows needs WSL, and it is told so in those words rather than being
 * handed a generic "tmux is not installed" it cannot act on. A verb that cannot work is absent and
 * its reason is stated — never present and failing.
 *
 * A `SessionBackend` on `Bun.Terminal` would fit here without touching the rest of the session
 * manager, but only as a backend that gives up cross-process attach and restart survival; the
 * Windows ConPTY path has not been exercised in this project.
 */

import { tmuxBackend } from './backend-tmux'
import type { SessionBackend } from './types'

/**
 * The tmux backend, wrapped so that on Windows the reason names the actual remedy.
 *
 * Wrapped rather than branched at every call site: `unavailable()` is the ONE question every caller
 * already asks before doing anything, so the platform answer belongs inside it.
 */
const windowsBackend: SessionBackend = {
  ...tmuxBackend,
  async unavailable() {
    return 'session management needs tmux, which Windows has no native equivalent of — run agentop '
      + 'inside WSL to manage sessions. Everything else works here.'
  },
}

/**
 * A5.4: once, the tmux backend wrapped by the ACP composite (`acp-backend.ts`). The composite only
 * takes a spawn when the person opted the harness into ACP (`preferences.acpHarnesses`) AND the
 * engine drives it (`engine.acp`, engine-api 1.7); otherwise every verb is tmux's, unchanged.
 */
let composite: SessionBackend | null = null

export async function resolveBackend(): Promise<SessionBackend> {
  if (process.platform === 'win32') return windowsBackend
  if (!composite) {
    const { withAcp } = await import('./acp-backend')
    composite = withAcp(tmuxBackend, {
      acp: async () => (await import('../engine/load')).engine()?.acp ?? null,
      allowed: async () => ((await (await import('../preferences')).readPreferences()).acpHarnesses ?? []),
    })
  }
  return composite
}

export * from './types'
export { SPAWN_SPECS, planSpawn } from './spawn-spec'
export { reconcileSessions, resolveSessionRef } from './session-ref'
export {
  addSession, newSessionId, patchSession, readRegistry, removeSession, retireSession, touchSessions,
} from './registry'
export { SESSION_POLL_MS, createSessionsPoller, type SessionSnapshot } from './sessions-host'
export { APPROVAL_SPECS, approvalFor, type ApprovalSpec } from './approval-spec'
export {
  CRASH_WINDOW_MS, HEARTBEAT_MS, planCrashGroup, type CrashGroup,
} from './crash-group'
export {
  attentionCount, bellTransitions, buildSessionViews, needsAttention, type SessionView,
} from './session-view'
export { ATTENTION_RULES, rulesFor } from './attention-rules'
export { QUIET_MS, approvalTail, attentionOf, digestFrame } from './attention'
