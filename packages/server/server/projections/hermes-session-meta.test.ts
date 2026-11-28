/**
 * The projection's Hermes rows: the engine replay states turns from adapter 1.0.0, so `TURNS_SINCE` /
 * `TURN_END_SINCE` must list it, and Hermes never states a failed tool call.
 */
import { describe, expect, test } from 'bun:test'
import type { AnyAgentisticsEvent, EventData, EventType } from '@agentistics/core'
import { sessionMetaProjection } from './session-meta'

let seq = 0
function ev<T extends EventType>(type: T, data: EventData[T], at: string, agent = true): AnyAgentisticsEvent {
  seq++
  return {
    eventId: `h${String(seq).padStart(6, '0')}`, schema: 1, type, occurredAt: at, recordedAt: '2026-11-28T00:00:00.000Z',
    source: { kind: 'harness', id: 'hermes' },
    provenance: { mode: 'replayed', confidence: 'exact', adapterVersion: '1.0.0', sourceRef: `hermes:s:${seq}` },
    ...(agent ? { agentId: 'agt_main' } : {}),
    data,
  } as unknown as AnyAgentisticsEvent
}

describe('session-meta projection: hermes 1.0.0', () => {
  test('turns, active time and tool counts are projected; a failed tool is not claimed', () => {
    const state = sessionMetaProjection.empty()
    sessionMetaProjection.fold(state, [
      ev('session.started', { origin: 'adapter', projectPath: '/p' }, '2026-11-01T10:00:00.000Z', false),
      ev('run.started', { harness: 'hermes', conversationId: 's', conversationLink: 'observed' }, '2026-11-01T10:00:00.000Z', false),
      ev('agent.started', { kind: 'main' }, '2026-11-01T10:00:00.000Z'),
      ev('turn.started', { by: 'user' }, '2026-11-01T10:00:00.000Z'),
      ev('tool.requested', { toolExecutionId: 'tex_1', name: 'terminal', canonicalName: 'Bash', kind: 'shell' }, '2026-11-01T10:00:30.000Z'),
      ev('tool.failed', { toolExecutionId: 'tex_1' } as EventData['tool.failed'], '2026-11-01T10:00:40.000Z'),
      ev('turn.ended', { close: 'last-line' }, '2026-11-01T10:02:00.000Z'),
    ])
    const { meta } = sessionMetaProjection.finish(state)
    expect(meta.user_message_count).toBe(1)
    expect(meta.active_minutes).toBe(2)
    expect(meta.tool_counts).toEqual({ Bash: 1 })
    expect(meta.tool_errors).toBe(0)
  })
})
