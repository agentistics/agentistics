import { describe, expect, test } from 'bun:test'
import { formatTaskCost, taskCostUSD, usdOnly } from './money'

describe('task cost with Copilot premium requests', () => {
  test('credits only are estimated in USD', () => {
    const credits = { premiumRequests: 3 }
    expect(taskCostUSD(null, credits)).toBeCloseTo(0.12)
    expect(formatTaskCost(usdOnly, null, credits, null)).toBe('≈USD 0.12')
  })

  test('mixed USD and credits are summed', () => {
    expect(taskCostUSD(1, { premiumRequests: 2 })).toBeCloseTo(1.08)
    expect(formatTaskCost(usdOnly, 1, { premiumRequests: 2 }, null)).toBe('≈USD 1.08')
  })

  test('zero credits still use the shared money formatter', () => {
    expect(taskCostUSD(null, { premiumRequests: 0 })).toBe(0)
    expect(formatTaskCost(usdOnly, null, { premiumRequests: 0 }, null)).toBe('≈USD 0.00')
  })
})
