export const TEXT_SCALE_MIN = 0.85
export const TEXT_SCALE_MAX = 1.5
export const TEXT_SCALE_DEFAULT = 1

export function clampTextScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return TEXT_SCALE_DEFAULT
  return Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, value))
}

export function applyTextScale(root: { style: { zoom: string } }, value: unknown): number {
  const scale = clampTextScale(value)
  // Zoom (not root font-size): most of the UI is sized in px, so only a zoom scales ALL of it.
  root.style.zoom = scale === 1 ? '' : String(scale)
  return scale
}
