export const TEXT_SCALE_MIN = 0.85
export const TEXT_SCALE_MAX = 1.5
export const TEXT_SCALE_DEFAULT = 1

export function clampTextScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return TEXT_SCALE_DEFAULT
  return Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, value))
}

export function applyTextScale(root: { style: { zoom: string; width?: string; maxWidth?: string } }, value: unknown): number {
  const scale = clampTextScale(value)
  // The UI is mostly sized in px, so a root zoom is the compact way to scale all text and
  // controls. Apply it to #root rather than <html>: browsers keep the document's computed
  // font-size unchanged under an html zoom, while the root's rendered bounds do grow. Compensate
  // the layout width so the visual page remains viewport-wide without horizontal overflow.
  root.style.zoom = scale === 1 ? '' : String(scale)
  root.style.width = scale === 1 ? '' : `calc(100% / ${scale})`
  root.style.maxWidth = scale === 1 ? '' : 'none'
  return scale
}
