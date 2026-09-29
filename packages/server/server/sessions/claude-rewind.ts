/**
 * claude-rewind.ts — PURE: reading claude's own Rewind menu off the screen.
 *
 * "Restore the conversation from point X" is claude's own feature (Esc Esc in its terminal), so
 * agentop drives it rather than re-implementing it. Measured on claude 2.1.284, 2026-09-29, on a
 * probe session:
 *
 *   Esc Esc (ONE burst; two separate sends 300 ms apart did not open it) draws
 *
 *        Rewind
 *        Restore and fork the conversation to the point before…
 *          ↑ 4 more above
 *          REWIND-ONE responda apenas: um
 *        ❯ REWIND-TWO responda apenas: TWO
 *          (current)
 *        Enter to continue · Esc to cancel
 *
 *   - one row per PROMPT the person sent, oldest first, then `(current)`, where the cursor starts;
 *   - it SCROLLS (`↑ N more above`), so the target cannot be found by counting — the highlighted row
 *     is re-read after every ↑ and compared;
 *   - Enter on a prompt restores the conversation to the point BEFORE it and puts that prompt back in
 *     the input box. The conversation id does not change (the transcript is appended to; the
 *     abandoned turns stay in the file — see the chat reader's active-branch rule).
 *   - with files edited after that point, the restore still took one Enter in the measurement; a
 *     SECOND screen was never seen, so if one appears the driver cancels and says so rather than
 *     guessing which of its options is the harmless one.
 */

export interface RewindMenu {
  /** The prompts listed on screen, top to bottom — not necessarily all of them (it scrolls). */
  items: string[]
  /** Index into `items` of the highlighted row; `items.length` means `(current)`; `null` unknown. */
  cursor: number | null
  /** The list is scrolled: more prompts exist above the first listed one. */
  moreAbove: boolean
}

const HEADER = /Restore and fork the conversation to the point before/
const FOOTER = /Enter to continue · Esc to cancel/
const MORE_ABOVE = /↑ \d+ more above/
const MORE_BELOW = /↓ \d+ more below/
const CURRENT = /^\(current\)$/

/** The menu on screen, or `null` when the frame is not claude's Rewind menu. */
export function parseRewindMenu(frame: readonly string[]): RewindMenu | null {
  const lines = frame.map(l => l.replace(/\s+$/, ''))
  const h = lines.findIndex(l => HEADER.test(l))
  if (h < 0) return null
  let f = -1
  for (let i = lines.length - 1; i > h; i--) if (FOOTER.test(lines[i]!)) { f = i; break }
  if (f < 0) return null
  const items: string[] = []
  let cursor: number | null = null
  let moreAbove = false
  for (const raw of lines.slice(h + 1, f)) {
    if (raw.trim() === '') continue
    if (MORE_ABOVE.test(raw)) { moreAbove = true; continue }
    if (MORE_BELOW.test(raw)) continue
    const selected = /^\s*❯\s/.test(raw)
    const text = raw.replace(/^\s*❯?\s*/, '').trim()
    if (CURRENT.test(text)) {
      if (selected) cursor = items.length
      continue
    }
    if (selected) cursor = items.length
    items.push(text)
  }
  return { items, cursor, moreAbove }
}

/** Whitespace-collapsed, trailing ellipsis dropped — how a menu row is compared to a prompt. */
function norm(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/…$/, '').trim()
}

/**
 * Does this menu row stand for this prompt? A row is the prompt's FIRST LINE, possibly cut with `…`,
 * so the row must be a non-empty prefix of the prompt's first line (or equal to it).
 */
export function rewindRowMatches(row: string, prompt: string): boolean {
  const r = norm(row)
  const firstLine = norm(prompt.split('\n').find(l => l.trim() !== '') ?? '')
  if (r === '' || firstLine === '') return false
  return firstLine === r || firstLine.startsWith(r)
}

/** The highlighted row's text, or `null` when the cursor is on `(current)` or unknown. */
export function highlightedRow(menu: RewindMenu): string | null {
  if (menu.cursor === null || menu.cursor >= menu.items.length) return null
  return menu.items[menu.cursor] ?? null
}

/** How many ↑ presses a driver may spend before concluding the prompt is not in the menu. */
export const REWIND_MAX_STEPS = 400
