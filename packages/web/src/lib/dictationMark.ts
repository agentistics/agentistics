/**
 * dictationMark.ts — PURE: telling the model a message was DICTATED, in as few tokens as possible.
 *
 * Speech recognition gets names and jargon wrong ("harness" arrives as something else), and a model
 * that knows a message was transcribed reads a strange word as a mishearing instead of taking it
 * literally (owner, 2026-09-29). The signal is one short line at the END of the message — never the
 * start, where the composer puts a quoted reply and a leading token would break the blockquote — and
 * it is never shown to the person: every surface that draws a message strips it, and the bubble says
 * "dictated" with an icon instead.
 */

/** The line appended to a dictated message. Short, and self-explanatory to a model. */
export const DICTATED_MARK = '[dictated]'

const TRAILING = /\n?\[dictated\]\s*$/

/** The message as sent: the text, then the mark on its own line. Idempotent. */
export function markDictated(text: string): string {
  return TRAILING.test(text) ? text : `${text}\n${DICTATED_MARK}`
}

/** The message as shown: the mark removed, and whether it was there. */
export function stripDictatedMark(text: string): { text: string; dictated: boolean } {
  return TRAILING.test(text) ? { text: text.replace(TRAILING, ''), dictated: true } : { text, dictated: false }
}
