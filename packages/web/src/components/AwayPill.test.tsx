import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
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
    withWidth(1440, () => { __setAwayForTest(AWAY_OFF); expect(renderToStaticMarkup(<MemoryRouter><AwayPill lang="en" enabled /></MemoryRouter>)).toBe('') })
  })
  test('default variant A is a quiet chip whose copy never reads "você voltar"', () => {
    expect(AWAY_PILL_VARIANT).toBe('A')
    withWidth(1440, () => {
      __setAwayForTest({ ...AWAY_OFF, on: true })
      const pt = renderToStaticMarkup(<MemoryRouter><AwayPill lang="pt" enabled /></MemoryRouter>)
      expect(pt).toContain('>Ausente<'); expect(pt).not.toContain('você voltar<')
      expect(pt).toContain('até você voltar')
      expect(pt).toContain('href="/leadership/away"')
      expect(pt).not.toContain('clique para desligar')
      expect(pt).toContain('border:1px solid currentColor')
      expect(renderToStaticMarkup(<MemoryRouter><AwayPill lang="en" enabled /></MemoryRouter>)).toContain('>Away<')
    })
  })
  test.each(['A', 'B', 'C'] as const)('variant %s renders at both widths', v => {
    for (const w of [390, 1440]) withWidth(w, () => {
      __setAwayForTest({ ...AWAY_OFF, on: true })
      expect(renderToStaticMarkup(<MemoryRouter><AwayPill lang="en" enabled variant={v} /></MemoryRouter>)).toContain('data-testid="away-pill"')
    })
  })
})
