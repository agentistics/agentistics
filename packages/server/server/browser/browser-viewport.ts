import { SCREENCAST_PARAMS } from './browser-screencast'

export interface ViewerViewport { width: number; height: number; deviceScaleFactor: number }

/** Keep teardown and reconnect atomic across successive casts of the same CDP target. */
export function createViewportQueue() {
  const tails = new Map<string, Promise<void>>()
  return (target: string, fn: () => Promise<void>): Promise<void> => {
    const next = (tails.get(target) ?? Promise.resolve()).catch(() => {}).then(fn)
    tails.set(target, next)
    void next.finally(() => { if (tails.get(target) === next) tails.delete(target) }).catch(() => {})
    return next
  }
}

export const MIN_PAGE_WIDTH = 1024
export const MAX_PAGE_WIDTH = 1920
export const MIN_PAGE_HEIGHT = 400
/** Tall enough for a full-screen phone (aspect up to ~2.1 at 1024 wide). */
export const MAX_PAGE_HEIGHT = 2200

/**
 * The surface the person watches -> the page the model keeps. Only the surface's ASPECT RATIO is
 * taken, never its raw size: the page is always a desktop layout (>= 1024 wide, no "mobile" media
 * query) and the frame is scaled down to fill the surface exactly (no black bars).
 */
export function clampViewport(v: ViewerViewport): ViewerViewport | null {
  if (![v.width, v.height, v.deviceScaleFactor].every(n => Number.isFinite(n) && n > 0)) return null
  const aspect = v.height / v.width
  let width = Math.min(MAX_PAGE_WIDTH, Math.max(MIN_PAGE_WIDTH, Math.round(v.width)))
  let height = Math.round(width * aspect)
  if (height < MIN_PAGE_HEIGHT) { height = MIN_PAGE_HEIGHT; width = Math.min(MAX_PAGE_WIDTH, Math.round(height / aspect)) }
  else if (height > MAX_PAGE_HEIGHT) { height = MAX_PAGE_HEIGHT; width = Math.max(MIN_PAGE_WIDTH, Math.round(height / aspect)) }
  return { width, height, deviceScaleFactor: Math.max(1, Math.min(3, v.deviceScaleFactor)) }
}

/** Serialized per target by the caller, including a previous cast's teardown on reconnect. */
export function createViewportCast(send: (method: string, params: Record<string, unknown>) => Promise<unknown>, serialize?: (fn: () => Promise<void>) => Promise<void>) {
  let tail = Promise.resolve()
  let overridden = false
  const queue = (fn: () => Promise<void>) => {
    if (serialize) return serialize(fn)
    const next = tail.then(fn); tail = next.catch(() => {}); return next
  }
  const start = async (v?: ViewerViewport) => {
    const size = v ? clampViewport(v) : null
    if (size) {
      await send('Emulation.setDeviceMetricsOverride', { ...size, mobile: false })
      overridden = true
    }
    await send('Page.startScreencast', { ...SCREENCAST_PARAMS, ...(size ? { maxWidth: size.width, maxHeight: size.height } : {}) })
  }
  return {
    start: (v?: ViewerViewport) => queue(() => start(v)),
    resize: (v: ViewerViewport) => queue(async () => { await send('Page.stopScreencast', {}); await start(v) }),
    stop: () => queue(async () => {
      try { await send('Page.stopScreencast', {}) } finally {
        if (overridden) { await send('Emulation.clearDeviceMetricsOverride', {}); overridden = false }
      }
    }),
  }
}
