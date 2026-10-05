/**
 * focusComposer — the "Comentar" button at the TOP of a long comment list: bring the composer into view
 * and put the caret in it, so writing a comment never means scrolling to the end of the page first.
 * Returns whether a composer was found (a list with no composer has nothing to focus).
 */
export function focusComposer(root: ParentNode | null): boolean {
  const ta = root?.querySelector<HTMLTextAreaElement>('[data-comment-composer] textarea') ?? null
  if (!ta) return false
  ta.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  ta.focus({ preventScroll: true })
  return true
}
