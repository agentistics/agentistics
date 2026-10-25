import { areaOfPath } from './appAreas'

/** Option A: all five destinations share the same drag track and slot width. */
export const MOBILE_AREA_SLOTS = ['tasks', 'usage', 'sessions', 'metrics', 'more'] as const

export function mobileAreaSlot(pathname: string): number {
  const area = areaOfPath(pathname)?.area.id
  const index = MOBILE_AREA_SLOTS.findIndex(key => key === area)
  return index < 0 ? 4 : index
}

/** Sessions stays the way home even when invoked from an open conversation. */
export function activateMobileSessions(pathname: string, navigate: (to: string) => void, scrollTop: () => void): void {
  if (pathname === '/sessions' || pathname === '/sessions/') scrollTop()
  else navigate('/sessions')
}

/** The mobile workspace scrolls inside its list/overview, rather than in the document. */
export function scrollMobileSessionsToTop(): void {
  document.querySelectorAll<HTMLElement>('[data-mobile-sessions-scroll]').forEach(el => { el.scrollTop = 0 })
  window.scrollTo(0, 0)
}
