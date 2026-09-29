/**
 * How one user folder in the sessions aside is drawn, given what the list's filters left in it.
 *
 * A folder with NOTHING matching the filters (typically: every session in it is inactive while
 * "only active" is on) is DIMMED and starts folded — but it must stay a folder. It used to be
 * forced folded outright, so clicking it toggled a stored fold that was then ignored: the click did
 * nothing. Its open state is therefore its own (`openedDimmed`, per screen), separate from the
 * stored fold, and an opened dimmed folder shows what it HOLDS — showing the filtered (empty) rows
 * would open onto nothing.
 */
export interface FolderFoldInput {
  /** The person folded it (the stored per-viewer fold). */
  storedFolded: boolean
  /** The person opened it while it was dimmed. */
  openedDimmed: boolean
  /** Some filter, search or "only active" is cutting the list. */
  narrowing: boolean
  /** There is text in the search box. */
  searching: boolean
  /** Sessions in the folder (its nested folders included) that match. */
  shownCount: number
}

export interface FolderFold {
  folded: boolean
  dimmed: boolean
  /** Draw the folder's whole contents instead of the filtered ones. */
  showAll: boolean
  /** Which state a click flips. */
  toggles: 'stored' | 'dimmed'
}

export function folderFold(i: FolderFoldInput): FolderFold {
  const dimmed = i.narrowing && i.shownCount === 0
  if (dimmed) {
    return { folded: !i.openedDimmed, dimmed: true, showAll: i.openedDimmed, toggles: 'dimmed' }
  }
  // A search opens the folders that hold results without touching what the person folded.
  const folded = i.storedFolded && !(i.searching && i.shownCount > 0)
  return { folded, dimmed: false, showAll: false, toggles: 'stored' }
}
