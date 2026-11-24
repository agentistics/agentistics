import { test, expect } from 'bun:test'
import { buildCalendar } from './deliveryCalendar'

// A live task or subtask must keep the estimated-due flag, the low confidence and the unconfirmed state
// (closes the coverage gap of the `lives` branch of buildCalendar).
test('a live task and subtask keep the estimated due flag, low confidence and unconfirmed state', () => {
  const nowMs = Date.parse('2026-11-24T15:00:00Z')
  for (const subtaskId of ['s', null]) {
    for (const dueEstimated of [true, false]) {
      const date = { dueDate: '2026-11-25', ...(dueEstimated ? { dueEstimated: true } : {}) }
      const result = buildCalendar({ nowMs, resets: [], records: [],
        tasks: [{ id: 't', title: 'T', status: 'in_progress', ...(subtaskId ? {} : date) }],
        subtasks: subtaskId ? [{ id: 's', taskId: 't', title: 'S', status: 'in_progress', ...date }] : [],
        lives: [{ key: subtaskId ? 't/s' : 't', taskId: 't', taskTitle: 'T', subtaskId, title: 'S', stage: 'running',
          startedAtMs: nowMs - 3600000, stageSinceMs: nowMs - 3600000, harnesses: [], models: [],
          eta: { kind: 'estimate', confidence: 'low' }, stageEta: { kind: 'none', reason: 'no-history' },
          publishEta: { kind: 'estimate', atMs: nowMs + 3600000 }, deliveredAtMs: null }],
      })
      expect(result.pieces).toHaveLength(1)
      expect(result.pieces[0]!.dueEstimated).toBe(dueEstimated ? true : undefined)
      expect(result.pieces[0]!.publishEta).toMatchObject({ kind: 'estimate', confidence: dueEstimated ? 'low' : 'owner' })
      expect(result.pieces[0]!.confirmed).toBe(!dueEstimated)
    }
  }
})
