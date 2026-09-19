import { sanitizePasteText } from '@agentistics/core'
/**
 * clipboardPaste.ts — the mobile key strip's `paste` button: read the clipboard, send it as ONE
 * paste. Not pure (it touches `navigator.clipboard`), which is why `keyStrip.ts`'s own
 * `stripEntries` takes availability as a boolean rather than importing this — a PURE module must
 * not reach for `navigator` itself.
 *
 * `navigator.clipboard.readText()` needs a secure context and, on most browsers, a permission grant
 * — exactly the reason the button is offered only when `stripAvailable()` says so, never
 * unconditionally with a button that fails silently for most visitors.
 */

/** Whether THIS browser/context can read the clipboard at all — decides whether `paste` is offered. */
export function clipboardPasteAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function'
}

/**
 * What happened when the strip's `paste` button was pressed — the button is offered only when
 * `clipboardPasteAvailable()` is true, so `readText` existing is never in question here; what is
 * still unknown until the call resolves is whether the PERMISSION PROMPT was granted.
 *
 *  - `'sent'`  — text was read and handed to `sendPaste`.
 *  - `'empty'` — the clipboard genuinely had nothing in it; not a failure, nothing to report.
 *  - `'denied'` — the read THREW: a denied/blocked permission, a revoked grant, or any other reason
 *    the browser refused the read. This is the one outcome the CALLER must turn into a sentence
 *    (I1) — otherwise a denied permission and an empty clipboard are the same "nothing happened",
 *    and a person has no way to tell "there was nothing to paste" from "the browser would not let
 *    me" from "the button is broken".
 */
export type ClipboardPasteResult = 'sent' | 'empty' | 'denied'

/**
 * Read the clipboard and hand it to `sendPaste` — an EMPTY clipboard sends nothing (there is
 * nothing to paste). A denied/failed read is never thrown to the caller (the same "the button did
 * nothing rather than crash the page" rule every strip press already follows), but IS reported back
 * as `'denied'` so the caller can show the existing `stripNote`/`ctrlNote` sentence instead of
 * leaving the tap silently inert.
 */
export async function pasteFromClipboard(sendPaste: (text: string) => void): Promise<ClipboardPasteResult> {
  let text: string
  try {
    text = await navigator.clipboard.readText()
  } catch {
    return 'denied'
  }
  // The same shared sanitizer the DOM paste path applies — a courtesy here; the server is the
  // boundary and sanitizes again. What is left empty after it is an empty paste, not a send.
  const clean = sanitizePasteText(text)
  if (!clean) return 'empty'
  sendPaste(clean)
  return 'sent'
}
