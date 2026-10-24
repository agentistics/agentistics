import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { HandoffBand, HandoffQuotaCell, handoffLevelLabel } from './HandoffWarning'
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

describe('quota cell explanations', () => {
  it('renders a dash with a tooltip for each missing-data cause in both languages', () => {
    for (const pt of [true, false]) for (const reason of ['no-meter', 'account-unknown', 'missing-window', undefined] as const) {
      const html = renderToStaticMarkup(<HandoffQuotaCell value={null} costUSD={1} reason={reason} label="Week" pt={pt} />)
      expect(html).toContain('>—</span>')
      expect(html).toMatch(/title="[^"]+"/)
    }
  })
  it('renders available percentages without an unavailable tooltip', () => {
    const html = renderToStaticMarkup(<HandoffQuotaCell value={2.5} costUSD={1} reason="missing-window" label="Week" pt={false} />)
    expect(html).toContain('+2.5%')
    expect(html).not.toContain('title=')
  })
})
