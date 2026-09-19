/**
 * terminalShortcuts.ts — PURE. Which key combinations the terminal takes from the browser while it
 * holds the keyboard, and — far more important — which it may never touch.
 *
 * Reported: "quando eu estiver no terminal, quero que os atalhos funcionem (ctrl l ctrl w etc). sem
 * afetar o navegador." Both halves of that sentence are the specification. Today `ctrl+w` closes
 * the tab and `ctrl+l` focuses the address bar, so neither ever reaches the pane; and the naive fix
 * — swallow anything with ctrl — costs somebody their devtools, their new tab and, on a Mac, every
 * application shortcut there is.
 *
 * So the rule is narrow on purpose and stated once:
 *
 *  - **Take only what the channel can actually deliver.** `CTRL_SHORTCUTS` is exactly the set of
 *    letters `KEY_ALLOWLIST` carries as `C-<letter>`. Swallowing `ctrl+z` would cost the browser
 *    shortcut and deliver nothing in exchange, because the server would refuse it as `bad_key`.
 *  - **Never `ctrl+shift+*`.** Devtools, the incognito window, reopen-tab. The VS Code extension in
 *    this repo records the identical rule for its panel — swallow these and the editor around the
 *    terminal stops working.
 *  - **Never Cmd/Win, never Alt.** On a Mac every application shortcut is Cmd; a terminal that ate
 *    them is a terminal you cannot copy out of, quit, or switch away from.
 *
 * The caller applies this ONLY while the emulator is focused and the write channel is open. A
 * page-level handler that swallowed `ctrl+w` whenever a terminal existed somewhere on screen would
 * be a browser the person cannot close.
 *
 * COPY is the one exception to "take only what the channel can deliver": `Ctrl+C` is in
 * `CTRL_SHORTCUTS` (it sends the interrupt), but with a SELECTION on screen the same keystroke must
 * copy instead — sending an interrupt while someone is mid-copy both loses the selection (xterm's
 * `reset()` clears it on the next frame) and answers a copy attempt with SIGINT. `hasSelection` is
 * read from the emulator by the caller and decides between the two; the same combo without a
 * selection still interrupts exactly as before. Cmd+C and Ctrl+Shift+C never reached `CLAIMED` in
 * the first place, but the copy decision covers them too because the CALLER must return `false` from
 * `attachCustomKeyEventHandler` for a real copy — merely not calling `preventDefault` (what `leave`
 * means everywhere else) is not enough: xterm's OWN key handling still runs unless the handler
 * returns exactly `false`, and it would otherwise still emit `\x03` regardless of what the browser
 * does with the keystroke.
 */

/**
 * The letters this terminal claims when they arrive with ctrl alone.
 *
 * Exactly the ones `KEY_ALLOWLIST` (server, `input-protocol.ts`) accepts as `C-<letter>`:
 * `C-a` `C-c` `C-d` `C-e` `C-k` `C-l` `C-u` `C-w`. Mirrored here for the reason the key allowlist
 * itself is mirrored — so the client does not claim a keystroke the server will refuse.
 */
export const CTRL_SHORTCUTS: readonly string[] = ['a', 'c', 'd', 'e', 'k', 'l', 'u', 'w']

const CLAIMED = new Set(CTRL_SHORTCUTS)

/** Only the fields the decision reads, so it is testable without a DOM event. */
export interface ShortcutEvent {
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  key: string
}

/**
 * `take` = the terminal handles it and the browser must not; `leave` = the browser keeps it;
 * `copy` = a copy-with-selection — the caller must return `false` from
 * `attachCustomKeyEventHandler` (not merely skip `preventDefault`) so xterm sends nothing and the
 * browser's native copy fires on the selection.
 *
 * `shiftKey` is refused before the letter is even looked at for `take`/`leave`, which is also why
 * case cannot decide anything there: a capital arrives WITH shift, and shift already refuses. The
 * `copy` check runs first and does not exclude `shiftKey` — Ctrl+Shift+C must copy too.
 */
export function shortcutDecision(e: ShortcutEvent, hasSelection = false): 'take' | 'leave' | 'copy' {
  if (
    hasSelection && !e.altKey && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c'
  ) return 'copy'
  if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return 'leave'
  return CLAIMED.has(e.key.toLowerCase()) ? 'take' : 'leave'
}
