import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { HandoffPanel } from '@agentistics/core'
import { HandoffBand, HandoffQuotaCell, HandoffQuotaNote, LeaderMeterButton, handoffLevelLabel } from './HandoffWarning'
import HandoffSettings from '../../pages/settings/HandoffSettings'

describe('handoff screens', () => {
  it('has distinct warning labels in both languages', () => {
    const levels = ['normal', 'near', 'due', 'overdue'] as const
    for (const pt of [true, false]) expect(new Set(levels.map(l => handoffLevelLabel(l, pt))).size).toBe(4)
  })
  it('keeps the composer band inert until the server identifies an eligible leader', () => {
    const html = renderToStaticMarkup(<HandoffBand id="worker" pt />)
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('inert=""')
    expect(html).not.toContain('handoff-band-wrap visible')
  })
  it('offers four profiles and three warnings with persisted balanced defaults', () => {
    for (const pt of [true, false]) {
      const html = renderToStaticMarkup(<HandoffSettings pt={pt} />)
      expect((html.match(/role="radio"/g) ?? [])).toHaveLength(4)
      expect((html.match(/type="checkbox"/g) ?? [])).toHaveLength(3)
      expect(html).toContain('aria-checked="true"')
      expect(html).toContain(pt ? 'Equilibrado' : 'Balanced')
      expect(html).toContain('value="10"')
      expect(html).toContain(pt ? 'Voltar ao padrão' : 'Reset to default')
    }
  })
})

describe('leader meter (option B)', () => {
  const meter = (level: 'normal' | 'near' | 'due' | 'overdue', contextTokens: number | null, pt: boolean) =>
    renderToStaticMarkup(<LeaderMeterButton panel={{ level, contextTokens, cutTokens: 200_000 }} pt={pt} />)
  it('is a crown circle then the token figure, with no outer capsule or bar', () => {
    const html = meter('normal', 117_000, true)
    expect(html).toContain('class="handoff-meter-crown"')
    expect(html).toContain('lucide-crown')
    expect(html.indexOf('handoff-meter-crown')).toBeLessThan(html.indexOf('handoff-meter-value'))
    expect(html).toContain('>117 mil</span>')
    expect(html).not.toContain('handoff-meter-track')
    expect(meter('normal', 117_000, false)).toContain('>117k</span>')
  })
  it('reacts to the live reading with four states, colour from app tokens', () => {
    for (const [level, tokens, face, tone] of [
      ['normal', 117_000, 'normal', '--accent-green'], ['near', 175_000, 'attention', '--anthropic-orange-light'],
      ['due', 201_000, 'critical', '--accent-red'], ['overdue', 250_000, 'critical', '--accent-red'], ['normal', null, 'none', '--text-secondary'],
    ] as const) {
      const html = meter(level, tokens, true)
      expect(html).toContain(`data-state="${face}"`)
      expect(html).toContain(`--handoff-tone:var(${tone})`)
    }
  })
  it('stays on screen without a reading and says so in words', () => {
    for (const pt of [true, false]) {
      const html = meter('normal', null, pt)
      expect(html).toContain('>—</span>')
      expect(html).toContain(pt ? 'aria-label="Líder · Sem leitura"' : 'aria-label="Leader · No reading"')
    }
  })
})

describe('quota comparison', () => {
  const panel = (reason?: HandoffPanel['quotaUnavailableReason'], costUSD: number | null = 1,
    fiveHourPct: number | null = null, weekPct: number | null = null): Pick<HandoffPanel, 'quotaUnavailableReason' | 'projections'> => ({
    quotaUnavailableReason: reason,
    projections: (['continue', 'extra', 'handoff'] as const).map(kind => ({ kind, contextTokens: 250000, costUSD, fiveHourPct, weekPct })),
  })
  it('uses exactly one decimal in each locale and preserves small positive estimates', () => {
    for (const pt of [true, false]) for (const [value, expected] of [
      [4.5, '+4.5%'], [6, '+6.0%'], [1.27, '+1.3%'], [0, '+0.0%'], [0.1, '+0.1%'],
      [0.099, '&lt;0.1%'], [0.001, '&lt;0.1%'],
    ] as const) {
      const html = renderToStaticMarkup(<HandoffQuotaCell value={value} label="Week" pt={pt} />)
      expect(html).toContain(`>${pt ? expected.replace('.', ',') : expected}</span>`)
      expect(html).not.toContain('title=')
    }
  })
  it('explains every missing-data cause once for all six dash cells, in both languages', () => {
    for (const pt of [true, false]) for (const [reason, cost, explanation] of [
      ['no-meter', 1, pt ? 'Não há limites de uso disponíveis para esta conta.' : 'No usage limits are available for this account.'],
      ['account-unknown', 1, pt ? 'Não foi possível identificar a conta desta sessão.' : 'The account for this session could not be identified.'],
      ['missing-window', 1, pt ? 'A conta não informa uma das janelas de uso.' : 'The account does not report one of the usage windows.'],
      [undefined, null, pt ? 'Faltam dados de contexto ou preço para estimar o consumo.' : 'Context or pricing data is missing to estimate consumption.'],
      [undefined, 1, pt ? 'Ainda não há consumo com preço e horário suficientes para estimar as janelas sem dados.' : 'There is not enough timestamped, priced usage yet to estimate the unavailable windows.'],
    ] as const) {
      const p = panel(reason, cost)
      const html = renderToStaticMarkup(<>{p.projections.map(r => <div key={r.kind}>
        <HandoffQuotaCell value={r.fiveHourPct} label="5 h" pt={pt} /><HandoffQuotaCell value={r.weekPct} label="Week" pt={pt} />
      </div>)}<HandoffQuotaNote panel={p} pt={pt} /></>)
      expect(html.match(/>—<\/span>/g)).toHaveLength(6)
      expect(html).not.toContain('title=')
      expect(html.match(/<small>/g)).toHaveLength(1)
      expect(html.split(explanation)).toHaveLength(2)
      expect(html).toContain(`Sessions. ${explanation}`.replace('Sessions', pt ? 'Sessões' : 'Sessions'))
      expect(html).not.toContain(pt ? 'Quota estimada' : 'Quota estimated')
    }
  })
  it('uses the same table note when either window is missing and retains available estimates', () => {
    for (const pt of [true, false]) for (const [fiveHourPct, weekPct] of [[null, 2.5], [2.5, null]]) {
      const p = panel('missing-window', 1, fiveHourPct!, weekPct!)
      const html = renderToStaticMarkup(<><HandoffQuotaNote panel={p} pt={pt} />
        <HandoffQuotaCell value={fiveHourPct!} label="5 h" pt={pt} /><HandoffQuotaCell value={weekPct!} label="Week" pt={pt} /></>)
      expect(html).toContain(pt ? 'A conta não informa uma das janelas de uso.' : 'The account does not report one of the usage windows.')
      expect(html).toContain(pt ? '+2,5%' : '+2.5%')
      expect(html).toContain('>—</span>')
      expect(html).not.toContain('title=')
    }
  })
  it('keeps the calibration note when every estimate is available', () => {
    for (const pt of [true, false]) {
      const html = renderToStaticMarkup(<HandoffQuotaNote panel={panel(undefined, 1, 2.5, 0)} pt={pt} />)
      expect(html).toContain(pt ? 'Quota estimada pelo consumo medido da conta.' : 'Quota estimated from measured account consumption.')
      expect(html.match(/<small>/g)).toHaveLength(1)
    }
  })
})
