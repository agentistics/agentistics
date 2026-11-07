import { describe, expect, test } from 'bun:test'
import {
  byStage, orderColumns, queuePosition, etaText, filterCards, fmtSpan, joinLive, liveStateOf, summarize,
  type LiveCard, type LiveDeliveryRecord,
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
  test('"apenas ativas" is about the flow, not about a live agent: a card in ANY flow column survives it', () => {
    // Owner 07/11: "active" = the card sits in a flow column. The old rule demanded a RUNNING session, so the review card '2' (no agent) vanished.
    expect(filterCards(cards, { taskIds: [], onlyActive: true }).map(c => c.d.key)).toEqual(['1', '2', '3'])
    expect(filterCards(cards, { taskIds: ['B'], onlyActive: false, showQueue: true }).map(c => c.d.key)).toEqual([])
    expect(filterCards(cards, { taskIds: ['A', 'B'], onlyActive: true }).map(c => c.d.key)).toEqual(['1', '2', '3'])
  })
  test('the four combinations of "apenas ativas" x "exibir itens na fila"', () => {
    const mk = (key: string, stage: LiveDeliveryRecord['stage']) => rec({ key, stage })
    const all = joinLive([mk('q', 'queue'), mk('b', 'blocked'), mk('r', 'running'), mk('qa', 'qa'), mk('l', 'leader'), mk('m', 'merge'), mk('c', 'ci'), mk('p', 'published')], [])
    const keys = (onlyActive: boolean, showQueue: boolean) => filterCards(all, { taskIds: [], onlyActive, showQueue }).map(c => c.d.key)
    const after = ['b', 'r', 'qa', 'l', 'm', 'c', 'p']
    expect(keys(true, true)).toEqual(['q', ...after])            // both on (the default): everything in the flow
    expect(keys(true, false)).toEqual(after)                       // active only: Bloqueado onward, queue hidden
    expect(keys(false, true)).toEqual(['q'])                       // queue only
    expect(keys(false, false)).toEqual([])                         // neither
  })
  test('a queued piece NEVER has an agent and is still shown by the default switches (print ee004953)', () => {
    const q = joinLive([rec({ key: 'q', stage: 'queue', sessionIds: [] })], [])
    expect(filterCards(q, { taskIds: [], onlyActive: true, showQueue: true })).toHaveLength(1)
    // an older caller that knows no `showQueue` keeps the queue visible
    expect(filterCards(q, { taskIds: [], onlyActive: true })).toHaveLength(1)
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

describe('column order', () => {
  const mk = (key: string, since: number, priority?: string, stage: LiveDeliveryRecord['stage'] = 'queue') =>
    ({ d: rec({ key, stage, stageSinceMs: since, ...(priority ? { priority } : {}) }), agents: [], alert: false, liveState: 'idle' }) as never as LiveCard
  test('by time in the stage, queued cards read 1st first from the top of the column', () => {
    const cards = [mk('c', 30), mk('a', 10), mk('b', 20)]
    const cols = orderColumns(byStage(cards), 'time-in-stage')
    expect(cols.queue.map(c => queuePosition(cards, c))).toEqual([1, 2, 3])
  })
  test('DEFAULT: every column lists the highest priority first, a tie goes to the longest in the stage', () => {
    const cards = [mk('low-old', 1, 'low'), mk('urgent-new', 90, 'urgent'), mk('high-old', 5, 'high'), mk('high-new', 50, 'high'), mk('none', 0), mk('run-low', 3, 'low', 'running'), mk('run-urgent', 80, 'urgent', 'running')]
    const cols = orderColumns(byStage(cards), 'priority')
    expect(cols.queue.map(c => c.d.key)).toEqual(['urgent-new', 'high-old', 'high-new', 'none', 'low-old'])
    expect(cols.running.map(c => c.d.key)).toEqual(['run-urgent', 'run-low'])
  })
  test('"most recent" puts the newest arrival first; the position shown follows the chosen order', () => {
    const cards = [mk('a', 10), mk('b', 30), mk('c', 20)]
    const cols = orderColumns(byStage(cards), 'recent')
    expect(cols.queue.map(c => c.d.key)).toEqual(['b', 'c', 'a'])
    expect(cols.queue.map(c => queuePosition(cards, c, 'recent'))).toEqual([1, 2, 3])
  })
})
