/**
 * pasteSanitize.ts — the ONE place a clipboard paste is neutralized before it reaches a pane.
 *
 * WHY THIS EXISTS: the `paste` message kind (`input-protocol.ts` on the server,
 * `SessionTerminal.tsx`'s DOM `paste` interceptor on the client) accepted any clipboard text up to
 * `MAX_PASTE_TEXT` verbatim. That text is written into a tmux buffer and delivered with
 * `tmux paste-buffer -p`, which wraps it in the bracketed-paste markers `\x1b[200~ … \x1b[201~` so
 * the program in the pane can tell "this is a paste" from "this was typed" — but tmux does NOT
 * escape an occurrence of the END marker (`\x1b[201~`) already inside the buffer (documented
 * `paste-buffer(1)` behaviour). A clipboard payload that plants `\x1b[201~touch /tmp/marker\r`
 * therefore closes the bracketed paste EARLY, in the target pane, and everything after the marker —
 * including the trailing `\r` — is read as ordinary, unconfirmed keystrokes and EXECUTED. Reproduced
 * live against both the Shell and the assistant terminal (they share the same server primitive,
 * `backend-tmux.ts`'s `sendPaste`), so this is a real command-injection path, not a theoretical one:
 * any web page the user visits can put this exact byte sequence on the OS clipboard with an ordinary
 * `navigator.clipboard.writeText(...)`, and any text copied from somewhere that happens to contain it
 * (a rendered code block, a chat log, a file) triggers it the moment it is pasted into either
 * terminal.
 *
 * This module is the fix, and it is deliberately a SANITIZER, not a refusal — the brief for this fix
 * asks for the payload to be made harmless, not for the paste to be bounced back to the user with a
 * reason code. Two steps, in order:
 *
 *   1. Remove every occurrence of the bracketed-paste markers `\x1b[200~` / `\x1b[201~`, REPEATEDLY
 *      (in effect — see `stripBracketedPasteMarkers`'s single linear pass below) until none remain.
 *      A single non-repeating pass is not enough: a marker SPLIT across two fragments that
 *      individually contain no marker can REFORM one once the text between them is deleted —
 *      `"\x1b[20" + "\x1b[201~" + "1~"` has no marker as three pieces, but deleting the middle
 *      `\x1b[201~` leaves `"\x1b[20" + "1~"` = `"\x1b[201~"`, a fresh occurrence sitting exactly
 *      where the deleted one was.
 *   2. Neutralize every OTHER C0 control character and DEL, except `\t`, `\n` and `\r` — a paste is
 *      a person's clipboard text, and those three are the only control bytes ordinary text
 *      legitimately carries (a tab, a line ending). Everything else in the C0/DEL range (Ctrl-key
 *      bytes such as `\x03`/`\x04`, a raw `\x1b` that is not part of a bracketed-paste marker, …)
 *      is STRIPPED rather than replaced with a placeholder: a placeholder character is itself a
 *      byte the person did not type, and for a control byte with no printable form there is no
 *      substitute that reads as "this used to be something" without being noise on every legitimate
 *      paste that happens to carry, say, a stray NUL from a binary clipboard. Stripping is also what
 *      keeps a LEGITIMATE multi-line paste (text + `\t`/`\n`/`\r` only) byte-for-byte unchanged,
 *      which is the one thing this function must never alter.
 *
 * Because step 2 also removes any bare `\x1b` that step 1 did not consume as part of a full 6-byte
 * marker, the two steps together guarantee the OUTPUT can never contain an escape sequence, a
 * Ctrl-key byte, or an ESC — the exact guarantee the fix brief states, independent of which step
 * would have caught a given input on its own.
 *
 * Pure and dependency-free, so the SAME function runs on the server (the authority — this is the
 * check that actually matters) and on the client (a courtesy: refusing earlier is a better UX, but
 * the server never trusts it). One implementation, or the two could disagree about what "sanitized"
 * means.
 */

/** The bracketed-paste START and END markers. Each is exactly 6 UTF-16 code units: `\x1b` + `[` +
 *  three digits + `~`. Both are stripped — the START marker cannot itself break anything out (only
 *  an unescaped END marker inside the buffer can), but a payload should never be able to plant
 *  EITHER half of the pair the server's own `tmux paste-buffer -p` wraps it in. */
const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'
const MARKER_LEN = BRACKETED_PASTE_START.length // === BRACKETED_PASTE_END.length === 6

/**
 * Remove every occurrence of the bracketed-paste markers, including ones that only exist because an
 * earlier removal spliced two fragments together — in ONE linear pass, not a naive loop-until-stable
 * over a global replace (which is O(n²) on an adversarial input built to maximize reformation
 * rounds, on a payload that can be up to `MAX_PASTE_TEXT` bytes).
 *
 * Classic stack technique: build the output one code point at a time, and after each push check
 * whether the last `MARKER_LEN` code points of the OUTPUT SO FAR form a marker; if they do, pop them
 * back off instead of keeping them. Because the check re-runs against the output (not the original
 * input) after every single push, a marker that only becomes contiguous once an earlier one was
 * removed is caught the moment it forms — the nested/split case above is handled by this in one pass,
 * with no repeated whole-string rescans.
 */
function stripBracketedPasteMarkers(text: string): string {
  const out: string[] = []
  // Iterate by code point (handles a surrogate pair as one unit); the markers are pure ASCII so this
  // never splits one, and it matches `isAllPrintable`'s own iteration style elsewhere in this system.
  for (const ch of text) {
    out.push(ch)
    if (out.length >= MARKER_LEN) {
      const tail = out.slice(out.length - MARKER_LEN).join('')
      if (tail === BRACKETED_PASTE_START || tail === BRACKETED_PASTE_END) {
        out.length -= MARKER_LEN
      }
    }
  }
  return out.join('')
}

/** Every C0 control byte and DEL, EXCEPT the three a legitimate paste carries: `\t` (0x09), `\n`
 *  (0x0A) and `\r` (0x0D). This also matches a bare `\x1b` that was not part of a 6-byte marker —
 *  see the module header for why that is exactly the second half of the guarantee. */
// C0 controls except \t \n \r, DEL, and the C1 range U+0080–U+009F: U+009B is the 8-bit CSI, the
// single-character spelling of ESC [, which a terminal configured for 8-bit controls would parse as the
// start of a sequence — so a paste could still carry one after every ESC was removed.
const OTHER_CONTROL_BYTES = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g

/**
 * The one function both the server (`input-protocol.ts`) and the client
 * (`SessionTerminal.tsx`'s paste interceptor) call before a clipboard payload goes anywhere. See the
 * module header for the two steps and why each is necessary.
 */
export function sanitizePasteText(text: string): string {
  return stripBracketedPasteMarkers(text).replace(OTHER_CONTROL_BYTES, '')
}
