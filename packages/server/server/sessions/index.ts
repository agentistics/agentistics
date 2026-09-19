/**
 * index.ts — the only place that branches on platform.
 *
 * ## Why there is still no native Windows backend
 *
 * The design called for a per-session ConPTY host here. It is not written, and the reason is worth
 * recording so nobody re-derives it:
 *
 *  - **Bun exposes no PTY primitive** (checked against Bun 1.3.14). `Bun.spawn` gives pipes, and a
 *    pipe is not a terminal: every harness this manages is a full-screen TUI that queries the
 *    terminal for its size, drives the alternate screen and expects raw-mode input. Hosted on pipes
 *    they render as garbage, which is a worse failure than not starting at all because it looks
 *    like it worked.
 *  - **The only real option is a native module** (`node-pty` and its kin), and this project compiles
 *    to ONE portable binary via `bun build --compile`. A native addon cannot be embedded in it —
 *    the same distribution constraint that makes `stubs/react-devtools-core` load-bearing.
 *
 * So the honest state is: Windows needs WSL, and it is told so in those words rather than being
 * handed a generic "tmux is not installed" it cannot act on. A verb that cannot work is absent and
 * its reason is stated — never present and failing.
 *
 * When a PTY primitive lands in Bun, `backend-pty.ts` goes here and NOTHING else in the session
 * manager changes: that is the entire point of `SessionBackend` existing.
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

export async function resolveBackend(): Promise<SessionBackend> {
  return process.platform === 'win32' ? windowsBackend : tmuxBackend
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
