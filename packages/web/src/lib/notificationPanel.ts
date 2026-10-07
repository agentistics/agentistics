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
