import { useSyncExternalStore } from 'react'

const panels = new Set<symbol>()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

/** Track every existing bell, including the toast host on routes without a header. */
export function setNotificationPanelOpen(panel: symbol, open: boolean) {
  if (open) panels.add(panel)
  else panels.delete(panel)
  for (const listener of listeners) listener()
}
export function useNotificationPanelOpen() {
  return useSyncExternalStore(subscribe, () => panels.size > 0)
}

export interface NotificationPanelPlacement {
  left: number
  width: number
}

/** Mobile notification sheets stay inside the viewport, including their side margins. */
export function notificationPanelPlacement(
  viewportWidth: number,
  desiredWidth = 320,
  margin = 10,
): NotificationPanelPlacement {
  const width = Math.min(desiredWidth, Math.max(0, viewportWidth - margin * 2))
  return { left: Math.max(margin, (viewportWidth - width) / 2), width }
}
