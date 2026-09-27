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
 * SESSION-ENDING KEYS take Shift and are announced — see `ShortcutDecision` below.
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
 * KEYS THAT CAN END THE SESSION ARE GUARDED BY SHIFT (owner, 2026-09-27: "dei ctrl + c no terminal
 * e matei a porra da sessao"). `Ctrl+C` interrupts — and a second one exits Claude Code — and
 * `Ctrl+D` is end-of-input, which exits a harness sitting on an empty prompt. A person reaching for
 * a copy or a habit must never lose a session to it, so plain `Ctrl+C`/`Ctrl+D` are REFUSED with a
 * sentence (`guardNoticeText`) and nothing is sent:
 *
 *  - `Ctrl+C` is never sent from the keyboard at all. `Ctrl+Shift+C` is COPY — the owner's choice —
 *    so the interrupt has no shifted form; `Esc` interrupts a harness without ending it.
 *  - `Ctrl+D` is sent only as `Ctrl+Shift+D`, and the terminal SAYS it was sent.
 *
 * Every other key the channel carries passes exactly as before. `Ctrl+Z` and `Ctrl+\` never reach
 * this far: the server's allowlist refuses them outright.
 */
export type ShortcutDecision =
  | 'take'      // the terminal handles it; the browser must not
  | 'leave'     // the browser keeps it
  | 'copy'      // copy the emulator's selection; send nothing
  | 'blocked-interrupt' // plain Ctrl+C with nothing selected — refused, never sent
  | 'blocked-eof'       // plain Ctrl+D — refused, never sent
  | 'confirmed-eof'     // Ctrl+Shift+D — send C-d on purpose, and say so

/**
 * `copy` means: the caller copies `term.getSelection()` itself and returns `false` from
 * `attachCustomKeyEventHandler`, so xterm sends nothing (its own key handling would otherwise turn
 * Ctrl+C into `\x03` regardless of `preventDefault`). `Ctrl+Shift+C` copies even with nothing
 * selected (it is then a no-op), because in Chrome that combination otherwise opens the element
 * inspector — and the owner named it as THE copy key here.
 */
export function shortcutDecision(e: ShortcutEvent, hasSelection = false): ShortcutDecision {
  const key = e.key.toLowerCase()
  if (e.altKey) return 'leave'
  if ((e.ctrlKey || e.metaKey) && key === 'c' && (hasSelection || (e.ctrlKey && e.shiftKey))) return 'copy'
  if (e.metaKey || !e.ctrlKey) return 'leave'
  if (key === 'c' && !e.shiftKey) return 'blocked-interrupt'
  if (key === 'd') return e.shiftKey ? 'confirmed-eof' : 'blocked-eof'
  if (e.shiftKey) return 'leave'
  return CLAIMED.has(key) ? 'take' : 'leave'
}

/** What the terminal says when it refused (or deliberately sent) a session-ending key. */
export function guardNoticeText(
  kind: 'blocked-interrupt' | 'blocked-eof' | 'confirmed-eof', lang: 'pt' | 'en',
): string {
  const pt = lang === 'pt'
  switch (kind) {
    case 'blocked-interrupt':
      return pt
        ? 'Ctrl+C está bloqueado porque encerra a sessão. Para copiar use Ctrl+Shift+C; para interromper use Esc.'
        : 'Ctrl+C is blocked because it ends the session. To copy use Ctrl+Shift+C; to interrupt use Esc.'
    case 'blocked-eof':
      return pt
        ? 'Ctrl+D está bloqueado porque encerra a sessão. Se é isso mesmo que você quer, use Ctrl+Shift+D.'
        : 'Ctrl+D is blocked because it ends the session. If that is really what you want, use Ctrl+Shift+D.'
    case 'confirmed-eof':
      return pt
        ? 'Ctrl+D enviado (Ctrl+Shift+D) — isso encerra a sessão se a linha estiver vazia.'
        : 'Ctrl+D sent (Ctrl+Shift+D) — this ends the session if the line is empty.'
  }
}
