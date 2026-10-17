/**
 * overlayStack.ts — who owns Escape when overlays are stacked.
 *
 * Every dialog/drawer/screen that closes on Escape registers here while it is open; only the
 * TOP-MOST entry reacts. `stopPropagation` cannot do this job: it stops other targets, never the
 * other listeners on the same `window`, so a settings screen under a confirmation closed with it.
 */
import { useEffect, useRef } from 'react'

const stack: symbol[] = []

export function pushOverlay(): () => void {
  const id = Symbol('overlay')
  stack.push(id)
  return () => { const i = stack.indexOf(id); if (i >= 0) stack.splice(i, 1) }
}

export function isTopOverlay(id: symbol): boolean { return stack[stack.length - 1] === id }

const INNER_POPUP = '[role="listbox"],[role="menu"],[data-escape-inner]'

/** True when the Escape belongs to a popup living INSIDE the overlay (mention/autocomplete picker,
 *  combobox list, inline menu): that popup's own handler dismisses it first, the overlay closes on
 *  the next press. Decided from the DOM so every element-level handler is covered without each one
 *  having to register on the stack. */
export function innerPopupOpen(e: KeyboardEvent): boolean {
  const t = e.target
  if (!(t instanceof Element)) return false
  if (t.closest(INNER_POPUP)) return true
  if (t.getAttribute('aria-expanded') === 'true') return true
  const scope = t.closest('[role="dialog"],[role="alertdialog"]')
  return !!scope && !!scope.querySelector(INNER_POPUP)
}

/** Calls `onEscape` for an Escape keypress only while this overlay is the top-most open one.
 *  `guard` may veto (return false) without consuming ownership. */
export function useEscapeOwner(open: boolean, onEscape: () => void, guard?: () => boolean): void {
  const cb = useRef(onEscape)
  cb.current = onEscape
  const g = useRef(guard)
  g.current = guard
  useEffect(() => {
    if (!open) return
    const id = Symbol('overlay')
    stack.push(id)
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isTopOverlay(id)) return
      if (g.current && !g.current()) return
      if (innerPopupOpen(e)) return
      e.stopPropagation()
      cb.current()
    }
    window.addEventListener('keydown', h, true)
    return () => {
      window.removeEventListener('keydown', h, true)
      const i = stack.indexOf(id); if (i >= 0) stack.splice(i, 1)
    }
  }, [open])
}
