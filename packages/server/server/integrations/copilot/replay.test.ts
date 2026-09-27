import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type { AgentisticsEvent, AnyAgentisticsEvent } from '@agentistics/core'
import { emptyCopilotReplay, finishCopilotReplay, foldCopilotReplay } from './replay'
import { mainContext } from './replay-core'

const FIXTURES = join(import.meta.dir, '..', '..', '..', 'test', 'fixtures')

function replayWhole(content: string, sessionId: string, final = true): AgentisticsEvent[] {
  const events: AgentisticsEvent[] = []
  const ctx = mainContext(sessionId, '2026-01-01T12:00:00.000Z')
  const state = emptyCopilotReplay(ctx)
  foldCopilotReplay(state, content.split('\n'), e => events.push(e))
  finishCopilotReplay(state, { final }, e => events.push(e))
  return events
}

function replayChunked(content: string, sessionId: string, chunkSizes: number[]): AgentisticsEvent[] {
  const lines = content.split('\n')
  const events: AgentisticsEvent[] = []
  const ctx = mainContext(sessionId, '2026-01-01T12:00:00.000Z')
  const state = emptyCopilotReplay(ctx)
  let i = 0
  for (const size of chunkSizes) {
    const chunk = lines.slice(i, i + size)
    i += size
    foldCopilotReplay(state, chunk, e => events.push(e))
    finishCopilotReplay(state, { final: false }, e => events.push(e))
  }
  if (i < lines.length) foldCopilotReplay(state, lines.slice(i), e => events.push(e))
  finishCopilotReplay(state, { final: true }, e => events.push(e))
  return events
}

describe('a clean (session.shutdown) copilot session', () => {
  const content = readFileSync(
    join(FIXTURES, 'copilot-replay-basic', 'session-state', 'redacted-session-1', 'events.jsonl'), 'utf-8',
  )
  // Cast to the DISTRIBUTIVE union (each `type` paired with its own `data` shape) so a `type`
  // check narrows `data` too — `AgentisticsEvent` (the emit callback's own, non-distributive,
  // type) cannot: its `data` is `EventData[EventType]`, a flat union unrelated to `type` by
  // construction. `differential.ts` casts the same way for the same reason.
  const events = replayWhole(content, 'redacted-session-1') as AnyAgentisticsEvent[]

  test('opens session/run/agent exactly once', () => {
    expect(events.filter(e => e.type === 'session.started')).toHaveLength(1)
    expect(events.filter(e => e.type === 'run.started')).toHaveLength(1)
    expect(events.filter(e => e.type === 'agent.started')).toHaveLength(1)
  })

  test('run.started names the harness and the conversation id, observed', () => {
    const run = events.find(e => e.type === 'run.started')!
    expect(run.data).toMatchObject({ harness: 'copilot', conversationId: 'redacted-session-1', conversationLink: 'observed' })
  })

  test('emits tool.requested then tool.completed for the bash call, keyed on the same toolExecutionId', () => {
    const req = events.find(e => e.type === 'tool.requested')
    const comp = events.find(e => e.type === 'tool.completed' && e.provenance.sourceRef?.endsWith(':5'))
    if (!req || req.type !== 'tool.requested') throw new Error('expected a tool.requested event')
    if (!comp || comp.type !== 'tool.completed') throw new Error('expected a tool.completed event')
    expect(req.data).toMatchObject({ name: 'bash', canonicalName: 'Bash', kind: 'shell' })
    expect(comp.data.toolExecutionId).toBe(req.data.toolExecutionId)
  })

  test('emits ONE model.completed for the shutdown model, with the reported usage — no zero-token invention', () => {
    const completed = events.filter(
      (e): e is Extract<AnyAgentisticsEvent, { type: 'model.completed' }> => e.type === 'model.completed',
    )
    expect(completed).toHaveLength(1)
    expect(completed[0]!.data).toMatchObject({
      model: 'gpt-5-mini', usage: { input: 100, output: 20, cacheRead: 10 },
    })
    // cacheWrite was reported as 0, so it IS present (a real 0, not an absence) — D21 distinguishes
    // "reported as zero" from "not reported at all".
    expect(completed[0]!.data.usage.cacheWrite).toBe(0)
  })

  test('closes cleanly: agent/run/session end with status completed', () => {
    expect(events.find(e => e.type === 'agent.ended')!.data).toMatchObject({ status: 'completed' })
    expect(events.find(e => e.type === 'run.ended')!.data).toMatchObject({ status: 'completed' })
    expect(events.filter(e => e.type === 'session.ended')).toHaveLength(1)
  })

  test('the synthetic shutdown code-changes tool.completed exists and carries the reported deltas', () => {
    const shutdownEdit = events.find(e =>
      e.type === 'tool.completed' && e.provenance.sourceRef?.endsWith(':8'))
    expect(shutdownEdit).toBeDefined()
    expect(shutdownEdit!.data).toMatchObject({ linesAdded: 0, linesRemoved: 0 })
  })

  test('no event carries a user.message/assistant.message body (D5)', () => {
    // The fixture's user/assistant message bodies are the placeholder "<redacted>", which is never
    // read by this fold at all — only cwd (a path) and a tool's own redacted shell summary travel.
    for (const e of events) {
      expect(JSON.stringify(e.data)).not.toContain('<redacted>')
    }
  })
})

