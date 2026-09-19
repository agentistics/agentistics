/**
 * useElementWidth — the live width of one DOM box, via `ResizeObserver` (design item 7: "below
 * ~1100px wide collapse tab labels to icons").
 *
 * The bottom bar's own width is not the window's: a session opened beside the fleet aside and a
 * right-slot panel can each take a third of the screen, so the bar's own box can cross the 1100px
 * threshold at a window width where `useIsMobile`'s single breakpoint would still read "desktop,
 * plenty of room". This measures the element the caller actually cares about, the same
 * `ResizeObserver`-on-a-ref-callback shape `SessionPanel.tsx`'s own `measureColumn` and
 * `SessionsPage.tsx`'s own `splitRoom` already use for the analogous height/width questions.
 *
 * Returns `0` until the first measurement lands — callers that gate a narrower reading on "width is
 * below N" must treat `0` as "not measured yet, assume wide" (i.e. `width > 0 && width < N`), or the
 * very first frame renders compact before anything has been measured at all.
 */

import { useCallback, useRef, useState } from 'react'

export function useElementWidth(): [(el: HTMLElement | null) => void, number] {
  const [width, setWidth] = useState(0)
  const observer = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (el === null) return
    setWidth(el.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width
      if (w !== undefined) setWidth(w)
    })
    ro.observe(el)
    observer.current = ro
  }, [])
  return [ref, width]
}
