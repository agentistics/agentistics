import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('./handoffWarning.css', import.meta.url), 'utf8')
const theme = readFileSync(new URL('../../index.css', import.meta.url), 'utf8')
const light = theme.slice(theme.indexOf('[data-theme="light"] {'))
const rgb = (name: string) => {
  const hex = light.match(new RegExp(`${name}: #([a-f0-9]{6})`, 'i'))![1]!
  return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16))
}
const mix = (a: number[], b: number[], weight: number) => a.map((v, i) => v * weight + b[i]! * (1 - weight))
const luminance = (color: number[]) => color.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0)
const contrast = (a: number[], b: number[]) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)

describe('leader meter layout and contrast', () => {
  it('reserves a numeric slot for all four readings at desktop and mobile sizes', () => {
    // Seven widths of the zero glyph accommodate the representative PT and EN figures, including
    // the absent reading. No media query may remove that reservation or tabular digits.
    const valueRules = [...css.matchAll(/\.handoff-meter-value\s*\{([^}]+)\}/g)].map(m => m[1]!)
    expect(valueRules).toHaveLength(1)
    expect(Number(valueRules[0]!.match(/min-width:\s*([\d.]+)ch/)![1])).toBeGreaterThanOrEqual(7)
    expect(css).toContain('font-variant-numeric:tabular-nums')
  })
  it('meets AA for the attention figure and crown on light surfaces using theme tokens', () => {
    const weight = Number(css.match(/--leader-meter-attention:color-mix\(in srgb,var\(--anthropic-orange\) (\d+)%/)![1]) / 100
    const tone = mix(rgb('--anthropic-orange'), rgb('--text-primary'), weight)
    const figureWeight = Number(css.match(/color:color-mix\(in srgb,var\(--handoff-tone\) (\d+)%/)![1]) / 100
    const figure = mix(tone, rgb('--text-primary'), figureWeight)
    for (const surface of ['--bg-base', '--bg-surface', '--bg-card']) expect(contrast(figure, rgb(surface))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(tone, rgb('--bg-card'))).toBeGreaterThanOrEqual(3)
  })
})
