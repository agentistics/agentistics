/**
 * LIVE.COLUNAS-PRESAS C3 — who leads a task, from the REAL registry of the reporting machine (2026-11-23, reduced to ids,
 * filing and succession). The Motor leader 400fd19590 is filed on t-e1dea7cd6f only; NAVEGADOR (t-fafa9876d3) and
 * DURABILIDADE (t-79061d4f20) are conducted by it (it started their workers) and by its predecessors (handoff chain
 * 25a1… → 538e… → 5556… → f5e5… → d172… → 400fd…). On 1c280d2be their review cards read "Sem líder".
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inheritedLeads, mergeLeads, successorOf, type SuccessionRow } from './leader-succession'
import { describeLive } from './task-live-view'
import type { LiveDelivery, LiveReply } from './task-live'

const { rows } = JSON.parse(readFileSync(join(import.meta.dir, '__fixtures__/live-colunas/registry-succession.json'), 'utf8')) as { rows: SuccessionRow[] }
const LIVE = new Set(['400fd19590', '3fb06f9a15']) // the two leaders alive that morning
const MOTOR = '400fd19590'

describe('succession and parenthood', () => {
  test('a predecessor anywhere up the handoff chain resolves to the live leader', () => {
    const byId = new Map(rows.map(r => [r.id, r]))
    expect(successorOf('25a1ec328e', byId, LIVE)).toBe(MOTOR)
    expect(successorOf('d17203308c', byId, LIVE)).toBe(MOTOR)
    // The Jarvis leader closed without a successor: nobody inherits its task.
    expect(successorOf('f4e4646a51', byId, LIVE)).toBeNull()
  })
  test('the Motor leader leads NAVEGADOR and DURABILIDADE through the workers it started; Jarvis stays orphaned', () => {
    const led = inheritedLeads(rows, LIVE).get(MOTOR) ?? []
    expect(led).toContain('t-fafa9876d3')
    expect(led).toContain('t-79061d4f20')
    expect([...inheritedLeads(rows, LIVE).values()].flat()).not.toContain('t-3648b62bee')
  })
  test('a cycle in the chain ends (no live leader) instead of looping', () => {
    const loop: SuccessionRow[] = [{ id: 'a', handoffTo: 'b' }, { id: 'b', handoffTo: 'a' }, { id: 'w', taskId: 't', parentSessionId: 'a' }]
    expect(inheritedLeads(loop, new Set(['z'])).size).toBe(0)
  })
})

describe('the Live reads it: a NAVEGADOR review card is "Revisão do líder", not "Sem líder"', () => {
  const card = (taskId: string, sub: string): LiveDelivery => ({
    key: `${taskId}/${sub}`, taskId, taskTitle: taskId, subtaskId: sub, title: sub, status: 'in_review', stage: 'leader', stageSinceMs: 0,
    round: { number: 1, startedAtMs: 0 }, startedAtMs: null, sessionIds: [], linkSessionIds: [], harnesses: [], models: [], efforts: [],
    eta: { kind: 'none', reason: 'no-history' }, workMs: null, trail: [], stageEta: { kind: 'none', reason: 'no-history' },
    publishEta: { kind: 'none', reason: 'no-history' }, block: null, ci: null, step: null, lastAction: null, blockedReason: null,
    priority: 'low', deliveredAtMs: null,
  } as unknown as LiveDelivery)
  const reply: LiveReply = { generatedAt: '', deliveries: [card('t-fafa9876d3', 's-bb72b4199c'), card('t-3648b62bee', 's-jarvis')], hidden: [], sessionTasks: {}, samples: 0 }
  const fleet = [{ id: MOTOR, title: '[ LÍDER ] - Motor', harness: 'claude', state: 'working', task: 't-e1dea7cd6f' }]
  const view = (leadsOf: Map<string, readonly string[]>) => describeLive({ reply, rows: fleet as never, leaderIds: new Set([MOTOR]), leadsOf, nowMs: 1, filters: { tab: 'all', period: 'all' } })
  test('with the inherited leads merged in', () => {
    const v = view(mergeLeads(new Map(), inheritedLeads(rows, LIVE)))
    expect(v.deliveries.find(d => d.subtaskId === 's-bb72b4199c')?.leaderAvailability).toBe('available')
    expect(v.deliveries.find(d => d.subtaskId === 's-jarvis')?.leaderAvailability).toBe('absent')
  })
})
