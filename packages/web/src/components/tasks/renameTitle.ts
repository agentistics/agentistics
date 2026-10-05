/**
 * renameTitle.ts — what a rename may write, as pure rules (the inline editors draw; this decides).
 *
 * A task's title is its name on every surface, so the rules are the strict ones: the text is TRIMMED, an
 * EMPTY title is refused (the server also ignores one — a rename to nothing would look like it worked and
 * change nothing), and a title that did not change is not a write (no activity-log entry, no reload).
 */
export const TITLE_MAX = 200

/** The title to PATCH, or `null` when there is nothing to write (blank, unchanged). */
export function planRename(current: string, draft: string): string | null {
  const next = draft.trim().replace(/\s+/g, ' ').slice(0, TITLE_MAX)
  if (!next || next === current.trim()) return null
  return next
}

/** What a key does inside the editor. */
export function renameKey(key: string): 'save' | 'cancel' | null {
  if (key === 'Enter') return 'save'
  if (key === 'Escape') return 'cancel'
  return null
}
