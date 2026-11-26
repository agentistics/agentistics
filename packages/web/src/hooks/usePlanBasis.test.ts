import { describe, test, expect, setSystemTime } from 'bun:test'
import { computePlanBasisView } from './usePlanBasis'
import { AVG_DAYS_PER_MONTH, type ApiCostByDay, type BillingSettings, type Filters } from '@agentistics/core'

const filters: Filters = { dateRange: 'all', customStart: '', customEnd: '', projects: [], models: [] }
const today = '2026-04-30'

function series(days: Record<string, number>, harness: 'claude' | 'codex' = 'claude', undated = 0): ApiCostByDay {
  const entries = Object.entries(days)
  return {
    days: { [harness]: Object.fromEntries(entries.map(([d, c]) => [d, { costUSD: c, tokens: c * 1_000_000, sessions: 1 }])) },
    undatedCostUSD: undated,
    undatedTokens: 0,
    firstDay: entries.length ? entries.map(([d]) => d).sort()[0]! : null,
    lastDay: entries.length ? entries.map(([d]) => d).sort().at(-1)! : null,
  }
}

const monthly = (amount: number, from: string, to?: string): BillingSettings => ({
  profiles: { claude: { periods: [{ id: 'bp_a', mode: 'subscription', planId: 'anthropic-max-5x', from, ...(to ? { to } : {}), price: { amount, currency: 'USD' } }] } },
})

describe('computePlanBasisView', () => {
  test('computes the multiple over the days actually covered', () => {
    const view = computePlanBasisView({
      apiCostByDay: series({ '2026-04-01': 400, '2026-04-15': 450 }),
      billing: monthly(100, '2026-01-01'),
      brlRate: 5.5,
      filters,
      today,
    })
    expect(view.blocked).toBeNull()
    expect(view.window).toEqual({ from: '2026-04-01', to: '2026-04-15' })
    const claude = view.basis!.perHarness.claude!
    // 15 days of a $100 plan.
    expect(claude.planCostUSD).toBeCloseTo((100 * 15) / AVG_DAYS_PER_MONTH, 9)
    expect(claude.apiCostUSD).toBe(850)
    expect(claude.multiple).toBeCloseTo(850 / ((100 * 15) / AVG_DAYS_PER_MONTH), 9)
  })

  test('the measured window is reported even when it is narrower than the filter', () => {
    // "All time" over a series that only reaches back to April: the number is right for April and
    // the heading would otherwise claim it covers everything.
    const view = computePlanBasisView({
      apiCostByDay: series({ '2026-04-10': 10, '2026-04-20': 10 }),
      billing: monthly(100, '2020-01-01'),
      brlRate: 5.5, filters, today,
    })
    expect(view.window).toEqual({ from: '2026-04-10', to: '2026-04-20' })
  })

  test('days no period covers leave both sides and are reported in money', () => {
    const view = computePlanBasisView({
      apiCostByDay: series({ '2026-04-01': 100, '2026-04-20': 340 }),
      billing: monthly(100, '2026-04-10'), // starts after the first day
      brlRate: 5.5, filters, today,
    })
    const claude = view.basis!.perHarness.claude!
    expect(claude.apiCostUSD).toBe(340)
    expect(claude.coverage.excludedApiCostUSD).toBe(100)
    expect(claude.coverage.excludedSessions).toBe(1)
  })

  test('a harness with no timeline is named, never averaged in', () => {
    const both: ApiCostByDay = {
      days: {
        claude: { '2026-04-05': { costUSD: 200, tokens: 1e6, sessions: 1 } },
        codex: { '2026-04-05': { costUSD: 50, tokens: 1e6, sessions: 1 } },
      },
      undatedCostUSD: 0, undatedTokens: 0, firstDay: '2026-04-05', lastDay: '2026-04-05',
    }
    const view = computePlanBasisView({ apiCostByDay: both, billing: monthly(100, '2020-01-01'), brlRate: 5.5, filters, today })
    expect(view.basis!.uncoveredHarnesses).toEqual(['codex'])
    expect(view.basis!.apiCostUSD).toBe(200)
  })

  test('a negative residue reads as nothing missing, not as a fault', () => {
    // The Claude day series is the max-merge of the daily token series and the per-session costs,
    // so accounting for more than the cumulative aggregate is expected rather than contradictory.
    // Nothing of the headline is then missing from the comparison — which is what zero says.
    const view = computePlanBasisView({
      apiCostByDay: series({ '2026-04-05': 100 }, 'claude', -20),
      billing: monthly(100, '2020-01-01'),
      brlRate: 5.5, filters, today,
    })
    expect(view.basis).not.toBeNull()
    expect(view.basis!.coverage.undatedApiCostUSD).toBe(0)
  })

  test('the undated residue is Claude-only, never multiplied across harnesses', () => {
    const both: ApiCostByDay = {
      days: {
        claude: { '2026-04-05': { costUSD: 200, tokens: 1e6, sessions: 1 } },
        codex: { '2026-04-05': { costUSD: 50, tokens: 1e6, sessions: 1 } },
      },
      undatedCostUSD: 900, undatedTokens: 0, firstDay: '2026-04-05', lastDay: '2026-04-05',
    }
    const view = computePlanBasisView({
      apiCostByDay: both,
      billing: {
        profiles: {
          claude: monthly(100, '2020-01-01').profiles.claude,
          codex: { periods: [{ id: 'bp_c', mode: 'api', planId: 'api-payg', from: '2020-01-01' }] },
        },
      },
      brlRate: 5.5, filters, today,
    })
    expect(view.basis!.perHarness.claude!.coverage.undatedApiCostUSD).toBe(900)
    expect(view.basis!.perHarness.codex!.coverage.undatedApiCostUSD).toBe(0)
    expect(view.basis!.coverage.undatedApiCostUSD).toBe(900)
  })

  test('no data at all yields no window and no basis', () => {
    const view = computePlanBasisView({
      apiCostByDay: { days: {}, undatedCostUSD: 0, undatedTokens: 0, firstDay: null, lastDay: null },
      billing: monthly(100, '2020-01-01'), brlRate: 5.5, filters, today,
    })
    expect(view.basis).toBeNull()
    expect(view.blocked).toBe('no-window')
  })

  test('an empty timeline yields a window but an uncomputable basis', () => {
    const view = computePlanBasisView({
      apiCostByDay: series({ '2026-04-05': 100 }),
      billing: { profiles: {} }, brlRate: 5.5, filters, today,
    })
    expect(view.window).not.toBeNull()
    expect(view.basis!.coverage.computable).toBe(false)
    expect(view.basis!.multiple).toBeNull()
  })

  test('api-mode days give a multiple of exactly one', () => {
    const view = computePlanBasisView({
      apiCostByDay: series({ '2026-04-05': 340 }),
      billing: { profiles: { claude: { periods: [{ id: 'bp_x', mode: 'api', planId: 'api-payg', from: '2020-01-01' }] } } },
      brlRate: 5.5, filters, today,
    })
    expect(view.basis!.multiple).toBe(1)
    expect(view.basis!.planCostUSD).toBe(340)
  })

})

