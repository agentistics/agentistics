import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import {
  mermaidScratchElementId, mermaidThemeVariables, removeMermaidScratchElement,
  widenSvgToNaturalSize,
} from './MermaidDiagram'
import { TOKENS_DARK, TOKENS_LIGHT } from '../../lib/monacoTheme'
import { stripComments } from '../../lib/stripComments'

const HEX6 = /^#[0-9a-fA-F]{6}$/

describe('mermaidThemeVariables', () => {
  test('every colour it hands mermaid is a flat, opaque hex — never the app\'s own rgba tokens', () => {
    for (const tokens of [TOKENS_DARK, TOKENS_LIGHT]) {
      const vars = mermaidThemeVariables(tokens)
      for (const [key, value] of Object.entries(vars)) {
        if (key === 'fontFamily') continue
        expect(HEX6.test(value)).toBe(true)
      }
    }
  })

  test('the background is the ground itself, not composited over anything', () => {
    expect(mermaidThemeVariables(TOKENS_DARK).background).toBe(TOKENS_DARK.bgBase)
    expect(mermaidThemeVariables(TOKENS_LIGHT).background).toBe(TOKENS_LIGHT.bgBase)
  })

  test('dark and light produce genuinely different palettes', () => {
    expect(mermaidThemeVariables(TOKENS_DARK)).not.toEqual(mermaidThemeVariables(TOKENS_LIGHT))
  })

  test('the node border is the product\'s own orange accent, composited on the ground', () => {
    const dark = mermaidThemeVariables(TOKENS_DARK)
    // TOKENS_DARK.orange is already an opaque hex, so flatten() is the identity here.
    expect(dark.nodeBorder).toBe(TOKENS_DARK.orange.toLowerCase())
  })
})

// C1: a mermaid parse error used to leave a scratch element as a live child of `document.body`,
// outside this component's own tree, on EVERY failed render — with no jsdom in this repo's test
// stack, `MermaidDiagram` itself never runs its effects under `renderToStaticMarkup`, so the
// belt-and-suspenders cleanup is pulled out as its own pure function and tested directly against a
// fake host instead of a real DOM.
describe('mermaidScratchElementId', () => {
  test('is mermaid\'s own d<id> naming, never the render id itself', () => {
    expect(mermaidScratchElementId('ag-mermaid-7')).toBe('dag-mermaid-7')
    expect(mermaidScratchElementId('ag-mermaid-7')).not.toBe('ag-mermaid-7')
  })
})

describe('removeMermaidScratchElement', () => {
  test('removes exactly the scratch element for THIS render id, and only that one', () => {
    let removed7 = false
    let removed8 = false
    const host = {
      getElementById(id: string) {
        if (id === 'dag-mermaid-7') return { remove: () => { removed7 = true } }
        if (id === 'dag-mermaid-8') return { remove: () => { removed8 = true } }
        return null
      },
    }
    expect(removeMermaidScratchElement(host, 'ag-mermaid-7')).toBe(true)
    expect(removed7).toBe(true)
    expect(removed8).toBe(false)
  })

  test('is a no-op — never throws — when suppressErrorRendering already stopped the element from being attached', () => {
    const host = { getElementById: () => null }
    expect(removeMermaidScratchElement(host, 'ag-mermaid-9')).toBe(false)
  })

  test('called for every failed render, a stray never survives — the actual C1 shape', () => {
    // Models the leak this guards: N failed renders of the SAME source (I1's remount-per-poll)
    // each attaching, then removing, their own scratch element. Without the call in the `catch`,
    // `attached` would grow without bound exactly as `document.body.children` did in the bug.
    const attached = new Set<string>()
    const host = {
      getElementById(id: string) {
        return attached.has(id) ? { remove: () => attached.delete(id) } : null
      },
    }
    for (let i = 0; i < 30; i++) {
      const renderId = `ag-mermaid-${i}`
      attached.add(mermaidScratchElementId(renderId)) // mermaid's own failure path
      removeMermaidScratchElement(host, renderId) // this component's cleanup
    }
    expect(attached.size).toBe(0)
  })
})

