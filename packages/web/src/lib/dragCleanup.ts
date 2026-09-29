/**
 * dragCleanup.ts — what a finished drag leaves behind, and what to do about it. PURE.
 *
 * Two leftovers were reported together (owner, 2026-09-29: "quando eu arrasto uma sessão tá ficando
 * permanente o laranja … fica uma borda laranja fixa como se eu estivesse navegando por tab"):
 *
 * 1. THE DROP HIGHLIGHT. A folder lights up orange while a session is dragged over it, and only its
 *    OWN `drop`/`dragleave` cleared that. A session dropped onto a MEMBER ROW inside a folder is
 *    handled by that row, which stops propagation — so the folder never heard the drag end and
 *    stayed orange. Every drag-highlight in the aside is therefore also cleared by ONE window-level
 *    listener for the end of ANY drag, which runs after the specific handlers and does not depend on
 *    which element received the drop.
 * 2. THE FOCUS RING. The app paints `:focus-visible` orange, and Chrome can leave the element a drag
 *    started from matching it once the drag ends — a keyboard ring with no keyboard in sight. The
 *    element is blurred then, but NEVER a text field: taking focus out of somewhere a person is
 *    typing is worse than a ring.
 */
export function blurAfterDrag(el: { tagName: string; isContentEditable?: boolean } | null): boolean {
  if (!el) return false
  if (el.isContentEditable) return false
  const tag = el.tagName.toUpperCase()
  return tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && tag !== 'BODY'
}
