import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { AgentisticsEvent, EventType } from '@agentistics/core'
import { createKimiReplay } from './index'

const FIXTURES = join(import.meta.dir, '../../../test/fixtures/kimi-replay')
const BASIC_ID = '11111111-1111-1111-1111-111111111111'
const SUBAGENT_ID = '33333333-3333-3333-3333-333333333333'

function typed<T extends EventType>(events: AgentisticsEvent[], type: T): AgentisticsEvent<T>[] {
  return events.filter((e): e is AgentisticsEvent<T> => e.type === type)
}

describe('kimi integrations/kimi/index.ts', () => {
  test('discover() lists every session_<uuid> directory under every workspace', async () => {
    const replay = createKimiReplay({ sessionsDir: join(FIXTURES, 'basic') })
    const sources = await replay.discover()
    expect(sources.map(s => s.sessionId)).toEqual([BASIC_ID])
    expect(sources[0]!.sourceRef).toBe(`kimi:${BASIC_ID}`)
  })

  test('replay() with a settled clock emits the whole lifecycle plus model/tool events, once', async () => {
    // The clock is far past `updatedAt`, so the session reads as settled and *.ended is emitted too.
    const replay = createKimiReplay({ sessionsDir: join(FIXTURES, 'basic'), now: () => 1_800_000_000_000, settledMs: 60_000 })
    const batch = await replay.replay({ sessionId: BASIC_ID, sourceRef: `kimi:${BASIC_ID}` }, null)

    expect(typed(batch.events, 'session.started')).toHaveLength(1)
    expect(typed(batch.events, 'session.ended')).toHaveLength(1)
    expect(typed(batch.events, 'run.started')).toHaveLength(1)
    expect(typed(batch.events, 'run.ended')).toHaveLength(1)
    expect(typed(batch.events, 'agent.started')).toHaveLength(1) // one agent: main
    expect(typed(batch.events, 'agent.ended')).toHaveLength(1)
    expect(typed(batch.events, 'model.completed')).toHaveLength(1)

    const started = typed(batch.events, 'session.started')[0]
    expect(started?.data.projectPath).toBe('/redacted/workdir')
    expect(started?.data.title).toBe('<redacted>') // structural fixture placeholder, never real text

    const run = typed(batch.events, 'run.started')[0]
    expect(run?.data.harness).toBe('kimi')
    expect(run?.data.conversationId).toBe(BASIC_ID)
    expect(run?.data.conversationLink).toBe('observed')
  })

  test('replay() with a fresh (unsettled) clock emits no *.ended', async () => {
    const replay = createKimiReplay({ sessionsDir: join(FIXTURES, 'basic'), now: () => 1_700_000_100_500, settledMs: 60_000 })
    const batch = await replay.replay({ sessionId: BASIC_ID, sourceRef: `kimi:${BASIC_ID}` }, null)
    expect(typed(batch.events, 'session.ended')).toHaveLength(0)
    expect(typed(batch.events, 'run.ended')).toHaveLength(0)
    expect(typed(batch.events, 'agent.ended')).toHaveLength(0)
    expect(typed(batch.events, 'session.started')).toHaveLength(1) // start is unconditional
  })

  test('an unchanged file, resumed with the cursor it produced, re-emits the lifecycle but no wire events again — the SAME event ids either way (idempotent)', async () => {
    const replay = createKimiReplay({ sessionsDir: join(FIXTURES, 'basic'), now: () => 1_800_000_000_000, settledMs: 60_000 })
    const first = await replay.replay({ sessionId: BASIC_ID, sourceRef: `kimi:${BASIC_ID}` }, null)
    const second = await replay.replay({ sessionId: BASIC_ID, sourceRef: `kimi:${BASIC_ID}` }, first.cursor)

    const firstIds = new Set(first.events.map(e => e.eventId))
    const secondIds = new Set(second.events.map(e => e.eventId))
    // Every id the second call emits was already emitted by the first (idempotent identity) —
    // the lifecycle facts are re-derived every call (replay-agents.ts's header), the wire events
    // are skipped outright once the cursor matches (this module's own whole-file cursor).
    for (const id of secondIds) expect(firstIds.has(id)).toBe(true)
    expect(typed(second.events, 'model.completed')).toHaveLength(0)
    expect(typed(second.events, 'tool.requested')).toHaveLength(0)
  })

  test('a subagent session tags kind main vs subagent, and each agent gets its own agent.started/model.completed', async () => {
    const replay = createKimiReplay({ sessionsDir: join(FIXTURES, 'subagent'), now: () => 1_800_000_000_000, settledMs: 60_000 })
    const batch = await replay.replay({ sessionId: SUBAGENT_ID, sourceRef: `kimi:${SUBAGENT_ID}` }, null)

    const started = typed(batch.events, 'agent.started')
    expect(started).toHaveLength(2)
    const kinds = started.map(e => e.data.kind).sort()
    expect(kinds).toEqual(['main', 'subagent'])

    const models = typed(batch.events, 'model.completed')
    expect(models).toHaveLength(2) // one per agent, distinctly tagged
    const agentIds = new Set(models.map(e => e.agentId))
    expect(agentIds.size).toBe(2)
  })
})
