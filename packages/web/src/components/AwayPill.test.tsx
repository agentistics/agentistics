import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AWAY_OFF } from '@agentistics/core'
import AwayPill, { AWAY_PILL_VARIANT } from './AwayPill'
import { __setAwayForTest } from '../lib/awayMode'

function withWidth(width: number, run: () => void) {
  const root = globalThis as { window?: unknown }
  const old = root.window
  root.window = { innerWidth: width, matchMedia: () => ({ matches: width < 768, addEventListener() {}, removeEventListener() {} }) }
  try { run() } finally { if (old === undefined) delete root.window; else root.window = old }
}
afterEach(() => __setAwayForTest(null))

describe('top-bar away pill', () => {
  test('is absent while away is off', () => {
    withWidth(1440, () => { __setAwayForTest(AWAY_OFF); expect(renderToStaticMarkup(<AwayPill lang="en" enabled />)).toBe('') })
  })
  test('default variant B is the 32px rounded square of its neighbours, accent outlined, moon only', () => {
    expect(AWAY_PILL_VARIANT).toBe('B')
    withWidth(1440, () => {
      __setAwayForTest({ ...AWAY_OFF, on: true })
      const pt = renderToStaticMarkup(<AwayPill lang="pt" enabled />)
      expect(pt).toContain('width:32px'); expect(pt).toContain('height:32px'); expect(pt).toContain('border-radius:8px')
      expect(pt).toContain('border:1px solid currentColor'); expect(pt).toContain('color:var(--anthropic-orange)')
      expect(pt).not.toContain('>Ausente<'); expect(pt).toContain('até você voltar')
    })
  })
  test('variant A is a quiet chip whose copy never reads "você voltar"', () => {
    withWidth(1440, () => {
      __setAwayForTest({ ...AWAY_OFF, on: true })
      const pt = renderToStaticMarkup(<AwayPill lang="pt" enabled variant="A" />)
      expect(pt).toContain('>Ausente<'); expect(pt).not.toContain('você voltar<')
      expect(pt).toContain('até você voltar')
      expect(pt).toContain('border:1px solid currentColor')
      expect(renderToStaticMarkup(<AwayPill lang="en" enabled variant="A" />)).toContain('>Away<')
    })
  })
  test.each(['A', 'B', 'C'] as const)('variant %s renders at both widths', v => {
    for (const w of [390, 1440]) withWidth(w, () => {
      __setAwayForTest({ ...AWAY_OFF, on: true })
      expect(renderToStaticMarkup(<AwayPill lang="en" enabled variant={v} />)).toContain('data-testid="away-pill"')
    })
  })
})
