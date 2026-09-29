/**
 * sessionIdentity.ts — the ONE key a session survives a reopen under.
 *
 * A REOPEN LANDS SOMEWHERE (see CLAUDE.md): it retires the managed row it was asked about and mints
 * a brand-new managed `id` for the SAME conversation. So any feature that remembers something ABOUT
 * a session across its lifetime — a pin, a user-made group — must not key itself on the managed id,
 * or the fact it recorded is orphaned the instant the session is reopened.
 *
 * Where the harness can report a stable conversation id, that IS the key. Where it cannot
 * (`conversationBlind` harnesses — codex, kimi, gemini, agy; see `ControlSession.conversationBlind`
 * in `@agentistics/tui/control/session-fleet`), the managed id is the only key there is, and a
 * reopen of one of THOSE sessions genuinely orphans whatever was recorded against it. That gap
 * predates this module — it was `pinnedSessions.ts`'s own `pinKeyOf`, defined once inside
 * `SessionsAside.tsx` — and is inherited here rather than introduced: pinning and user groups now
 * share the one function instead of each holding a private copy that could drift.
 */

/** Structural, not `ControlSession` itself, so this stays free of the TUI import for callers
 *  (pure test code included) that only ever hold this much of a row. */
export interface SessionIdentitySource {
  id: string
  conversationId?: string
}

export { sessionIdentityKey } from '@agentistics/core'
