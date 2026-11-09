/**
 * composerEnter.ts — PURE. Does this keystroke SEND the composer's message?
 *
 * The rule lived inline at two sites as `e.key === 'Enter' && !e.shiftKey && !isMobile`, which leaves three people with a key that
 * does nothing visible: a hardware keyboard on a window narrower than the phone breakpoint (return only breaks the line there, and
 * Cmd/Ctrl+Enter — the send chord every chat app teaches — was ignored too, so the only way to send was the ✈ button), a Mac
 * accent being composed (Enter confirms the composition and must not also send a half-written word), and the ✈/Enter pair that
 * answered a refused send with nothing at all (see `send()` — a refusal is now said).
 *
 *  - plain Enter sends on a hardware keyboard layout, breaks the line on a touch layout (`isMobile`), as before;
 *  - Cmd+Enter / Ctrl+Enter ALWAYS send, wherever the window is, because nobody types that chord to break a line;
 *  - shift+Enter always breaks the line;
 *  - a keystroke that is committing an IME composition (`isComposing`, or the legacy keyCode 229) is never a send.
 */
export interface EnterKey {
  key: string
  shiftKey: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  isComposing?: boolean
  keyCode?: number
  isMobile: boolean
}

export function enterSends(k: EnterKey): boolean {
  if (k.key !== 'Enter') return false
  if (k.isComposing === true || k.keyCode === 229) return false
  if (k.shiftKey) return false
  if (k.metaKey === true || k.ctrlKey === true) return true
  return !k.isMobile
}
