import { describe, expect, test } from 'bun:test'
import { tagPlanFactor } from './costBasis'

// planAllocation reads basis.perHarness/coverage; build the smallest basis it accepts.
const harnessBasis = (api: number, plan: number) => ({
  apiCostUSD: api, planCostUSD: plan, coverage: { computable: true },
})
const basis = (perHarness: Record<string, ReturnType<typeof harnessBasis>>) =>
  ({ perHarness, coverage: { computable: true } }) as never

describe('tagPlanFactor', () => {
  test('prices each harness at its own factor, not the aggregate', () => {
    const b = basis({ claude: harnessBasis(100, 20) }) // claude 0.2, codex uncovered
    // 10 claude @0.2 + 10 codex @1 = 12 over 20
    expect(tagPlanFactor(b, { claude: 10, codex: 10 })).toBeCloseTo(0.6)
  })
  test('two covered harnesses use their own factors', () => {
    const b = basis({ claude: harnessBasis(100, 20), codex: harnessBasis(100, 50) })
    expect(tagPlanFactor(b, { claude: 10, codex: 10 })).toBeCloseTo(0.35)
  })
  test('no plan covers the tag, or no split: API figure (1)', () => {
    expect(tagPlanFactor(basis({ claude: harnessBasis(100, 20) }), { codex: 5 })).toBe(1)
    expect(tagPlanFactor(basis({}), undefined)).toBe(1)
    expect(tagPlanFactor(null, { claude: 1 })).toBe(1)
  })
})
