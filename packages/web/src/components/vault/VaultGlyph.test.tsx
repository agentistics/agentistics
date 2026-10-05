import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { VaultGlyph } from './VaultGlyph'
import { VaultSafe } from './VaultSafe'

describe('VaultGlyph — the solid safe', () => {
  test.each([16, 20, 24, 32, 48])('renders at %ipx as a decorative square svg', size => {
    const html = renderToStaticMarkup(<VaultGlyph size={size} />)
    expect(html).toContain(`width="${size}"`)
    expect(html).toContain(`height="${size}"`)
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('data-vault-glyph')
  })
  test('is a safe: body with the dial cut out by a mask, ring, handle notch and two feet', () => {
    const html = renderToStaticMarkup(<VaultGlyph />)
    expect(html).toContain('<mask')
    expect(html).toContain('mask="url(#')
    expect((html.match(/<circle/g) ?? []).length).toBeGreaterThanOrEqual(3) // cut-out, ring, hub
    expect((html.match(/<rect/g) ?? []).length).toBe(4) // mask bg + body + two feet
  })
  test('uses currentColor so the surface picks the colour', () => {
    expect(renderToStaticMarkup(<VaultGlyph />)).toContain('currentColor')
  })
  test('two glyphs on one page never share a mask id', () => {
    const html = renderToStaticMarkup(<><VaultGlyph /><VaultGlyph /></>)
    const ids = [...html.matchAll(/<mask id="([^"]+)"/g)].map(m => m[1])
    expect(ids.length).toBe(2)
    expect(new Set(ids).size).toBe(2)
  })
})

describe('VaultSafe phases', () => {
  test.each(['locked', 'unlocking', 'opening', 'open'] as const)('%s is drawn with its own class', phase => {
    const html = renderToStaticMarkup(<VaultSafe phase={phase} />)
    expect(html).toContain(`vs-${phase}`)
    expect(html).toContain(`data-safe-phase="${phase}"`)
  })
  test('from=open starts open (the short reverse then closes it)', () => {
    expect(renderToStaticMarkup(<VaultSafe phase="locked" from="open" />)).toContain('data-safe-phase="open"')
  })
  test('motion is switched off by prefers-reduced-motion', () => {
    expect(renderToStaticMarkup(<VaultSafe phase="locked" />)).toContain('prefers-reduced-motion:reduce')
  })
})
