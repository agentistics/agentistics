/**
 * titleBreaks.ts — where a long session title may break WITHOUT cutting a word in half.
 *
 * Titles here are often one long token ("MODO.AUTONOMO-SIMPLES", "AGENTASK.sessions_filter"), and a
 * list row is narrow: `overflow-wrap: anywhere` split them mid-word ("AUTONO/MO"). A word break needs
 * a break OPPORTUNITY, and the browser only offers one after a space or a hyphen — so one is offered
 * after `.`, `_`, `/`, `:` and `+` too (a `<wbr>`, which adds no character and so changes nothing a
 * reader copies or searches). Only a token that still cannot fit its row falls back to breaking.
 */

/** The characters a title may break after. */
const BREAK_AFTER = /[._/:+]/

/** PURE. The title as text pieces; a boundary between two consecutive pieces is a break opportunity. */
export function titlePieces(title: string): string[] {
  const out: string[] = []
  let start = 0
  for (let i = 0; i < title.length - 1; i++) {
    const c = title[i]!, next = title[i + 1]!
    // After the mark, and only before another non-space, non-mark character: "a.b" breaks, "a. b", "a.." do not add one.
    if (BREAK_AFTER.test(c) && !/\s/.test(next) && !BREAK_AFTER.test(next)) { out.push(title.slice(start, i + 1)); start = i + 1 }
  }
  out.push(title.slice(start))
  return out
}
