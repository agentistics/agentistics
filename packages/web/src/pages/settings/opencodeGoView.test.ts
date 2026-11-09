import { describe, expect, test } from 'bun:test'
import { goUsage, opencodePlan, type GoCostRow } from '@agentistics/core'
import { fmtUsd, ocUsageView, pctOf, type OcUsageReply } from './opencodeGoView'

const NOW = Date.parse('2026-11-06T12:00:00Z')
const head = (id: 'go' | 'zen' | 'none', chosen = false): OcUsageReply['plan'] => {
  const p = opencodePlan(id)
  return { id, label: p.label, priceUsd: p.priceUsd, perMember: p.perMember === true, chosen }
}
const reply = (rows: GoCostRow[], extra: Partial<OcUsageReply> = {}): OcUsageReply =>
  ({ plan: head('go'), usage: goUsage(rows, 'go', NOW), estimated: true, now: NOW, ...extra })

describe('fmtUsd', () => {
  test('dollars, cents and sub-cent amounts', () => {
    expect(fmtUsd(12)).toBe('US$ 12')
    expect(fmtUsd(3.456)).toBe('US$ 3.46')
    expect(fmtUsd(0)).toBe('US$ 0')
    expect(fmtUsd(0.0045261)).toBe('US$ 0.0045')
    expect(fmtUsd(0.2)).toBe('US$ 0.20')
  })
  test('pctOf never goes negative and may pass 100', () => {
    expect(pctOf(-1)).toBe(0)
    expect(pctOf(0.456)).toBe(46)
    expect(pctOf(1.5)).toBe(150)
  })
})

describe('ocUsageView', () => {
  test('quota is unknown while local costs remain available separately', () => {
    const v = ocUsageView(reply([{ model: 'glm-5.3', costUsd: 1.5, at: NOW - 3_600_000 }]), false)
    expect(v.title).toBe('OpenCode Go')
    expect(v.price).toBe('US$ 10/month')
    expect(v.rings.map(r => r.kind)).toEqual(['5h', 'week', 'month'])
    // glm-5.3 on Go: 15 monthly -> 3 (5 h), 7.5 (week), 15 (month)
    expect(v.rings[0]).toMatchObject({ pct: null, detail: 'unknown', model: 'glm-5.3' })
    expect(v.rings[2]).toMatchObject({ pct: null, detail: 'unknown', model: 'glm-5.3' })
    expect(v.models[0]).toMatchObject({ model: 'glm-5.3', pct: null, amount: 'US$ 1.50', trains: false })
  })
  test('a Muse Spark model is flagged as training on the data', () => {
    const v = ocUsageView(reply([{ model: 'muse-spark-1.3-contributor', costUsd: 1, at: NOW - 1000 }]), true)
    expect(v.models[0]!.trains).toBe(true)
  })
  test('no use: no rings, a sentence saying so (never a zero ring)', () => {
    const v = ocUsageView(reply([]), true)
    expect(v.rings).toEqual([])
    expect(v.notes.join(' ')).toContain('Nenhuma resposta')
  })
  test('zen / none: no per-window limits and the reason is said', () => {
    const v = ocUsageView({ plan: head('zen'), usage: null, reason: 'no-go-plan', estimated: true, now: NOW }, false)
    expect(v.rings).toEqual([])
    expect(v.showEstimate).toBe(false)
    expect(v.price).toBe('pay-as-you-go credit')
    expect(v.notes[0]).toContain('OpenCode Zen')
  })
  test('unreadable store and unlisted models are said', () => {
    expect(ocUsageView({ plan: head('go'), usage: null, reason: 'unreadable', estimated: true, now: NOW }, false).notes.join(' ')).toContain('Could not read')
    const v = ocUsageView(reply([{ model: 'brand-new', costUsd: 1, at: NOW - 1000 }]), false)
    expect(v.notes.join(' ')).toContain('brand-new')
  })
  test('basis says whether the plan was chosen or inferred', () => {
    expect(ocUsageView(reply([], { plan: head('go', true) }), false).basis).toBe('chosen by you')
    expect(ocUsageView(reply([]), false).basis).toBe('inferred from the key')
  })
  test('a provider refusal takes precedence over reassuring local cost estimates', () => {
    const r = reply([], { blocked: { at: NOW, message: 'Go usage limit exceeded' } })
    expect(ocUsageView(r, true).notes[0]).toContain('Go bloqueado')
    expect(ocUsageView(r, false).notes[0]).toContain('Reset unknown')
  })
})
