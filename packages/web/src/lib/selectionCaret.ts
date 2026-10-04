/**
 * selectionCaret.ts — PURE: when a selection change in the composer is worth a re-render.
 *
 * Owner report, 2026-10-04 (iPhone): copying text out of the composer was "very hard". The field's
 * `onSelect` set the tracked caret on EVERY selection change. While a person drags iOS's selection
 * handles, `select` fires continuously, and each call re-rendered the whole session chat. On a
 * phone that stalls the very gesture being made, and the handles and the Copy menu lag or drop.
 *
 * The tracked caret exists for one job: reading the `/`, `@` or `#` trigger from the text BEFORE a
 * caret. A RANGED selection has no caret to read a trigger from, so it changes nothing: `null` here,
 * and no state is written while text is being selected.
 */
export function caretOfSelection(start: number | null, end: number | null): number | null {
  if (start === null || end === null) return null
  return start === end ? start : null
}
