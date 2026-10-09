/**
 * WHICH VIEW A SESSION OPENS ON — the ONE decision point.
 *
 * Every session opens on the CHAT (conversation + composer), even an empty one, whatever the
 * harness; the terminal is only ever shown when the person asks for it (`?view=terminal`, the
 * Terminal tab). It used to be decided in two places with a third rule hidden in `chattable`:
 * a harness whose conversation cannot be linked yet (`conversationBlind` — codex, kimi, gemini,
 * until the first message is claimed) was forced onto the terminal, so a brand-new Codex session
 * opened on the Codex banner while an empty Claude one opened on the chat.
 *
 * `conversationBlind` therefore no longer chooses the view. An unlinked conversation is an EMPTY
 * chat ("waiting for the first message"), and the link lands after the first message is sent.
 *
 * SEAM: when the engine adapter learns to report a conversation per harness, it plugs in HERE — a
 * new input to this function — and nowhere else. Never branch on `harness === '…'` at a call site.
 */
export type SessionView = 'chat' | 'terminal'

export interface SessionViewInput {
  /** The `?view=` the URL carries (`null` when absent or unknown). */
  requested: string | null
  /** A session of another machine reached through the relay: its conversation is not readable. */
  relayed?: boolean
  /** Native or external: no screen to show, so the chat is the only view there is. */
  screenless?: boolean
}

/** Is the chat offered at all for this session (tab present, chat mountable)? */
export function chatOffered(input: Pick<SessionViewInput, 'relayed'>): boolean {
  return !input.relayed
}

export function initialSessionView(input: SessionViewInput): SessionView {
  if (!chatOffered(input)) return 'terminal'
  if (input.screenless) return 'chat'
  return input.requested === 'terminal' ? 'terminal' : 'chat'
}
