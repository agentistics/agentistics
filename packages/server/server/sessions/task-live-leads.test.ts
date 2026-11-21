import { expect, test, describe } from 'bun:test'
import { buildLive } from './task-live'
import { describeLive, type FleetRowLite } from './task-live-view'
import { buildTaskDetail } from './task-report'
import type { LiveDelivery, LiveReply } from './task-live'

// LIVE.LIDER-MULTITAREFA: a leader may lead N tasks (a link apart from the cost filing), and a card that only waits for
// publication (board status `pr_merge`) is not "Revisão do líder".

const NOW = 1_000_000
const d = (over: Partial<LiveDelivery>): LiveDelivery => ({
  key: 'B/a', taskId: 'B', taskTitle: 'Navegador', subtaskId: 'a', title: 'Piece', status: 'in_review', stage: 'leader',
  stageSinceMs: 0, startedAtMs: 0, sessionIds: [], harnesses: [], models: [], efforts: [], eta: { kind: 'none', reason: 'no-history' },
  lastAction: null, blockedReason: null, deliveredAtMs: null, priority: 'low',
  workMs: null, trail: [], stageEta: { kind: 'none', reason: 'no-history' }, publishEta: { kind: 'none', reason: 'no-history' }, block: null, ci: null, step: null, ...over,
})
const reply = (ds: LiveDelivery[]): LiveReply => ({ generatedAt: 'x', deliveries: ds, samples: 0, hidden: [], sessionTasks: {} })
const row = (id: string, state: string, x: Partial<FleetRowLite> = {}): FleetRowLite => ({ id, title: id, harness: 'claude', state, ...x })
const stageOf = (o: { rows: FleetRowLite[]; leads?: Record<string, string[]> }) =>
  describeLive({
    reply: reply([d({})]), rows: o.rows, leaderIds: new Set(['L']),
    ...(o.leads ? { leadsOf: new Map(Object.entries(o.leads)) } : {}), nowMs: NOW,
  }).deliveries[0]!.displayStage

describe('the Live reads the leadership link', () => {
  test('a leader filed on A that declared B: B is not "Sem líder"', () => {
    expect(stageOf({ rows: [row('L', 'working', { task: 'A' })], leads: { L: ['B'] } })).toBeUndefined()
  })
  test('no declaration: the leader filed elsewhere leaves B in "Sem líder" (the reported bug)', () => {
    expect(stageOf({ rows: [row('L', 'working', { task: 'A' })] })).toBe('no-leader')
  })
  test('the leader closed: B returns to "Sem líder"', () => {
    expect(stageOf({ rows: [row('L', 'exited', { task: 'A' })], leads: { L: ['B'] } })).toBe('no-leader')
  })
  test('a declaration for another task does not cover B', () => {
    expect(stageOf({ rows: [row('L', 'working', { task: 'A' })], leads: { L: ['C'] } })).toBe('no-leader')
  })
  test('a declaration of a session that is not a leader does not count', () => {
    const v = describeLive({ reply: reply([d({})]), rows: [row('W', 'working', { task: 'A' })], leaderIds: new Set(), leadsOf: new Map([['W', ['B']]]), nowMs: NOW })
    expect(v.deliveries[0]!.displayStage).toBe('no-leader')
  })
})

describe('waiting publication leaves the leader review', () => {
  const taskId = 'tp'
  const old = '2026-11-12T10:00:00.000Z'
  const now = Date.parse('2026-11-13T15:00:00.000Z')
  const task = { id: taskId, title: 'T', status: 'in_progress', createdAt: old, updatedAt: old }
  const sub = (status: string) => ({ id: 's1', taskId, title: 's1', status, done: false, createdAt: old, updatedAt: old })
  const stage = (status: string, rec?: object, statusStage?: (id: string) => 'leader' | undefined) => {
    const detail = buildTaskDetail({ task, subtasks: [sub(status)], rows: [], metas: new Map(), attempts: [], comments: [], files: [], costOf: () => 0 } as never)
    const out = buildLive({ details: [detail], nowMs: now, events: [], ...(rec ? { deliveries: new Map([['s1', rec]]) as never } : {}), ...(statusStage ? { statusStage: statusStage as never } : {}) })
    return out.deliveries.find(x => x.subtaskId === 's1')?.stage
  }
  test('board status pr_merge is the merge stage', () => { expect(stage('pr_merge')).toBe('merge') })
  test('a wrongly stored stage on the pr_merge status cannot put it back in the leader review', () => { expect(stage('pr_merge', undefined, () => 'leader')).toBe('merge') })
  test('a stale revisao_lider record under a pr_merge board status follows the board', () => { expect(stage('pr_merge', { phase: 'revisao_lider' })).toBe('merge') })
  test('control: a real review stays in the leader review', () => { expect(stage('in_review', { phase: 'revisao_lider' })).toBe('leader') })
})
