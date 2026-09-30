/** The `gen_metadata` fold — P2 §2's traps for agy, each pinned against a row built on the wire. */
import { describe, expect, test } from 'bun:test'
import type { AgentisticsEvent, ModelCompletedData } from '@agentistics/core'
import { encodeGenMetadata, type FixtureRow } from './fixture-db'
import { mainContext } from './replay-core'
import { dominantModel, emptyGenMetaFold, foldGenMetadataRows, genMetadataTimestamp, type GenMetadataRow } from './replay-genmeta'

const ctx = mainContext('conv-1', '2027-01-01T00:00:00.000Z')
const row = (idx: number, r: Omit<FixtureRow, 'idx'>): GenMetadataRow => ({ idx, data: encodeGenMetadata({ ...r, idx }) })

function fold(rows: GenMetadataRow[], fallbackAt = '2026-08-14T10:00:00.000Z') {
  const events: AgentisticsEvent[] = []
  const s = emptyGenMetaFold(ctx, fallbackAt)
  foldGenMetadataRows(s, rows, e => events.push(e))
  return { events: events as AgentisticsEvent<'model.completed'>[], s }
}

describe('agy gen_metadata → model.completed', () => {
  test('one event per row; 1.4.3 already holds 1.4.9; 1.4.1 is in no counter; cache write ABSENT', () => {
    const { events } = fold([row(0, { sys: 1072, input: 1800, output: 129, thinking: 86, completion: 43, cached: 55, ctx: 2000, window: 128000, model: 'gemini-3.6-flash', ts: [1786701605, 0] })])
    expect(events).toHaveLength(1)
    const d = events[0]!.data as ModelCompletedData
    expect(d.usage).toEqual({ input: 1800, output: 129, cacheRead: 55 })
    expect('cacheWrite' in d.usage).toBe(false)
    expect(d.reasoning).toEqual({ tokens: 86, billing: 'included-in-output' })
    expect(d.contextTokens).toBe(2000)
    expect(d.contextWindow).toBe(128000)
    expect(d.model).toBe('gemini-3.6-flash')
    expect(d.provider).toBe('google')
    expect(events[0]!.provenance.confidence).toBe('exact')
    expect(JSON.stringify(d)).not.toContain('1072')
  })

  test('the gauge is per call, never summed', () => {
    const { events } = fold([
      row(0, { input: 10, ctx: 2000, ts: [1786701605, 0] }),
      row(1, { input: 10, ctx: 4100, ts: [1786701610, 0] }),
    ])
    expect(events.map(e => (e.data as ModelCompletedData).contextTokens)).toEqual([2000, 4100])
  })

  test('occurredAt is 1.9.4; a row without one borrows the last instant and is estimated', () => {
    const { events } = fold([
      row(0, { input: 1 }),
      row(1, { input: 1, ts: [1786701605, 500_000_000] }),
      row(2, { input: 1 }),
    ])
    expect(events.map(e => [e.occurredAt, e.provenance.confidence])).toEqual([
      ['2026-08-14T10:00:00.000Z', 'estimated'],
      ['2026-08-14T10:00:05.500Z', 'exact'],
      ['2026-08-14T10:00:05.500Z', 'estimated'],
    ])
    expect(genMetadataTimestamp(encodeGenMetadata({ idx: 0, ts: [1786701605, 0] }))).toBe('2026-08-14T10:00:05.000Z')
    expect(genMetadataTimestamp(new Uint8Array([0xff, 0xff]))).toBeNull()
  })

  test('an undecodable row is skipped and counted; folding is strictly forward and chunk-independent', () => {
    const rows = [row(0, { input: 5, ts: [1786701605, 0] }), { idx: 1, data: new Uint8Array([]) }, row(2, { input: 7 })]
    const whole = fold(rows)
    expect(whole.events).toHaveLength(2)
    expect(whole.s.undecoded).toBe(1)
    const events: AgentisticsEvent[] = []
    const s = emptyGenMetaFold(ctx, '2026-08-14T10:00:00.000Z')
    foldGenMetadataRows(s, rows.slice(0, 1), e => events.push(e))
    foldGenMetadataRows(s, rows, e => events.push(e)) // row 0 again: ignored
    expect(events).toEqual(whole.events)
  })

  test('the dominant model is the most frequent 1.19 — the rule legacy labels a session with', () => {
    expect(dominantModel([row(0, { model: 'a' }), row(1, { model: 'b' }), row(2, { model: 'b' }), row(3, {})])).toBe('b')
  })
})
