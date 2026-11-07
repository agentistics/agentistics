import { describe, expect, test } from 'bun:test'
import { queueOfRecord } from './task-live'

describe('queueOfRecord (FILA.PRIORIDADE) — the queue facts a Live card carries, from the delivery record', () => {
  const nowMs = Date.parse('2026-11-07T18:00:00Z')

  test('nothing to say for a piece that is just waiting its turn', () => {
    expect(queueOfRecord(undefined, nowMs)).toBeNull()
    expect(queueOfRecord({}, nowMs)).toBeNull()
  })

  test('an active nao or agendar, an open question and an approval are reported; a lapsed schedule is nothing', () => {
    expect(queueOfRecord({ queueHold: { kind: 'nao', reason: 'r', at: '2026-11-07T17:00:00Z', actor: 'lead' } }, nowMs))
      .toEqual({ hold: { kind: 'nao', reason: 'r', until: null, by: 'lead', atMs: Date.parse('2026-11-07T17:00:00Z') }, asking: false, approved: false })
    expect(queueOfRecord({ queueHold: { kind: 'agendar', reason: 'r', at: '2026-11-07T17:00:00Z', actor: 'lead', until: '2026-11-07T19:00:00Z' } }, nowMs)?.hold?.until).toBe('2026-11-07T19:00:00Z')
    expect(queueOfRecord({ queueHold: { kind: 'agendar', reason: 'r', at: '2026-11-07T17:00:00Z', actor: 'lead', until: '2026-11-07T17:30:00Z' } }, nowMs)).toBeNull()
    expect(queueOfRecord({ queueAsk: {} }, nowMs)).toEqual({ hold: null, asking: true, approved: false })
    expect(queueOfRecord({ queueAsk: { approved: { actor: 'l' } } }, nowMs)).toEqual({ hold: null, asking: false, approved: true })
  })
})
