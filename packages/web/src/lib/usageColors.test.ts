import { expect, test } from 'bun:test'
import { usageColors, USAGE_COLORS } from './usageColors'

test('unique account colors are deterministic across input order and repeated identities', () => {
  const ids = ['codex:principal', 'claude:nayara', 'claude:work', 'gemini:default']
  const forward = usageColors(ids), reverse = usageColors([...ids].reverse())
  expect(new Set(forward.values()).size).toBe(ids.length)
  for (const id of ids) expect(forward.get(id)).toBe(reverse.get(id))
  expect(usageColors([...ids, ids[0]!])).toEqual(forward)
})

// sRGB → D65 CIELAB, so two different hex strings cannot pass with nearly identical hues.
function colorMetrics(hex: string) {
  const [r, g, b] = [1, 3, 5].map(i => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  const f = (v: number) => v > 216 / 24389 ? Math.cbrt(v) : v * 841 / 108 + 4 / 29
  const x = f((r * .4124564 + g * .3575761 + b * .1804375) / .95047)
  const y = f(r * .2126729 + g * .7151522 + b * .0721750)
  const z = f((r * .0193339 + g * .1191920 + b * .9503041) / 1.08883)
  return { lab: [116 * y - 16, 500 * (x - y), 200 * (y - z)], luminance: r * .2126 + g * .7152 + b * .0722 }
}

test('every chart hue is separated by ΔE76 ≥ 35 and has ≥ 3:1 contrast on light and dark', () => {
  const colors = USAGE_COLORS.map(colorMetrics)
  for (const [i, a] of colors.entries()) {
    for (const b of colors.slice(i + 1)) {
      expect(Math.hypot(...a.lab.map((v, j) => v - b.lab[j]!))).toBeGreaterThanOrEqual(35)
    }
    for (const bg of ['#ffffff', '#16161e'].map(colorMetrics)) {
      expect((Math.max(a.luminance, bg.luminance) + .05) / (Math.min(a.luminance, bg.luminance) + .05)).toBeGreaterThanOrEqual(3)
    }
  }
})
