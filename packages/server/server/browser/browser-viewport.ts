import { QUALITY_STILL, SCREENCAST_PARAMS } from './browser-screencast'

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
/**
 * Tall enough for a full-screen phone at a 1024-wide page: 3200 / 1024 = aspect 3.125, which covers the
 * tallest real phones (360x800 = 2.22, 390x844 = 2.16, 430x932 = 2.17, 380x900 = 2.37). Past the cap the page
 * would be narrower than 1024 or the frame would not fill the card (black bars) — so the cap is the choice
 * (raise it, never crop: cropping would hide part of the page from the person and the model's clicks).
 */
export const MAX_PAGE_HEIGHT = 3200

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

/** The longer side of a captured frame, in physical pixels (NAVEGADOR.FLUIDEZ-NITIDEZ): sharp on a 2x screen, bounded in bytes and memory. */
export const MAX_CAPTURE_EDGE = 2560

export interface CastPlan {
  /** `Emulation.setDeviceMetricsOverride`: the page's CSS size and the scale it RENDERS at. */
  metrics: ViewerViewport
  /** `Page.startScreencast` bounds: the physical pixels the frame is drawn on, capped. */
  capture: { maxWidth: number; maxHeight: number }
}

/**
 * The surface -> what Chromium renders and captures. The frame is captured at the PHYSICAL pixels it will be shown
 * on (the page contained in the surface x devicePixelRatio, never below the page's CSS width), capped at `MAX_CAPTURE_EDGE`, and the page renders at
 * exactly the scale that capture needs: a dense 1240-CSS panel gets a 2170-px frame instead of a 1240-px one
 * upscaled 1.75x (the blur the owner saw), and a 390px phone showing a 1024 page renders at ~1.14x instead of 3x.
 */
export function castPlan(v: ViewerViewport): CastPlan | null {
  const page = clampViewport(v)
  if (!page) return null
  const fit = Math.min(v.width / page.width, v.height / page.height)
  const shown = page.width * fit * page.deviceScaleFactor
  const edgeCap = Math.min(MAX_CAPTURE_EDGE, MAX_CAPTURE_EDGE * page.width / page.height)
  // Never below the page's own CSS width: Chromium's screencast downscale is cruder than the browser's (measured
  // PSNR 25,6 against 35,7 dB on a 390px card), and the client scales the frame down anyway.
  const maxWidth = Math.round(Math.min(edgeCap, Math.max(page.width, Math.min(page.width * page.deviceScaleFactor, shown))))
  const maxHeight = Math.min(Math.round(maxWidth * page.height / page.width), MAX_CAPTURE_EDGE)
  const scale = Math.max(1, Math.round((maxWidth / page.width) * 100) / 100)
  return { metrics: { width: page.width, height: page.height, deviceScaleFactor: scale }, capture: { maxWidth, maxHeight } }
}

/** Serialized per target by the caller, including a previous cast's teardown on reconnect. */
export function createViewportCast(send: (method: string, params: Record<string, unknown>) => Promise<unknown>, serialize?: (fn: () => Promise<void>) => Promise<void>) {
  let tail = Promise.resolve()
  let overridden = false
  let current: { w: number; h: number } | null = null
  const queue = (fn: () => Promise<void>) => {
    if (serialize) return serialize(fn)
    const next = tail.then(fn); tail = next.catch(() => {}); return next
  }
  const want = (v?: ViewerViewport) => { const s = v ? clampViewport(v) : null; if (s) current = { w: s.width, h: s.height } }
  const start = async (v?: ViewerViewport) => {
    const plan = v ? castPlan(v) : null
    if (plan) {
      await send('Emulation.setDeviceMetricsOverride', { ...plan.metrics, mobile: false })
      overridden = true
    }
    await send('Page.startScreencast', { ...SCREENCAST_PARAMS, ...(plan ? plan.capture : {}) })
  }
  return {
    /**
     * The viewport (CSS px) the page is ABOUT to be at / is at: set the moment a start or resize is ASKED
     * (not when it lands), so a frame of the previous size that is still in flight is already recognised as old.
     */
    current: () => current,
    start: (v?: ViewerViewport) => { want(v); return queue(() => start(v)) },
    resize: (v: ViewerViewport) => { want(v); return queue(async () => { await send('Page.stopScreencast', {}); await start(v) }) },
    /** One sharp picture of the page now, at `QUALITY_STILL` (the still frame); null when it cannot be taken. */
    sharp: async (): Promise<string | null> => {
      const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: QUALITY_STILL, optimizeForSpeed: true }) as { data?: unknown } | undefined
      return typeof r?.data === 'string' && r.data.length > 0 ? r.data : null
    },
    stop: () => queue(async () => {
      try { await send('Page.stopScreencast', {}) } finally {
        if (overridden) { await send('Emulation.clearDeviceMetricsOverride', {}); overridden = false; current = null }
      }
    }),
  }
}
