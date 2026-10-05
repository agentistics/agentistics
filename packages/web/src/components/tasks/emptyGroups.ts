/**
 * emptyGroups.ts — "Show all / Hide empty groups" for the board and the table (PURE).
 *
 * A pipeline of seven statuses with work in two of them is five blank columns. The setting hides a group
 * with NOTHING in it; it never hides a group that holds work, and it is a VIEW choice only — the stored
 * `groups` / `columns` the person picked are untouched, so switching back to "Show all" restores exactly
 * what they had. Counted against what is ON SCREEN (after the search and filters), not against the store:
 * a group emptied by a search is empty to the person looking.
 */
export function dropEmpty<T>(items: readonly T[], countOf: (item: T) => number, hide: boolean): T[] {
  return hide ? items.filter(i => countOf(i) > 0) : [...items]
}

/** The board: a column is empty only when EVERY lane is empty in it (a lane's blank cell is not a blank column). */
export function emptyColumns(lanes: readonly { columns: readonly { status: string; rows: readonly unknown[] }[] }[], statuses: readonly string[]): Set<string> {
  const filled = new Set<string>()
  for (const l of lanes) for (const c of l.columns) if (c.rows.length > 0) filled.add(c.status)
  return new Set(statuses.filter(s => !filled.has(s)))
}
