import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PlanLimits } from '@agentistics/core'
import { PlanLimitMini } from './PlanLimitMeter'

const NOW = Date.UTC(2026, 9, 10, 12)
const limits = (five: number, week: number, fiveReset = NOW + 3_600_000): PlanLimits => ({
  harness: 'codex', account: 'default', updatedAt: NOW, source: 'codex-rollout',
  windows: [
    { kind: '5h', usedPct: five, resetsAt: fiveReset },
    { kind: 'week', usedPct: week, resetsAt: NOW + 86_400_000 },
  ],
})

describe('PlanLimitMini', () => {
  it('draws both windows, labels and rounded percentages', () => {
    const html = renderToStaticMarkup(<PlanLimitMini limits={limits(4, 33)} now={NOW} lang="en" />)
    expect(html).toContain('data-plan-mini="codex"')
    expect(html).toContain('5 h')
    expect(html).toContain('7 d')
    expect(html).toContain('4%')
    expect(html).toContain('33%')
    expect(html).toContain('height:3px')
    expect(html).not.toContain('<button')
  })
  it('uses the product tone ramp: orange from 75, red from 95, never a hand-rolled colour', () => {
    const html = renderToStaticMarkup(<PlanLimitMini limits={limits(80, 96)} now={NOW} lang="pt" />)
    expect(html).toContain('var(--anthropic-orange)')
    expect(html).toContain('var(--accent-red)')
    expect(html).not.toMatch(/#[0-9a-f]{3,6}/i)
  })
  it('a renewed window with no reading says "–", not 0%', () => {
    const html = renderToStaticMarkup(<PlanLimitMini limits={limits(50, 47, NOW - 1000)} now={NOW} lang="en" />)
    expect(html).toContain('>–<')
    expect(html).toContain('47%')
    expect(html).toContain('width:0')
  })
})
