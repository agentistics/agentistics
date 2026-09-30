import { describe, expect, test } from 'bun:test'
import { deriveEventId, sha256Hex, type EventIdInput } from '@agentistics/core'
import {
  copilotEventId, mainAgentIdOf, mcpExecutionIdOf, runIdOf, sessionIdOf, sha256HexNative,
  shutdownEditsToolExecutionId, toolExecutionIdOf,
} from './replay-core'

describe('sha256HexNative', () => {
  test('matches core\'s dependency-free sha256Hex, over ASCII and multi-byte text', () => {
    for (const text of ['', 'a', 'copilot:session-1', 'ção-ção-🎉', '\u{1F600}']) {
      expect(sha256HexNative(text)).toBe(sha256Hex(text))
    }
  })
})

describe('copilotEventId', () => {
  const input: EventIdInput = {
    sourceKind: 'harness', sourceId: 'copilot', sourceRef: 'copilot:s1:1', type: 'tool.requested',
  }

  test('matches core\'s deriveEventId over the same input', () => {
    expect(copilotEventId(input)).toBe(deriveEventId(input))
  })

  test('is stable across calls', () => {
    expect(copilotEventId(input)).toBe(copilotEventId({ ...input }))
  })

  test('is distinct across a different sourceRef', () => {
    expect(copilotEventId(input)).not.toBe(copilotEventId({ ...input, sourceRef: 'copilot:s1:2' }))
  })

  test('is distinct across a different type', () => {
    expect(copilotEventId(input)).not.toBe(copilotEventId({ ...input, type: 'tool.completed' }))
  })
})

describe('entity ids', () => {
  test('are stable across calls for the same session id', () => {
    expect(sessionIdOf('s1')).toBe(sessionIdOf('s1'))
    expect(runIdOf('s1')).toBe(runIdOf('s1'))
    expect(mainAgentIdOf('s1')).toBe(mainAgentIdOf('s1'))
  })

  test('are distinct across two session ids', () => {
    expect(sessionIdOf('s1')).not.toBe(sessionIdOf('s2'))
    expect(runIdOf('s1')).not.toBe(runIdOf('s2'))
    expect(mainAgentIdOf('s1')).not.toBe(mainAgentIdOf('s2'))
  })

  test('session/run/agent ids are distinct from each other for the SAME session id (different prefixes/namespaces)', () => {
    const ids = new Set([sessionIdOf('s1'), runIdOf('s1'), mainAgentIdOf('s1')])
    expect(ids.size).toBe(3)
  })

  test('toolExecutionIdOf is stable and distinct per (sessionId, toolCallId)', () => {
    expect(toolExecutionIdOf('s1', 'tool-1')).toBe(toolExecutionIdOf('s1', 'tool-1'))
    expect(toolExecutionIdOf('s1', 'tool-1')).not.toBe(toolExecutionIdOf('s1', 'tool-2'))
    expect(toolExecutionIdOf('s1', 'tool-1')).not.toBe(toolExecutionIdOf('s2', 'tool-1'))
  })

  test('mcpExecutionIdOf is stable and distinct per (sessionId, ordinal)', () => {
    expect(mcpExecutionIdOf('s1', 0)).toBe(mcpExecutionIdOf('s1', 0))
    expect(mcpExecutionIdOf('s1', 0)).not.toBe(mcpExecutionIdOf('s1', 1))
  })

  test('shutdownEditsToolExecutionId is stable and distinct per session id, and never collides with a real toolCallId-keyed id', () => {
    expect(shutdownEditsToolExecutionId('s1')).toBe(shutdownEditsToolExecutionId('s1'))
    expect(shutdownEditsToolExecutionId('s1')).not.toBe(shutdownEditsToolExecutionId('s2'))
    expect(shutdownEditsToolExecutionId('s1')).not.toBe(toolExecutionIdOf('s1', 'shutdown-edits'))
  })
})
