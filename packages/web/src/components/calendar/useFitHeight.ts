import { useLayoutEffect, useRef, useState } from 'react'
import { fitHeight, holdPageFit, reserveBelow } from '../../lib/pageFit'

/**
 * The height a page-sized surface may take: what is LEFT of the page's own scroller below the element, so the
 * calendar fills the screen and the page itself never scrolls (the same measurement the Live line makes —
 * `lib/pageFit.ts` — so the two cannot disagree about the panel frame's padding). Outside the app shell (no scroller) the
 * window is the box.
 */
export function useFitHeight<T extends HTMLElement>(min = 420, dep: unknown = null, enabled = true): { ref: React.RefObject<T | null>; height: number | null } {
  const ref = useRef<T | null>(null)
  const [height, setHeight] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (!enabled) return
    const measure = () => {
      const el = ref.current
      if (!el) return
      const win = el.ownerDocument.defaultView ?? window
      const scroller = el.closest<HTMLElement>('[data-page-scroller]')
      const top = el.getBoundingClientRect().top
      if (scroller) {
        const ancestors: CSSStyleDeclaration[] = []
        for (let a = el.parentElement; a && a !== scroller; a = a.parentElement) ancestors.push(getComputedStyle(a))
        setHeight(fitHeight({ scrollerBottom: scroller.getBoundingClientRect().bottom, boardTop: top, reserve: reserveBelow(ancestors), min }))
      } else {
        const zoom = Number(getComputedStyle(win.document.documentElement).getPropertyValue('--ui-zoom')) || 1
        setHeight(fitHeight({ scrollerBottom: win.innerHeight / zoom, boardTop: top, reserve: 16, min }))
      }
    }
    measure()
    const scroller = ref.current?.closest<HTMLElement>('[data-page-scroller]') ?? null
    const ro = typeof ResizeObserver !== 'undefined' && scroller ? new ResizeObserver(measure) : null
    if (scroller) { ro?.observe(scroller); if (scroller.firstElementChild) ro?.observe(scroller.firstElementChild) }
    const release = scroller ? holdPageFit() : () => {}
    window.addEventListener('resize', measure)
    return () => { window.removeEventListener('resize', measure); ro?.disconnect(); release() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [min, dep, enabled])
  return { ref, height }
}
