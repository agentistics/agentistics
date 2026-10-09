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
 * Once, the tmux backend wrapped by the STRUCTURED composite (`structured-backend.ts`, F2.0 — which
 * generalises A5.4's ACP composite). A web-born spawn with the `adapter-chat` flag on runs over its
 * harness's protocol when a driver is ready (`engine.structured`, or a 1.9 engine's `engine.acp`);
 * A5.4's opt-in (`preferences.acpHarnesses`) still routes as before; every other verb is tmux's,
 * unchanged. A structured session whose driver fails is resumed in tmux by its conversation id.
 */
let composite: SessionBackend | null = null

export async function resolveBackend(): Promise<SessionBackend> {
  if (process.platform === 'win32') return windowsBackend
  if (!composite) {
    const { withStructured } = await import('./structured-backend')
    const { featureOn } = await import('@agentistics/core')
    composite = withStructured(tmuxBackend, {
      structured: async () => (await import('../engine/load')).engine()?.structured ?? null,
      acp: async () => (await import('../engine/load')).engine()?.acp ?? null,
      allowed: async () => ((await (await import('../preferences')).readPreferences()).acpHarnesses ?? []),
      flagOn: () => featureOn('adapter-chat'),
      async resumeSpawn(req, conversationId) {
        const i = req.structured
        if (!i) return null
        const { planSpawn } = await import('./spawn-spec')
        const planned = planSpawn({
          harness: i.harness, cwd: req.cwd, resumeId: conversationId,
          ...(i.model ? { model: i.model } : {}), ...(i.effort ? { effort: i.effort } : {}),
        })
        if (!planned.ok) return null
        return { id: req.id, cwd: req.cwd, argv: planned.plan.argv, ...(planned.plan.env ? { env: planned.plan.env } : {}) }
      },
      onStarted(id, driver) {
        void import('./registry').then(r => r.patchSession(id, { structuredDriver: driver })).catch(() => {})
      },
      onConversation(id, conversationId) {
        void import('./registry').then(r => r.patchSession(id, {
          conversationId, conversationLink: 'assigned', conversationLinkVia: 'protocol-stated',
        })).catch(() => {})
      },
      async prepare() {
        const { ensureSessionIdentityKey } = await import('./session-identity')
        await ensureSessionIdentityKey()
      },
      onFallback(id, o) {
        console.warn(`[sessions] structured session ${id} fell back to tmux (${o.resumed ? 'resumed by conversation id' : 'could not resume'}): ${o.reason}`)
      },
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
