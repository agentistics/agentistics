import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logoArt, parseLogoSvg } from './logo-art'

const SVG = readFileSync(join(import.meta.dir, '..', '..', '..', 'web', 'branding', 'logo-no-background.svg'), 'utf8')

describe('logoArt — the icon from the real SVG, scaled only (HM-01, D-TUI-11)', () => {
  test('exact size, half blocks only, deterministic', () => {
    const a = logoArt(SVG, 22, 11)
    expect(a).toHaveLength(11)
    for (const l of a) { expect([...l]).toHaveLength(22); expect(l).toMatch(/^[ ▀▄█]*$/) }
    expect(logoArt(SVG, 22, 11)).toEqual(a)
  })
  test('the geometry is the SVG\'s: every shape it declares is read (5 paths: outline, two side bars, two eyes)', () => {
    const { viewBox, shapes } = parseLogoSvg(SVG)
    expect(viewBox).toEqual([0, 0, 56, 56])
    expect(shapes.map(s => (s.fill ? 'fill' : 'stroke'))).toEqual(['stroke', 'fill', 'fill', 'stroke', 'stroke'])
  })
  test('the side bars land at both edges (x 3–7 and 50–54 of 56) and the eyes in the upper middle', () => {
    const a = logoArt(SVG, 22, 11)
    const mid = a[6]!
    expect(mid[1]).toBe('█')
    expect(mid[20]).toBe('█')
    expect(a.slice(3, 6).join('')).toMatch(/▄▀|▀▄/) // the two chevrons
  })
  test('a curve is refused, never approximated', () => {
    expect(() => logoArt('<svg viewBox="0 0 10 10"><path d="M0 0 C1 1 2 2 3 3" fill="#000"/></svg>', 4, 2)).toThrow(/unsupported/)
  })
  test('the compact mark is the same geometry at a smaller scale', () => {
    const c = logoArt(SVG, 12, 6)
    expect(c).toHaveLength(6)
    expect(c.join('').replace(/ /g, '').length).toBeGreaterThan(10)
  })
})

describe('LOGO_SVG — the embedded copy IS the branding file', () => {
  test('byte for byte', async () => {
    const { LOGO_SVG } = await import('./logo-svg')
    expect(LOGO_SVG).toBe(SVG)
  })
})
