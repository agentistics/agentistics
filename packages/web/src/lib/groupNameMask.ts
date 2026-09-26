/**
 * groupNameMask.ts — PURE. Hiding a group's name, the way a bank app hides a balance.
 *
 * A group is named for what is in it ("Pelvie", "Saved to later"), and a sidebar is often on a shared
 * screen. "Hide name" is per group and per viewer, and it has to hold EVERYWHERE the name would be
 * printed as text, or the setting is a promise the next menu breaks.
 *
 * Two treatments, because two places draw it differently:
 * - the group's own HEADER keeps the name in the layout and paints a grey block over exactly its
 *   width (`.ag-name-mask`, `index.css`), so the block is as long as the name and nothing around it
 *   shifts;
 * - a MENU ENTRY or a sentence has no room for a block, so it prints dots. The count is CLAMPED: a
 *   dot per letter of a long name would print the length to the character, and a one-letter name
 *   would print as a single dot, which says how short it is.
 */

export const MIN_MASK_DOTS = 4
export const MAX_MASK_DOTS = 12

/** `Pelvie` -> `••••••`. Never fewer than 4 dots and never more than 12. */
export function maskedText(name: string): string {
  const n = Math.min(MAX_MASK_DOTS, Math.max(MIN_MASK_DOTS, [...name.trim()].length))
  return '•'.repeat(n)
}

/** The name to PRINT: the real one, or its mask when this group is hidden. */
export function displayName(name: string, hidden: boolean): string {
  return hidden ? maskedText(name) : name
}

/** Toggle one group id in a set of hidden ids — returns a NEW set. */
export function toggleHidden(hidden: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(hidden)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}
