/**
 * popoverScroll — whether a scroll event should close a portaled popover panel.
 *
 * A capture-phase `window` scroll listener is the usual way to close a popover on page/ancestor
 * scroll — a panel that has drifted away from the control it belongs to is worse than one that
 * closed. But capture phase means the listener ALSO fires when the panel's OWN scrollable content
 * scrolls (reaching a row past the fold, or a keyboard/assistive scroll-into-view), and closing on
 * that beats the very click that was heading there — anything below the fold becomes unreachable.
 *
 * The panels this guards (`PickerMenu`, `BoardArrange`, `ColumnSortMenu`, `ChipSelect`) are
 * PORTALED (`createPortal` into `document.body`), so the panel is never a DOM descendant of its
 * trigger — the "is this scroll mine" check has to be made against the PANEL's own element, never a
 * wrapper around the trigger. Contrast `Select` in `settings/primitives.tsx`, whose panel is an
 * in-flow child of the trigger's own wrapper `div` and can therefore test that wrapper alone.
 */
export function scrollIsOutside(panel: Node | null, target: EventTarget | null): boolean {
  if (!panel) return true
  if (target == null) return true
  return !panel.contains(target as Node)
}

/** How long after a wheel/touch/key gesture a scroll still counts as the person's own. */
export const USER_SCROLL_WINDOW_MS = 700

/**
 * A popover may close on a scroll only when the PERSON scrolled: some scroller outside it moved within
 * `USER_SCROLL_WINDOW_MS` of a wheel / touch / key gesture. A scroll with no gesture behind it is the page
 * moving on its own — a conversation following a message that just arrived — and must never close a popup the
 * person is reading (owner, 10/11: "isso não pode acontecer"). `lastGestureAt` is `null` before any gesture.
 */
export function scrollClosesPopover(panel: Node | null, target: EventTarget | null, lastGestureAt: number | null, now: number): boolean {
  if (!scrollIsOutside(panel, target)) return false
  return lastGestureAt !== null && now - lastGestureAt <= USER_SCROLL_WINDOW_MS
}
