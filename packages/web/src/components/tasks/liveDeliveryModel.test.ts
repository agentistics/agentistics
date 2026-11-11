import { describe, expect, test } from 'bun:test'
import {
  byStage, orderColumns, queuePosition, etaText, filterCards, fmtSpan, joinLive, liveStateOf, summarize, tabCounts,
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
  test('keeps an idle agent on its delivery card', () => {
    const [c] = joinLive([rec({ sessionIds: ['idle'] })], [row('idle', 'idle', { harness: 'hermes' })])
    expect(c!.agents).toHaveLength(1)
    expect(c!.agents[0]).toMatchObject({ id: 'idle', state: 'idle' })
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
  test('absence projects a review into No leader without changing its real stage; unknown stays in review', () => {
    const [absent] = joinLive([rec({ stage: 'leader', leaderAvailability: 'absent' })], [])
    expect(absent!.d.stage).toBe('leader')
    expect(absent!.displayStage).toBe('no-leader')
    expect(byStage([absent!])['no-leader']).toHaveLength(1)
    const [unknown] = joinLive([rec({ stage: 'leader', leaderAvailability: 'unknown' })], [])
    expect(unknown!.displayStage).toBe('leader')
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
  const NOWMS = 1_000 * 3600_000
  const f = (over: Partial<Parameters<typeof filterCards>[1]> = {}) => ({ taskIds: [], tab: 'all' as const, period: '24h' as const, nowMs: NOWMS, ...over })
  test('"Em andamento" is every open stage — a card with nobody on it is still in progress', () => {
    // Piece '1' has a working agent; '2' (leader review, no agent) is open work too.
    expect(filterCards(cards, f({ tab: 'active' })).map(c => c.d.key)).toEqual(['1', '2'])
    // "Tudo" keeps every piece in its real column; Publicado is inside its period ('3' was published at t=1 ms: long ago).
    expect(filterCards(cards, f({ tab: 'all' })).map(c => c.d.key)).toEqual(['1', '2'])
    expect(filterCards(cards, f({ tab: 'all', period: 'all' })).map(c => c.d.key)).toEqual(['1', '2', '3'])
    expect(filterCards(cards, f({ tab: 'all', taskIds: ['B'] })).map(c => c.d.key)).toEqual(['2'])
    expect(filterCards(cards, f({ tab: 'active', taskIds: ['B'] })).map(c => c.d.key)).toEqual(['2'])
  })
  test('the tabs: Na fila is the queue, Publicado is its own period (24 h, 7 d, 30 d, all), an old review shows only in Tudo', () => {
    const H = 3600_000
    const mk = (key: string, stage: LiveDeliveryRecord['stage'], over: Partial<LiveDeliveryRecord> = {}) => rec({ key, stage, ...over })
    const all = joinLive([
      mk('q', 'queue'), mk('r', 'running', { sessionIds: ['w'] }), mk('l', 'leader'),
      mk('old', 'leader', { old: true, sessionIds: ['w'] }),
      mk('p1', 'published', { deliveredAtMs: NOWMS - 2 * H }), mk('p3', 'published', { deliveredAtMs: NOWMS - 3 * 24 * H }), mk('p40', 'published', { deliveredAtMs: NOWMS - 40 * 24 * H }),
    ], [row('w', 'working')])
    const keys = (tab: 'active' | 'queue' | 'published' | 'all', period: '24h' | '7d' | '30d' | 'all') => filterCards(all, f({ tab, period })).map(c => c.d.key)
    expect(keys('active', '24h')).toEqual(['r', 'l'])                    // not the queue, not published, not the old review
    expect(keys('queue', '24h')).toEqual(['q'])
    expect(keys('published', '24h')).toEqual(['p1'])
    expect(keys('published', '7d')).toEqual(['p1', 'p3'])
    expect(keys('published', '30d')).toEqual(['p1', 'p3'])
    expect(keys('published', 'all')).toEqual(['p1', 'p3', 'p40'])
    expect(keys('all', '24h')).toEqual(['q', 'r', 'l', 'old', 'p1'])
  })
  test('THE COUNTS MATCH THE COLUMNS: each tab prints exactly the number of cards its columns hold, for every period and task filter', () => {
    const H = 3600_000
    const mk = (key: string, stage: LiveDeliveryRecord['stage'], over: Partial<LiveDeliveryRecord> = {}) => rec({ key, stage, ...over })
    const all = joinLive([
      mk('q1', 'queue', { taskId: 'A' }), mk('q2', 'queue', { taskId: 'B' }), mk('r', 'running', { sessionIds: ['w'], taskId: 'A' }), mk('qa', 'qa', { sessionIds: ['x'], taskId: 'B' }),
      mk('l', 'leader'), mk('old', 'leader', { old: true }), mk('b', 'blocked'),
      mk('p1', 'published', { deliveredAtMs: NOWMS - 2 * H, taskId: 'A' }), mk('p5', 'published', { deliveredAtMs: NOWMS - 5 * 24 * H, taskId: 'B' }), mk('p40', 'published', { deliveredAtMs: NOWMS - 40 * 24 * H }),
    ], [row('w', 'working'), row('x', 'waiting')])
    for (const period of ['24h', '7d', '30d', 'all'] as const) {
      for (const taskIds of [[], ['A'], ['B'], ['A', 'B']] as string[][]) {
        const counts = tabCounts(all, { taskIds, period, nowMs: NOWMS })
        for (const tab of ['active', 'queue', 'published', 'all'] as const) {
          const columns = byStage(filterCards(all, { taskIds, tab, period, nowMs: NOWMS }))
          const inColumns = Object.values(columns).reduce((n, cs) => n + cs.length, 0)
          expect(counts[tab]).toBe(inColumns)
        }
      }
    }
    expect(tabCounts(all, { taskIds: [], period: '24h', nowMs: NOWMS })).toEqual({ active: 4, queue: 2, published: 1, all: 8 })
  })
  test('a queued piece NEVER has an agent and still belongs to "Na fila" and "Tudo"', () => {
    const q = joinLive([rec({ key: 'q', stage: 'queue', sessionIds: [] })], [])
    expect(filterCards(q, f({ tab: 'queue' }))).toHaveLength(1)
    expect(filterCards(q, f({ tab: 'all' }))).toHaveLength(1)
    expect(filterCards(q, f({ tab: 'active' }))).toHaveLength(0)
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
