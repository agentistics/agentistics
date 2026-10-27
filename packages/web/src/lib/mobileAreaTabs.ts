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

/** Fired by the bar's Início: the sessions page answers by showing its LIST, not only by scrolling. */
export const MOBILE_SESSIONS_HOME_EVENT = 'ag:mobile-sessions-home'

/**
 * The mobile workspace scrolls inside its list/overview, rather than in the document. It also asks
 * the page to leave the fleet-summary tab: tapping Início there only scrolled a screen that was
 * already at the top, which read as "goes nowhere".
 */
export function scrollMobileSessionsToTop(): void {
  window.dispatchEvent(new Event(MOBILE_SESSIONS_HOME_EVENT))
  document.querySelectorAll<HTMLElement>('[data-mobile-sessions-scroll]').forEach(el => { el.scrollTop = 0 })
  window.scrollTo(0, 0)
}

const PREV_KEY = 'ag-mobile-prev-page'

/** Remembers the last page outside Sessões, so the centre button can lead back to it. */
export function rememberPreviousPage(path: string): void {
  if (areaOfPath(path)?.area.id === 'sessions') return
  try { sessionStorage.setItem(PREV_KEY, path) } catch { /* private window */ }
}

/** The last non-Sessões page (path + query), or Métricas when there is none. */
export function previousPage(): string {
  try { return sessionStorage.getItem(PREV_KEY) || '/' } catch { return '/' }
}
