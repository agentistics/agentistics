import { nativeViewportWidth, setGeometryZoom } from './zoomGeometry'

export const TEXT_SCALE_MIN = 0.85
export const TEXT_SCALE_MAX = 1.5
export const TEXT_SCALE_DEFAULT = 1
/** First-paint mirror of the personal preference, so a reload does not paint at 100% and then jump. */
export const TEXT_SCALE_LOCAL_KEY = 'agentistics-text-scale'

/**
 * The narrowest layout the app is designed for. Zooming a 390px phone by 1.5 leaves 260 CSS px,
 * and components built for a 320px minimum then overlap (the New session stepper's labels ran into
 * each other). So on a narrow screen the zoom stops where the layout would drop below this width —
 * a 390px phone reaches ~122% — and Settings says so rather than silently showing less than chosen.
 * A wide screen never hits it, and sizes below the default are never limited.
 */
export const MIN_LAYOUT_WIDTH = 320

export function effectiveTextScale(scale: number, viewportWidth: number): number {
  if (scale <= 1 || !(viewportWidth > 0)) return scale
  const ceiling = Math.floor((viewportWidth / MIN_LAYOUT_WIDTH) * 100) / 100
  return Math.min(scale, Math.max(1, ceiling))
}

export function clampTextScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return TEXT_SCALE_DEFAULT
  return Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, value))
}

interface ZoomRoot { style: { zoom: string; setProperty(name: string, value: string): void } }

/**
 * Scales the WHOLE UI — not only the text. Almost every size in this app is an inline px number,
 * so changing the root font-size (what this used to do) moved only the few rem-sized pieces and
 * the setting looked broken. `zoom` on `<html>` scales every length, and the two things it gets
 * wrong are compensated in exactly one place each:
 *   - viewport units: `100dvh` inside a zoomed root renders as 100dvh × zoom, so every viewport
 *     length in the app is written `calc(100dvh / var(--ui-zoom, 1))` (enforced by
 *     `viewportUnits.lint.test.ts`);
 *   - DOM geometry read by script (rects, pointer coordinates, innerWidth…) comes back zoomed,
 *     which `zoomGeometry.ts` undoes so a measured position written into a style lands where it was
 *     measured.
 * The root font-size stays the browser's own: zoom already scales rem, and changing both would
 * apply the scale twice.
 */
export function applyTextScale(root: ZoomRoot, value: unknown, viewportWidth = nativeViewportWidth()): number {
  const scale = clampTextScale(value)
  const zoom = effectiveTextScale(scale, viewportWidth)
  setGeometryZoom(zoom)
  root.style.zoom = zoom === 1 ? '' : String(zoom)
  root.style.setProperty('--ui-zoom', String(zoom))
  return scale
}

export function readLocalTextScale(): number {
  try {
    const raw = localStorage.getItem(TEXT_SCALE_LOCAL_KEY)
    return raw === null ? TEXT_SCALE_DEFAULT : clampTextScale(Number(raw))
  } catch { return TEXT_SCALE_DEFAULT }
}

export function writeLocalTextScale(scale: number): void {
  try { localStorage.setItem(TEXT_SCALE_LOCAL_KEY, String(scale)) } catch { /* private window: first paint falls back to 100% */ }
}
