import { describe, expect, test } from 'bun:test'
import { HANDOFF_MAX_LINES, HANDOFF_TAKEOVER_LINE, ORDERS_HEADING, handoffTemplate, liveOrders } from './handoff-template'
import { contextText } from './agentistics-context'

describe('hand-off template', () => {
  const many = (n: number) => Array.from({ length: n }, (_, k) => `item ${k}`)
  test('opens with the owner orders block, literal and dated', () => {
    const t = handoffTemplate({ title: 'H', orders: [{ at: '2026-10-29T22:15:00Z', text: 'pode cortar tudo' }], state: ['a'], sessions: [], queue: [], decisions: [] })
    expect(t.split('\n').slice(0, 4)).toEqual(['# H', '', `## ${ORDERS_HEADING}`, '- 2026-10-29: "pode cortar tudo"'])
  })
  test('never exceeds 80 lines and keeps every order', () => {
    const orders = [{ at: '2026-10-29T00:00:00Z', text: 'x' }, { at: '2026-10-28T00:00:00Z', text: 'y' }]
    const t = handoffTemplate({ title: 'H', orders, state: many(100), sessions: many(60), queue: many(60), decisions: many(60) })
    expect(t.trimEnd().split('\n').length).toBeLessThanOrEqual(HANDOFF_MAX_LINES)
    expect(t).toContain('"x"'); expect(t).toContain('"y"')
  })
  test('an expired order drops out', () => {
    const now = Date.parse('2026-10-29T00:00:00Z')
    expect(liveOrders([{ at: '2026-10-01T00:00:00Z', text: 'old' }, { at: '2026-10-28T00:00:00Z', text: 'new' }], now).map(o => o.text)).toEqual(['new'])
  })
})

describe('takeover reaches the successor as SYSTEM context, not a prompt', () => {
  const base = { sessionId: 's', cwd: '/w' }
  test('the system context carries it for a hand-off successor and for nobody else', () => {
    expect(contextText({ ...base, role: 'leader', handoffTakeover: true })).toContain(HANDOFF_TAKEOVER_LINE)
    expect(contextText({ ...base, role: 'leader' })).not.toContain(HANDOFF_TAKEOVER_LINE)
  })
  test('the takeover text is not duplicated into the CLI prompt', async () => {
    const src = await Bun.file(new URL('./cli-session.ts', import.meta.url)).text()
    expect(src).toContain('handoffTakeover')
    expect(src).not.toContain('ORDENS VIGENTES')
  })
})
