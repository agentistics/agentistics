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
  | 'paste'     // let the browser's paste event carry the clipboard; xterm must not add \x16
  | 'word-delete'       // Ctrl+Backspace — the word delete the browser lets a page have (see below)
  | 'blocked-interrupt' // plain Ctrl+C with nothing selected — refused, never sent
  | 'blocked-eof'       // plain Ctrl+D — refused, never sent
  | 'confirmed-eof'     // Ctrl+Shift+D — send C-d on purpose, and say so

/**
 * `copy` means: the caller copies `term.getSelection()` itself and returns `false` from
 * `attachCustomKeyEventHandler`, so xterm sends nothing (its own key handling would otherwise turn
 * Ctrl+C into `\x03` regardless of `preventDefault`). `Ctrl+Shift+C` copies even with nothing
 * selected (it is then a no-op), because in Chrome that combination otherwise opens the element
 * inspector — and the owner named it as THE copy key here.
 *
 * `paste`: the clipboard travels through the DOM `paste` event (`SessionTerminal`'s capture
 * listener), but xterm ALSO turned Ctrl+V into the control byte `\x16`, which the allowlist refuses
 * — so every paste came with a red "mixes text with a control key" line under it. The caller returns
 * `false` WITHOUT `preventDefault`: xterm emits nothing, the browser still pastes.
 *
 * `word-delete`: `Ctrl+W` is one of the few keys a browser never lets a page intercept (it closes
 * the tab before any script runs), so it cannot be the way to delete a word here. `Ctrl+Backspace`
 * is not reserved, and sends the same `C-w`.
 */
export function shortcutDecision(e: ShortcutEvent, hasSelection = false): ShortcutDecision {
  const key = e.key.toLowerCase()
  if (e.altKey) return 'leave'
  if ((e.ctrlKey || e.metaKey) && key === 'c' && (hasSelection || (e.ctrlKey && e.shiftKey))) return 'copy'
  if (e.metaKey || !e.ctrlKey) return 'leave'
  if (key === 'v') return 'paste'
  if (key === 'backspace' && !e.shiftKey) return 'word-delete'
  if (key === 'c' && !e.shiftKey) return 'blocked-interrupt'
  if (key === 'd') return e.shiftKey ? 'confirmed-eof' : 'blocked-eof'
  if (e.shiftKey) return 'leave'
  return CLAIMED.has(key) ? 'take' : 'leave'
}

/** How a confirmation reads: `info` is a plain confirmation, `warn` a refusal, `danger` a
 *  session-ending key that WAS sent. */
export type NoticeTone = 'info' | 'warn' | 'danger'

export type NoticeKind =
  | 'blocked-interrupt' | 'blocked-eof' | 'confirmed-eof'
  | 'copied' | 'copy-empty' | 'pasted' | 'word-delete'
  | 'C-a' | 'C-e' | 'C-u' | 'C-w' | 'C-k' | 'C-l'

export const NOTICE_TONE: Record<NoticeKind, NoticeTone> = {
  'blocked-interrupt': 'warn', 'blocked-eof': 'warn', 'confirmed-eof': 'danger',
  copied: 'info', 'copy-empty': 'info', pasted: 'info', 'word-delete': 'info',
  'C-a': 'info', 'C-e': 'info', 'C-u': 'info', 'C-w': 'info', 'C-k': 'info', 'C-l': 'info',
}

/**
 * EVERY COMMAND TYPED INTO THE TERMINAL IS CONFIRMED IN WORDS (owner, 2026-09-27: "todos comandos
 * executados deveriam ter uma confirmacao via mensagem"). A control key changes what is on the
 * other side without printing anything recognisable, so without a sentence the reader cannot tell a
 * key that landed from one that did nothing. `n` is the count a copy or a paste carried.
 */
export function guardNoticeText(kind: NoticeKind, lang: 'pt' | 'en', n?: number): string {
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
    case 'copied':
      return pt ? `Copiado — ${n ?? 0} caracteres.` : `Copied — ${n ?? 0} characters.`
    case 'copy-empty':
      return pt ? 'Nada selecionado para copiar — selecione com o mouse e use Ctrl+Shift+C.'
        : 'Nothing selected to copy — select with the mouse and use Ctrl+Shift+C.'
    case 'pasted':
      return pt ? `Colado — ${n ?? 0} ${n === 1 ? 'linha' : 'linhas'}.` : `Pasted — ${n ?? 0} ${n === 1 ? 'line' : 'lines'}.`
    case 'word-delete':
    case 'C-w':
      return pt ? 'Palavra anterior apagada (Ctrl+Backspace — o navegador reserva Ctrl+W para fechar a aba).'
        : 'Previous word deleted (Ctrl+Backspace — the browser keeps Ctrl+W for closing the tab).'
    case 'C-a': return pt ? 'Cursor no início da linha (Ctrl+A).' : 'Cursor to the start of the line (Ctrl+A).'
    case 'C-e': return pt ? 'Cursor no fim da linha (Ctrl+E).' : 'Cursor to the end of the line (Ctrl+E).'
    case 'C-u': return pt ? 'Linha apagada (Ctrl+U).' : 'Line cleared (Ctrl+U).'
    case 'C-k': return pt ? 'Apagado até o fim da linha (Ctrl+K).' : 'Deleted to the end of the line (Ctrl+K).'
    case 'C-l': return pt ? 'Tela limpa (Ctrl+L).' : 'Screen cleared (Ctrl+L).'
  }
}