// I4: a wide diagram shrank to ~4px text instead of scrolling horizontally, because mermaid emits
// its root <svg> at `width="100%"` with `style="max-width:<viewBox width>px"` — meant to shrink a
// diagram to fit a reading column, the opposite of what this component's own `overflowX: auto` box
// wants (draw at natural size, let the BOX scroll).
//
// A first fix wave anchored its regex on a literal `viewBox="0 0 …"` prefix. Real mermaid 12.0.0
// never emits that — every flowchart carries its own `4 4` padding as the origin — so the fix never
// matched a single live diagram and the bug reproduced exactly as before (I4 in the review). The
// fixtures below with `viewBox="4 4 …"` are the ACTUAL opening `<svg …>` tags captured from a real
// mermaid flowchart rendered in a browser, not hand-built `"0 0 …"` shapes.
describe('widenSvgToNaturalSize', () => {
  test('real mermaid output: a 40-node flowchart with "4 4 …" origin is widened (I4 regression)', () => {
    // Captured live from wide-diagram.md's rendered SVG (review's I4 repro).
    const svg = '<svg aria-roledescription="flowchart-v2" role="graphics-document document" viewBox="4 4 7656 60" '
      + 'style="max-width: 7656px;" class="flowchart" xmlns="http://www.w3.org/2000/svg" width="100%" '
      + 'id="ag-mermaid-1" height="60">'
    const out = widenSvgToNaturalSize(svg)
    expect(out).toContain('width="7656"')
    expect(out).not.toContain('max-width: 7656px')
    expect(out).toContain('max-width: none')
  })

  test('real mermaid output: a small flowchart with decimal "4 4 …" origin is widened', () => {
    // Captured live from mermaid-labels.md's rendered SVG.
    const svg = '<svg aria-roledescription="flowchart-v2" role="graphics-document document" '
      + 'viewBox="4 4 360 112.796875" style="max-width: 360px;" class="flowchart" width="100%" height="112.796875">'
    const out = widenSvgToNaturalSize(svg)
    expect(out).toContain('width="360"')
    expect(out).not.toContain('max-width: 360px')
    expect(out).toContain('max-width: none')
  })

  test('rewrites width to the viewBox width and drops the max-width clamp (0 0 origin)', () => {
    const svg = '<svg viewBox="0 0 842.5 213" width="100%" style="max-width: 842.5px;" role="graphics-document">'
    const out = widenSvgToNaturalSize(svg)
    expect(out).toContain('width="842.5"')
    expect(out).not.toContain('max-width: 842.5px')
    expect(out).toContain('max-width: none')
  })

  test('a negative origin (minX/minY below zero) still reads the width as the third number', () => {
    const svg = '<svg viewBox="-10.5 -3 500.25 120" width="100%" style="max-width:500.25px;">'
    const out = widenSvgToNaturalSize(svg)
    expect(out).toContain('width="500.25"')
    expect(out).toContain('max-width: none')
  })

  test('comma-separated viewBox values (SVG spec allows either separator)', () => {
    const svg = '<svg viewBox="4,4,300,100" width="100%" style="max-width:300px;">'
    const out = widenSvgToNaturalSize(svg)
    expect(out).toContain('width="300"')
    expect(out).toContain('max-width: none')
  })

  test('mixed comma-and-space viewBox values', () => {
    const svg = '<svg viewBox="4, 4, 300.5, 100" width="100%" style="max-width:300.5px;">'
    const out = widenSvgToNaturalSize(svg)
    expect(out).toContain('width="300.5"')
  })

  test('touches ONLY the opening <svg> tag — a width/max-width appearing later, inside a node, survives', () => {
    const svg = '<svg viewBox="4 4 100 50" width="100%" style="max-width:100px;">'
      + '<rect width="100%" style="max-width:40px" /></svg>'
    const out = widenSvgToNaturalSize(svg)
    expect(out).toContain('<svg viewBox="4 4 100 50" width="100" style="max-width: none;">')
    // The nested <rect>'s own attributes are untouched — the substitution is anchored to `<svg\b`.
    expect(out).toContain('<rect width="100%" style="max-width:40px" />')
  })

  test('a malformed viewBox (not four numbers) falls back to the svg\'s own numeric width attribute', () => {
    const svg = '<svg viewBox="not a viewbox" width="642.75" style="max-width:200px;"></svg>'
    const out = widenSvgToNaturalSize(svg)
    expect(out).toContain('width="642.75"')
    expect(out).toContain('max-width: none')
  })

  test('no viewBox at all falls back to a numeric width attribute', () => {
    const svg = '<svg width="500" style="max-width:200px;"></svg>'
    const out = widenSvgToNaturalSize(svg)
    expect(out).toContain('width="500"')
    expect(out).toContain('max-width: none')
  })

  test('no viewBox and a percentage width (mermaid\'s actual shape with nothing to read) is untouched', () => {
    const svg = '<svg width="100%" style="max-width:200px;"></svg>'
    expect(widenSvgToNaturalSize(svg)).toBe(svg)
  })

  test('neither a parseable viewBox nor a numeric width is returned untouched, never guessed at', () => {
    const svg = '<svg role="graphics-document"></svg>'
    expect(widenSvgToNaturalSize(svg)).toBe(svg)
  })
})

/**
 * I2 / C1, over the SOURCE: `mermaid.initialize()` is only ever exercised in a browser (dynamic
 * `import('mermaid')` inside an effect, which this repo's no-jsdom stack never runs), so the one
 * thing a unit test can pin is that the options THEMSELVES are real CODE, not merely named in a
 * comment above the call — comments are stripped first (`stripComments.ts`, the shared stripper
 * this file's own header exists to be the only one of), and the assertions match the literal
 * key-and-value pair, not just the key, so a `htmlLabels: true` typo would still fail this.
 */
describe('mermaid.initialize options, as CODE rather than as prose about them', () => {
  const src = stripComments(readFileSync(new URL('./MermaidDiagram.tsx', import.meta.url), 'utf8'))

  test('suppressErrorRendering is on (C1) — comments above the call do not count', () => {
    expect(src).toContain('suppressErrorRendering: true')
  })
  test('htmlLabels is off (I2) — an HTML label can still carry an <img src> after sanitisation', () => {
    expect(src).toContain('htmlLabels: false')
  })
  test('securityLevel stays strict — the one thing that makes dangerouslySetInnerHTML safe here', () => {
    expect(src).toContain("securityLevel: 'strict'")
  })

  test('the scan still sees code a comment-only version would not', () => {
    // The test of the test: plant the exact defect (the option present only in prose) and confirm
    // the stripped source no longer contains it.
    const commentOnly = '// suppressErrorRendering: true\n// htmlLabels: false\nconst x = 1'
    const stripped = stripComments(commentOnly)
    expect(stripped).not.toContain('suppressErrorRendering: true')
    expect(stripped).not.toContain('htmlLabels: false')
  })
})
