/**
 * viewportReset.ts — PURE: may the document's scroll be put back to zero right now?
 *
 * ## Why this is an INVARIANT and not another event
 *
 * Seven attempts have been made at the phone's composer coming back out of place, and every one of
 * them — including the reverted five and the two that shipped — was EVENT-DRIVEN: snapshot on
 * `focusin`, restore when some signal says the keyboard has gone. The signal is the weak part. The
 * trigger in `App.tsx` is the visible band growing back, because `focusout` does not fire when iOS
 * dismisses the keyboard with the accessory bar's ✓; but a page running as an installed app can
 * have its LAYOUT viewport resized instead, in which case `visualViewport.height` never shrinks
 * against the remembered tall value and the restore is never reached at all. Reported as "o input
 * continua flutuando e acredito que vai continuar".
 *
 * There is a fact about this screen that needs no event: **the sessions workspace cannot scroll.**
 * It is a `100dvh` column whose conversation, list and aside each scroll inside themselves, so the
 * DOCUMENT has nothing to move. Any `scrollY` in it is iOS's caret scroll left behind — which is
 * exactly the displacement being reported, and it moves `#root`, which is the containing block
 * every `position: fixed` descendant answers to on this layout. That is why the composer and the
 * bottom bar float TOGETHER, and why leaving the route and coming back puts both right.
 *
 * So instead of waiting for the keyboard to announce itself: whenever nothing is being typed into,
 * the document's scroll must be zero. Checked on the signals that DO arrive — a scroll, a viewport
 * change, a blur — and correct even if only one of them ever does.
 *
 * ## The three guards, each of which can veto on its own
 *
 * 1. **Nothing is focused.** While a field has the caret, iOS is holding it in view and that scroll
 *    is what carries the composer above the keyboard. Cancelling it there was tried and reverted
 *    inside the hour: "o input tá ficando fixo lá embaixo e agora eu nem consigo ver ele quando o
 *    teclado abre". This never fights the keyboard; it only cleans up after it.
 * 2. **The document genuinely cannot scroll.** If the page really is taller than the viewport, the
 *    scroll belongs to the reader and is not ours to reset. A slack absorbs sub-pixel layout.
 * 3. **There is something to undo.** `scrollY <= 0` is already right, and writing to it anyway
 *    would fight a rubber-band mid-gesture.
 */

export interface ViewportResetInput {
  /** `window.scrollY`. */
  scrollY: number
  /** `document.documentElement.scrollHeight`. */
  scrollHeight: number
  /** `document.documentElement.clientHeight`. */
  clientHeight: number
  /** Is an input, textarea or contenteditable holding the focus right now? */
  editableFocused: boolean
}

/**
 * How much taller than the viewport the document may be and still count as "cannot scroll".
 *
 * Sub-pixel heights and a rounded `dvh` leave a pixel or two routinely; a real scrollable page is
 * hundreds. Anything in between is not a case this has seen, and erring SMALL is the safe
 * direction: the cost of not resetting is the bug staying, the cost of resetting a page that could
 * scroll is throwing away where somebody was reading.
 */
export const SCROLLABLE_SLACK = 4

export function shouldResetDocumentScroll(i: ViewportResetInput): boolean {
  if (i.editableFocused) return false
  if (i.scrollY <= 0) return false
  return i.scrollHeight <= i.clientHeight + SCROLLABLE_SLACK
}

/**
 * The two displacements `shouldResetDocumentScroll` cannot see, because both leave `scrollY` at 0.
 *
 * 1. **The VISUAL viewport stays panned** (`visualViewport.offsetTop > 0`) after the keyboard has
 *    gone. iOS pans it to keep the caret in view, and when the layout viewport never scrolled there
 *    is no `scrollY` to reset — the guard above answers "nothing to undo" and the page stays lifted.
 * 2. **An installed app's layout viewport stays SHORT** (`innerHeight` below the tallest this page
 *    has seen) after the keyboard has gone. Everything pinned to the bottom — the composer, the
 *    bottom nav — then sits as high as it did over the keyboard until something forces a relayout,
 *    which is why visiting another route "fixed" it.
 *
 * In both cases a `scrollTo(0, 0)` makes iOS recompute the viewport, and on a document that cannot
 * scroll it moves nothing a reader owns. The same guards as above apply: never while a field has
 * the caret (that pan is what carries the composer above the keyboard), and only on a document that
 * genuinely cannot scroll.
 */
export interface ViewportNudgeInput {
  editableFocused: boolean
  scrollHeight: number
  clientHeight: number
  /** `visualViewport.offsetTop`, or 0 where there is no visualViewport. */
  offsetTop: number
  innerHeight: number
  /** The tallest `innerHeight` this page has seen with nothing focused. */
  tallestInnerHeight: number
}

/** How far short the layout viewport may be before it counts as left behind by the keyboard. */
export const SHORT_VIEWPORT_SLACK = 40

export function shouldNudgeViewport(i: ViewportNudgeInput): boolean {
  if (i.editableFocused) return false
  if (i.scrollHeight > i.clientHeight + SCROLLABLE_SLACK) return false
  if (i.offsetTop > 0.5) return true
  return i.tallestInnerHeight - i.innerHeight >= SHORT_VIEWPORT_SLACK
}
