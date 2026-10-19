import { describe, expect, it } from 'bun:test'
import { handoffCut, handoffLevel, normalizeHandoffConfig } from './handoffConfig'

describe('leader handoff owner settings', () => {
  it('defaults to balanced with all warnings and +10%', () => {
    const c = normalizeHandoffConfig(undefined)
    expect(handoffCut(c)).toBe(250_000)
    expect(c).toMatchObject({ warnings: { near: true, due: true, overdue: true }, extraPercent: 10 })
  })
  it('uses each profile and the custom token cut', () => {
    for (const [profile, cut] of [['economy', 150_000], ['balanced', 250_000], ['long', 400_000], ['custom', 312_000]] as const) {
      expect(handoffCut(normalizeHandoffConfig({ profile, customTokens: 312_000 }))).toBe(cut)
    }
  })
  it('keeps disabled warning levels and rejects invalid stored values', () => {
    expect(normalizeHandoffConfig({ profile: 'invalid', customTokens: -1, extraPercent: Infinity, warnings: { due: false } })).toEqual({
      profile: 'balanced', customTokens: 250_000, extraPercent: 10, warnings: { near: true, due: false, overdue: true },
    })
    expect(normalizeHandoffConfig(null)).toEqual(normalizeHandoffConfig('bad'))
    expect(normalizeHandoffConfig({ extraPercent: 0 }).extraPercent).toBe(0)
  })
  it('changes color exactly at 80%, the cut and +50k', () => {
    expect([199_999, 200_000, 249_999, 250_000, 299_999, 300_000].map(n => handoffLevel(n, 250_000)))
      .toEqual(['normal', 'near', 'near', 'due', 'due', 'overdue'])
    expect(handoffLevel(120_000, 150_000)).toBe('near')
    expect(handoffLevel(200_000, 150_000)).toBe('overdue')
  })
})
