import { describe, expect, test } from 'bun:test'
import {
  byStage, etaText, filterCards, fmtSpan, joinLive, liveStateOf, summarize,
  type LiveDeliveryRecord,
} from './liveDeliveryModel'
import type { FleetRow } from '../../lib/fleet'

const rec = (over: Partial<LiveDeliveryRecord>): LiveDeliveryRecord => ({
  key: 't/s', taskId: 't', taskTitle: 'T', subtaskId: 's', title: 'S', status: 'in_progress', stage: 'running',
  stageSinceMs: 0, startedAtMs: 0, sessionIds: [], harnesses: [], models: [], eta: { kind: 'none', reason: 'no-history' },
  lastAction: null, blockedReason: null, deliveredAtMs: null, ...over,
})
const row = (id: string, state: FleetRow['state'], extra: Partial<FleetRow> = {}): FleetRow =>
  ({ id, title: id, harness: 'claude', cwd: '/', project: 'p', state, stateLabel: state, actionable: true, ...extra }) as FleetRow

describe('joinLive', () => {
  test('joins by session id and reads the fleet state; unknown ids are not live', () => {
    const [c] = joinLive([rec({ sessionIds: ['a', 'gone'] })], [row('a', 'working', { model: 'opus', accountId: 'acc1' })])
    expect(c!.agents).toHaveLength(1)
    expect(c!.agents[0]).toMatchObject({ id: 'a', model: 'opus', accountId: 'acc1' })
    expect(c!.liveState).toBe('working')
    expect(c!.alert).toBe(false)
  })
  test('a dialog waiting on a person is the red card', () => {
    const [c] = joinLive([rec({ sessionIds: ['a'] })], [row('a', 'waiting-approval')])
    expect(c!.liveState).toBe('needs-you')
    expect(c!.alert).toBe(true)
  })
  test('filed sessions the fleet shows nowhere, in a running stage, are an alert too', () => {
    const [c] = joinLive([rec({ sessionIds: ['a'] })], [])
    expect(c!.liveState).toBe('none')
    expect(c!.alert).toBe(true)
  })
  test('adjust with a stated block reason alerts', () => {
    const [c] = joinLive([rec({ stage: 'adjust', blockedReason: 'waiting for codex' })], [])
    expect(c!.alert).toBe(true)
  })
})

describe('liveStateOf', () => {
  const a = (state: FleetRow['state']) => ({ id: state, harness: 'x', model: null, accountId: null, state, stateLabel: state })
  test('priority: needs-you > working > waiting > down', () => {
    expect(liveStateOf([a('waiting'), a('working')])).toBe('working')
    expect(liveStateOf([a('working'), a('waiting-approval')])).toBe('needs-you')
    expect(liveStateOf([a('lost')])).toBe('down')
    expect(liveStateOf([])).toBe('none')
  })
})

describe('filters, grouping, summary', () => {
  const cards = joinLive([
    rec({ key: '1', taskId: 'A', sessionIds: ['a'], stage: 'running', eta: { kind: 'estimate', atMs: 5000, plusMinusMs: 1, confidence: 'high', basis: { n: 5, scope: 'harness', harness: 'claude', model: null, medianMs: 1 } } }),
    rec({ key: '2', taskId: 'B', sessionIds: [], stage: 'leader' }),
    rec({ key: '3', taskId: 'B', sessionIds: ['c'], stage: 'published', deliveredAtMs: 1 }),
  ], [row('a', 'working'), row('c', 'exited')])
  test('only-active keeps cards with an agent alive; a task filter narrows', () => {
    expect(filterCards(cards, { taskId: null, onlyActive: true }).map(c => c.d.key)).toEqual(['1'])
    expect(filterCards(cards, { taskId: 'B', onlyActive: false }).map(c => c.d.key)).toEqual(['2', '3'])
  })
  test('stages group and the summary ignores published', () => {
    expect(byStage(cards).leader).toHaveLength(1)
    const s = summarize(cards, 1000)
    expect(s).toEqual({ deliveries: 2, agentsWorking: 1, nextEtaMs: 5000 })
  })
})

describe('words', () => {
  test('fmtSpan', () => {
    expect(fmtSpan(null)).toBe('—')
    expect(fmtSpan(30_000)).toBe('0 min')
    expect(fmtSpan(38 * 60_000)).toBe('38 min')
    expect(fmtSpan(65 * 60_000)).toBe('1h05')
  })
  test('an ETA always names its source; no history never prints a number', () => {
    const none = etaText({ kind: 'none', reason: 'no-history' }, 'en')
    expect(none.line).toBe('no estimate')
    expect(/\d/.test(none.line)).toBe(false)
    const e = etaText({ kind: 'estimate', atMs: Date.UTC(2026, 10, 6, 12, 0), plusMinusMs: 20 * 60_000, confidence: 'medium', basis: { n: 6, scope: 'harness-model', harness: 'claude', model: 'opus', medianMs: 3_600_000 } }, 'pt')
    expect(e.line).toMatch(/^prevista ~\d\d:\d\d$/)
    expect(e.title).toContain('±20min')
    expect(e.line).not.toMatch(/confian/i)
    expect(e.title).toContain('6 entregas parecidas')
    expect(e.title).toContain('claude · opus')
  })
})
