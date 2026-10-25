/** The app owns freshness: events stay connected; polling is a visible-tab fallback. */
export const WORKING_REFRESH_MS = 10_000
export const IDLE_REFRESH_MS = 60_000
type RefreshTimer = ReturnType<typeof setTimeout> | number

export function startDataRefresh(o: {
  working: boolean
  document: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>
  refresh: () => void
  healthy: () => boolean
  pause: () => void
  timers?: { set: (fn: () => void, ms: number) => RefreshTimer; clear: (id: RefreshTimer) => void }
}): () => void {
  // Browser timers require the Window/global receiver. Storing them directly here invokes them
  // with `this === timers`, which throws Illegal invocation in a real browser.
  const timers = o.timers ?? {
    set: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clear: (id: RefreshTimer) => clearTimeout(id),
  }
  let timer: RefreshTimer | undefined
  const clear = () => { if (timer !== undefined) timers.clear(timer); timer = undefined }
  const arm = () => {
    clear()
    if (o.document.hidden) return
    timer = timers.set(() => {
      if (!o.document.hidden && !o.healthy()) o.refresh()
      arm()
    }, o.working ? WORKING_REFRESH_MS : IDLE_REFRESH_MS)
  }
  const visible = () => {
    clear()
    if (o.document.hidden) { o.pause(); return }
    o.refresh()
    arm()
  }
  arm()
  o.document.addEventListener('visibilitychange', visible)
  o.window.addEventListener('focus', visible)
  return () => {
    clear()
    o.document.removeEventListener('visibilitychange', visible)
    o.window.removeEventListener('focus', visible)
  }
}