/** Run `fn` with the runtime in `zone` and, optionally, the clock stopped at `now`. */
function inZone(zone: string, fn: () => void, now?: string): void {
  const previous = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  process.env.TZ = zone
  if (now) setSystemTime(new Date(now))
  try { fn() } finally {
    setSystemTime()
    process.env.TZ = previous
  }
}

// `apiCostByDay` is keyed by LOCAL day, so the window must be cut on the local calendar too.
describe('computePlanBasisView follows the local calendar', () => {
  // New York includes its spring-forward day (2026-03-08); Santiago skips local midnight on
  // 2026-09-06.
  for (const zone of ['UTC', 'America/Sao_Paulo', 'Asia/Tokyo', 'America/New_York', 'America/Santiago']) {
    test(`days outside the window are not counted as an uncovered gap (${zone})`, () => inZone(zone, () => {
      // They are out of scope, not unregistered — reporting them would invent a gap the user cannot
      // act on.
      const view = computePlanBasisView({
        apiCostByDay: series({ '2026-04-01': 10, '2026-04-30': 10 }),
        billing: monthly(100, '2020-01-01'),
        brlRate: 5.5,
        filters: { ...filters, dateRange: 'all', customStart: '2026-04-01', customEnd: '2026-04-10' },
        today,
      })
      expect(view.window).toEqual({ from: '2026-04-01', to: '2026-04-10' })
      expect(view.basis!.perHarness.claude!.coverage.excludedSessions).toBe(0)
      expect(view.basis!.apiCostUSD).toBe(10)
    }))

    test(`a window across a clock change is those days exactly (${zone})`, () => inZone(zone, () => {
      for (const [from, to] of [['2026-03-08', '2026-03-08'], ['2026-09-06', '2026-09-06']] as const) {
        const view = computePlanBasisView({
          apiCostByDay: series({ '2026-03-01': 1, [from]: 7, '2026-09-30': 1 }),
          billing: monthly(100, '2020-01-01'),
          brlRate: 5.5,
          filters: { ...filters, customStart: from, customEnd: to },
          today: '2026-10-30',
        })
        expect(view.window).toEqual({ from, to })
        expect(view.basis!.planCostUSD).toBeCloseTo(100 / AVG_DAYS_PER_MONTH, 9)
      }
    }))
  }

  // 00:30 on April 2nd in Tokyo is still April 1st in UTC; 23:30 on April 1st in São Paulo is
  // already April 2nd in UTC. `today` is the LOCAL day in both.
  for (const [zone, now, localToday] of [
    ['Asia/Tokyo', '2026-04-01T15:30:00Z', '2026-04-02'],
    ['America/Sao_Paulo', '2026-04-02T02:30:00Z', '2026-04-01'],
  ] as const) {
    test(`the Today preset near midnight is the local day alone (${zone})`, () => inZone(zone, () => {
      const view = computePlanBasisView({
        apiCostByDay: series({ '2026-03-31': 5, [localToday]: 40, '2026-04-30': 5 }),
        billing: monthly(100, '2020-01-01'),
        brlRate: 5.5,
        filters: { ...filters, dateRange: 'today' },
      })
      expect(view.window).toEqual({ from: localToday, to: localToday })
      expect(view.basis!.apiCostUSD).toBe(40)
    }, now))
  }
})