describe('a crashed (no session.shutdown) copilot session', () => {
  const content = readFileSync(
    join(FIXTURES, 'copilot-replay-crashed', 'session-state', 'redacted-session-2', 'events.jsonl'), 'utf-8',
  )
  const events = replayWhole(content, 'redacted-session-2')

  test('emits run.started/agent.started/tool.requested but NO model.completed at all', () => {
    expect(events.some(e => e.type === 'run.started')).toBe(true)
    expect(events.some(e => e.type === 'tool.requested')).toBe(true)
    expect(events.some(e => e.type === 'model.completed')).toBe(false)
    expect(events.some(e => e.type === 'model.invoked')).toBe(false)
  })

  test('closes as failed, never completed, and never a zero-token model event', () => {
    expect(events.find(e => e.type === 'agent.ended')!.data).toMatchObject({ status: 'failed' })
    expect(events.find(e => e.type === 'run.ended')!.data).toMatchObject({ status: 'failed' })
  })

  test('a still-live (final: false) read of the same content emits no *.ended at all', () => {
    const liveEvents = replayWhole(content, 'redacted-session-2', false)
    expect(liveEvents.some(e => e.type === 'agent.ended')).toBe(false)
    expect(liveEvents.some(e => e.type === 'run.ended')).toBe(false)
    expect(liveEvents.some(e => e.type === 'session.ended')).toBe(false)
  })
})

describe('property: chunk independence', () => {
  const content = readFileSync(
    join(FIXTURES, 'copilot-replay-basic', 'session-state', 'redacted-session-1', 'events.jsonl'), 'utf-8',
  )
  const whole = replayWhole(content, 'redacted-session-1')
  const wholeIds = whole.map(e => e.eventId).sort()

  for (const chunks of [[1, 1, 1, 1, 1, 1, 1, 1], [3, 3, 2], [8], [2, 6], [1, 7]]) {
    test(`chunked as ${JSON.stringify(chunks)} yields the same event ids as folding whole`, () => {
      const got = replayChunked(content, 'redacted-session-1', chunks).map(e => e.eventId).sort()
      expect(got).toEqual(wholeIds)
    })
  }
})

describe('property: idempotency', () => {
  test('finishing twice with nothing new folded emits no duplicate *.ended events', () => {
    const content = readFileSync(
      join(FIXTURES, 'copilot-replay-basic', 'session-state', 'redacted-session-1', 'events.jsonl'), 'utf-8',
    )
    const events: AgentisticsEvent[] = []
    const ctx = mainContext('redacted-session-1', '2026-01-01T12:00:00.000Z')
    const state = emptyCopilotReplay(ctx)
    foldCopilotReplay(state, content.split('\n'), e => events.push(e))
    finishCopilotReplay(state, { final: true }, e => events.push(e))
    finishCopilotReplay(state, { final: true }, e => events.push(e))
    expect(events.filter(e => e.type === 'agent.ended')).toHaveLength(1)
    expect(events.filter(e => e.type === 'run.ended')).toHaveLength(1)
    expect(events.filter(e => e.type === 'session.ended')).toHaveLength(1)
  })

  test('replaying the same bytes twice from fresh state re-derives IDENTICAL event ids', () => {
    const content = readFileSync(
      join(FIXTURES, 'copilot-replay-basic', 'session-state', 'redacted-session-1', 'events.jsonl'), 'utf-8',
    )
    const a = replayWhole(content, 'redacted-session-1').map(e => e.eventId)
    const b = replayWhole(content, 'redacted-session-1').map(e => e.eventId)
    expect(a).toEqual(b)
  })
})

describe('mcp.tool_call — unverified shape, best-effort', () => {
  test('emits mcp.requested/mcp.completed with confidence "inferred" when no server field is present', () => {
    const content = [
      '{"type":"session.start","data":{"context":{"cwd":"<redacted>"}},"timestamp":"2026-01-01T13:00:00.000Z"}',
      '{"type":"mcp.tool_call","data":{"toolName":"query"},"timestamp":"2026-01-01T13:00:01.000Z"}',
    ].join('\n')
    const events = replayWhole(content, 'redacted-session-3', false)
    const req = events.find(e => e.type === 'mcp.requested')!
    expect(req.data).toMatchObject({ tool: 'query', server: '' })
    expect(req.provenance.confidence).toBe('inferred')
  })
})
