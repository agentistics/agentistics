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

export function clampViewport(v: ViewerViewport): ViewerViewport | null {
  if (![v.width, v.height, v.deviceScaleFactor].every(n => Number.isFinite(n) && n > 0)) return null
  return { width: Math.max(320, Math.min(1920, Math.round(v.width))), height: Math.max(240, Math.min(1200, Math.round(v.height))), deviceScaleFactor: Math.max(1, Math.min(3, v.deviceScaleFactor)) }
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
