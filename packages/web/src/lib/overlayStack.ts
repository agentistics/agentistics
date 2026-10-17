/**
 * overlayStack.ts — the ONE owner of Escape-to-dismiss.
 *
 * Every thing that dismisses on Escape — a dialog, a drawer, a Nay screen, a Select/MultiPicker
 * list, a mention/autocomplete picker, an inline menu or popover, an inline rename field — registers
 * here while it is open, with its own close callback. ONE window-level capture listener answers
 * Escape: it closes the TOP entry and consumes the key. Nothing else listens for Escape to dismiss.
 *
 * The rule is deliberately dumb. An earlier version let the owner "yield" when the DOM suggested an
 * inner popup would handle the key itself; that deadlocked twice (a picker yielding to its own
 * search field, a dialog yielding to a picker whose handler lived on an element that never got the
 * event). Here the top entry always closes, so Escape can never be swallowed by nobody, and the
 * innermost thing opened last always goes first.
 *
 * Order is chronological: an entry opened later sits above one opened earlier. A popup is opened
 * by a gesture made inside an overlay that is already open, so "last opened" is "innermost". The one
 * case that rule does not cover is a parent and a child that both mount ALREADY OPEN in the same
 * commit: React runs the child's effect first, so the parent lands on top. Nothing in the app does
 * that today; a component that must, opens its inner piece after mount.
 *
 * NOT dismissals, and so NOT on the stack (they keep their own local handlers): the composer's
 * Escape-to-stop verb (SessionChat), the task table's Select-mode exit (TaskTable/selection.ts),
 * terminal key forwarding (terminalKeys/keyStrip), the magnifier's keyboard deselect, IME
 * composition (`isComposing`), and any key pressed inside Monaco or a terminal (`ESCAPE_LOCAL`).
 * Because the listener runs in the capture phase at `window`, those local handlers only see Escape
 * when nothing is registered — which is the point: an open popup closes before a verb fires.
 */
import { useEffect, useRef } from 'react'

interface Entry { close: () => void; guard?: () => boolean }

const stack: Entry[] = []

/** Where Escape is never a dismissal: Monaco (it closes its own suggest widget, clears a
 *  multi-cursor) and the session terminal (the key belongs to the program running in it — vim).
 *  `data-escape-local` marks any other such surface. Named here, not inferred. */
const ESCAPE_LOCAL = '.monaco-editor, .xterm, [data-escape-local]'

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.isComposing) return
  const t = e.target
  if (t instanceof Element && t.closest(ESCAPE_LOCAL)) return
  const top = stack[stack.length - 1]
  if (!top) return
  e.preventDefault()
  e.stopPropagation()
  // A guard that says "not now" (a dialog mid-save) still OWNS the key: falling through to the
  // overlay beneath would close something the person was not looking at.
  if (top.guard && !top.guard()) return
  top.close()
}

/** (Re)binds the one listener. Idempotent — the same function and phase are never added twice —
 *  and done on every push so a replaced `window` (a test environment re-created) is covered too. */
function bind(): void {
  if (typeof window === 'undefined') return
  window.removeEventListener('keydown', onKeyDown, true)
  window.addEventListener('keydown', onKeyDown, true)
}

/** Registers an Escape-dismissable overlay; returns the function that removes it. */
export function pushOverlay(close: () => void, guard?: () => boolean): () => void {
  bind()
  const entry: Entry = { close, guard }
  stack.push(entry)
  return () => { const i = stack.indexOf(entry); if (i >= 0) stack.splice(i, 1) }
}

/** How many overlays are registered — for tests. */
export function overlayDepth(): number { return stack.length }

/** Registers while `open`; Escape calls `onEscape` when this is the top-most open overlay.
 *  `guard` returning false keeps the overlay open but still consumes the key. */
export function useEscapeOwner(open: boolean, onEscape: () => void, guard?: () => boolean): void {
  const cb = useRef(onEscape)
  cb.current = onEscape
  const g = useRef(guard)
  g.current = guard
  useEffect(() => {
    if (!open) return
    return pushOverlay(() => cb.current(), () => (g.current ? g.current() : true))
  }, [open])
}
