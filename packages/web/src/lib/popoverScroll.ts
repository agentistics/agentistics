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
