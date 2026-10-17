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
