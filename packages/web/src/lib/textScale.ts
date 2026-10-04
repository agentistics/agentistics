export const TEXT_SCALE_MIN = 0.85
export const TEXT_SCALE_MAX = 1.5
export const TEXT_SCALE_DEFAULT = 1

export function clampTextScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return TEXT_SCALE_DEFAULT
  return Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, value))
}

export function applyTextScale(root: { style: { fontSize: string } }, value: unknown): number {
  const scale = clampTextScale(value)
  root.style.fontSize = `${16 * scale}px`
  return scale
}
