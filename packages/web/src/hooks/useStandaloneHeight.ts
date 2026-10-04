/**
 * useStandaloneHeight — the installed PWA's height when iOS leaves `100dvh` short after the keyboard
 * (`lib/standaloneHeight.ts` has the rule and why). Re-read on every event that can move it: a
 * resize of either viewport, a focus leaving a field, an orientation change, coming back to the app.
 * `null` everywhere it does not apply, so the caller keeps `100dvh`.
 */
import { useEffect, useState } from 'react'
import { standaloneAppHeight } from '../lib/standaloneHeight'

function standalone(): boolean {
  try {
    const nav = navigator as Navigator & { standalone?: boolean }
    return nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true
  } catch {
    return false
  }
}

function editing(): boolean {
  const e = document.activeElement as HTMLElement | null
  return !!e && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.isContentEditable)
}

export function useStandaloneHeight(enabled: boolean): number | null {
  const [h, setH] = useState<number | null>(null)
  useEffect(() => {
    if (!enabled) { setH(null); return }
    const read = () => {
      const next = standaloneAppHeight({
        standalone: standalone(), editing: editing(),
        innerWidth: window.innerWidth, innerHeight: window.innerHeight,
        screenWidth: window.screen?.width ?? 0, screenHeight: window.screen?.height ?? 0,
      })
      setH(prev => (prev === next ? prev : next))
      // A corrected height starts at the top: the stale reading is also what leaves the document
      // scrolled by the gap.
      if (next !== null && window.scrollY !== 0) window.scrollTo(0, 0)
    }
    // A blur lands before iOS has finished putting the viewport back, so it is read again after.
    const later = () => { for (const ms of [0, 150, 400, 900]) window.setTimeout(read, ms) }
    read()
    const vv = window.visualViewport
    window.addEventListener('resize', read)
    window.addEventListener('orientationchange', later)
    document.addEventListener('focusout', later)
    document.addEventListener('visibilitychange', later)
    vv?.addEventListener('resize', read)
    return () => {
      window.removeEventListener('resize', read)
      window.removeEventListener('orientationchange', later)
      document.removeEventListener('focusout', later)
      document.removeEventListener('visibilitychange', later)
      vv?.removeEventListener('resize', read)
    }
  }, [enabled])
  return h
}
