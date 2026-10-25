import { describe, expect, it } from 'bun:test'
import { areaBadges } from './areaBadges'

describe('areaBadges', () => {
  it('check-in warnings join Sessions even if fleet attention has not answered', () => {
    expect(areaBadges({ checkinsOverdue: 2 })).toEqual({ sessions: 2 })
    expect(areaBadges({ attention: 4, checkinsOverdue: 0 })).toEqual({ sessions: 4 })
  })
  it('maps each source to its area', () => {
    expect(areaBadges({
      attention: 4,
      usageRows: [{ paceStatus: 'over' }, { status: 'hold' }, { paceStatus: 'under' }],
      checkinsOverdue: 2,
    })).toEqual({ sessions: 6, usage: 2 })
  })
  it('leaves the key absent when the source did not answer or counts zero', () => {
    expect(areaBadges({})).toEqual({})
    expect(areaBadges({ attention: 0, usageRows: [{ paceStatus: 'under' }], checkinsOverdue: 0 })).toEqual({})
  })
})

describe('the Uso badge counts what the Uso page calls over pace', () => {
  it('a tight budget is over pace on the page, so it lights the badge too', async () => {
    const { usageHeadline } = await import('./usagePlan')
    const rows = [{ status: 'tight' }, { status: 'ok', paceStatus: 'over' }, { status: 'ok', paceStatus: 'on' }] as const
    expect(areaBadges({ usageRows: rows })).toEqual({ usage: 2 })
    // The page's own sentence reads the same rows the same way.
    expect(usageHeadline(rows as never, 0, 'pt')).toBe('2 de 3 planos acima do ritmo.')
  })
})
