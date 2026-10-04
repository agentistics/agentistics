import { describe, expect, test } from 'bun:test'
import type { AnyAgentisticsEvent } from '@agentistics/core'
import { memoryProjection } from './memory'

const ev = (eventId: string, type: 'memory.noted' | 'memory.forgotten', at: string, data: Record<string, unknown>): AnyAgentisticsEvent => ({
  eventId, type, occurredAt: at, recordedAt: at, sessionId: 'ses_1', data,
  source: { kind: 'native', id: 'agentistics' }, provenance: { confidence: 'exact' },
} as unknown as AnyAgentisticsEvent)
const noted = (id: string, at: string, extra: Record<string, unknown> = {}) => ev(`e_${id}`, 'memory.noted', at, {
  factId: id, chainId: 'c1', scope: 'repo', repoKey: 'github.com/a/b', category: 'convention', statement: { sha256: id.padEnd(64, '0'), bytes: 10 }, origin: 'person', ...extra,
})
const run = (events: AnyAgentisticsEvent[]) => {
  const s = memoryProjection.empty()
  memoryProjection.fold(s, events)
  return memoryProjection.finish(s)
}

describe('B6.6: the memory projection', () => {
  test('a superseded version is closed at the new one\'s time, not overwritten; order does not matter', () => {
    const a = noted('f1', '2026-10-01T00:00:00Z')
    const b = noted('f2', '2026-10-02T00:00:00Z', { supersedes: 'f1' })
    for (const order of [[a, b], [b, a], [a, b, a]]) {
      const r = run(order)
      expect(r.versions.map(v => [v.factId, v.validTo])).toEqual([['f1', '2026-10-02T00:00:00Z'], ['f2', null]])
    }
  })
  test('forgetting leaves no row of the chain', () => {
    const r = run([noted('f1', '2026-10-01T00:00:00Z'), ev('e_x', 'memory.forgotten', '2026-10-03T00:00:00Z', { chainId: 'c1' })])
    expect(r).toMatchObject({ forgotten: true, versions: [] })
  })
  test('other events are not memory', () => {
    expect(run([ev('e_o', 'memory.noted', 'x', {})]).versions).toEqual([])
  })
})
