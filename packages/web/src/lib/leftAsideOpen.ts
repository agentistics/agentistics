/**
 * leftAsideOpen.ts — is the left sessions list RESIZABLE right now (not collapsed to the icon rail,
 * not mobile)? Bridged the exact same way `leftAsideEdge.ts` bridges the list's own live width —
 * `App.tsx` (which owns `sidebarCollapsed`) is the one publisher, alongside that same value, in the
 * same effect — and this file exists apart from it because `leftAsideEdge.ts`'s own number cannot
 * answer this question on its own: collapsed, the edge is `SIDEBAR_W_COLLAPSED` (64), a perfectly
 * ordinary width a reader could also reach by hand-dragging the expanded list, so comparing the
 * number back against that constant would occasionally read a genuinely narrow expanded list as
 * collapsed.
 *
 * The ONE reader is `SessionsPage.tsx`'s T-junction wiring (`activeJunctions`,
 * `lib/panelLayout.ts`): the bottom-left junction (where the band's own horizontal gap meets the
 * left list's vertical one) exists only while the list is actually resizable — collapsed, its gap
 * (`App.tsx`'s own `{!collapsed && (<PanelGap .../>)}`) is not even rendered, so a junction placed
 * there would arm a `mousedown` on an element that does not exist.
 */

import { useSyncExternalStore } from 'react'

let open = true
const listeners = new Set<() => void>()

export function getLeftAsideOpen(): boolean {
  return open
}

export function setLeftAsideOpen(next: boolean): void {
  if (next === open) return
  open = next
  for (const l of listeners) l()
}

export function useLeftAsideOpen(): boolean {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => { listeners.delete(cb) } },
    () => open,
    () => true,
  )
}

/** For tests: forget everything. */
export function resetLeftAsideOpen(): void {
  open = true
  for (const l of listeners) l()
}
