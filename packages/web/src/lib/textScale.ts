export const TEXT_SCALE_MIN = 0.85
export const TEXT_SCALE_MAX = 1.5
export const TEXT_SCALE_DEFAULT = 1

export function clampTextScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return TEXT_SCALE_DEFAULT
  return Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, value))
}

/** The root the scale is applied to: `document.documentElement`, or a stand-in in tests. */
export interface TextScaleRoot {
  style: { zoom: string; fontSize: string; setProperty(name: string, value: string): void; removeProperty(name: string): string }
}

/**
 * Text size is CSS `zoom` on the ROOT ELEMENT, not a root font-size.
 *
 * The app sizes its type in px (~2.800 inline `fontSize` values against ~60 rem, and a 14px body),
 * so a root font-size moved almost nothing — while the setting promises "all text in the app".
 * `zoom` on the root scales every length at once and keeps the layout proportional, without
 * converting thousands of values by hand.
 *
 * Under `zoom` a viewport unit grows with it (measured: `100vh` = 1120px at 1.4 on an 800px
 * window), so a `100dvh` shell or an `86vh` modal would overflow the screen and a `92vw` card would
 * scroll the page sideways at 390px. `--ag-zoom` carries the factor so each of those is written
 * `calc(N<unit> / var(--ag-zoom, 1))`; a viewport unit added without it overflows once the setting
 * is raised, and `textScale.test.ts` greps the sources for exactly that.
 */
export function applyTextScale(root: TextScaleRoot, value: unknown): number {
  const scale = clampTextScale(value)
  root.style.fontSize = ''
  if (scale === TEXT_SCALE_DEFAULT) {
    root.style.zoom = ''
    root.style.removeProperty('--ag-zoom')
  } else {
    root.style.zoom = String(scale)
    root.style.setProperty('--ag-zoom', String(scale))
  }
  return scale
}
