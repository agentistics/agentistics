import { describe, expect, it } from 'bun:test'
import type { AgentisticsEvent } from '@agentistics/core'
import { mainAgentIdOf, mainContext, subagentIdOf, type ClaudeReplayContext, type EmitEvent } from './replay-core'
import {
  cloneLifecycleFold,
  emptyLifecycleFold,
  fallbackSubagentAgentId,
  finishLifecycleFold,
  foldLifecycleEntry,
  launchedInvocations,
  subagentLaunchEvents,
  type LifecycleFoldState,
  type SubagentLaunch,
} from './replay-agents'

// ---- fixtures: small synthetic entries, no real conversation content -------------------------

function otherEntry(type: string, ts?: string): Record<string, unknown> {
  const entry: Record<string, unknown> = { type }
  if (ts !== undefined) entry.timestamp = ts
  return entry
}

function mainOpeningEntry(ts: string, opts: { cwd?: string; version?: string } = {}): Record<string, unknown> {
  const entry: Record<string, unknown> = { type: 'user', timestamp: ts }
  if (opts.cwd !== undefined) entry.cwd = opts.cwd
  if (opts.version !== undefined) entry.version = opts.version
  return entry
}

/** An assistant line launching an agent (or a background-forked skill) via one `tool_use`. */
function launchEntry(
  toolUseId: string, ts: string, opts: { name?: 'Agent' | 'Skill'; subagentType?: string; description?: string } = {},
): Record<string, unknown> {
  return {
    type: 'assistant',
    timestamp: ts,
    message: {
      content: [{
        type: 'tool_use',
        id: toolUseId,
        name: opts.name ?? 'Agent',
        input: { subagent_type: opts.subagentType, description: opts.description },
      }],
    },
  }
}

/** A `user` line answering a launch with a `tool_result` naming (or not naming) an agent. */
function resultEntry(
  toolUseId: string, ts: string, toolUseResult?: Record<string, unknown>,
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    type: 'user',
    timestamp: ts,
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId }] },
  }
  if (toolUseResult !== undefined) entry.toolUseResult = toolUseResult
  return entry
}

const ctx: ClaudeReplayContext = mainContext('conv-1', '2026-01-01T00:00:00.000Z')

function collector(): { events: AgentisticsEvent[]; emit: EmitEvent } {
  const events: AgentisticsEvent[] = []
  return { events, emit: (e) => events.push(e) }
}

function assertWellFormed(events: AgentisticsEvent[]): void {
  for (const e of events) {
    expect(e.provenance.adapterVersion.length).toBeGreaterThan(0)
    expect(['exact', 'estimated', 'inferred']).toContain(e.provenance.confidence)
    expect(e.provenance.sourceRef && e.provenance.sourceRef.length).toBeGreaterThan(0)
  }
}

// -------------------------------------------------------------------------------------------

describe('foldLifecycleEntry — main role opens the session/run/agent exactly once', () => {
  it('emits nothing for a line with no usable timestamp', () => {
    const state = emptyLifecycleFold()
    const { events, emit } = collector()
    foldLifecycleEntry(state, ctx, 'main', otherEntry('user'), 1, emit)
    expect(events).toHaveLength(0)
    expect(state.lastOccurredAt).toBeNull()
  })

  it('opens session.started + run.started + agent.started on the FIRST timestamped line only', () => {
    const state = emptyLifecycleFold()
    const { events, emit } = collector()
    foldLifecycleEntry(state, ctx, 'main', mainOpeningEntry('2026-01-01T00:00:01.000Z', { cwd: '/repo', version: '2.1.0' }), 1, emit)
    expect(events).toHaveLength(3)
    expect(events.map(e => e.type)).toEqual(['session.started', 'run.started', 'agent.started'])
    assertWellFormed(events)

    const [sessionStarted, runStarted, agentStarted] = events
    expect(sessionStarted!.agentId).toBeUndefined()
    expect((sessionStarted!.data as { projectPath?: string }).projectPath).toBe('/repo')
    expect(runStarted!.agentId).toBeUndefined()
    const runData = runStarted!.data as { harness: string; harnessVersion?: string; conversationId?: string; conversationLink: string; cwd?: string }
    expect(runData.harness).toBe('claude')
    expect(runData.harnessVersion).toBe('2.1.0')
    expect(runData.conversationId).toBe('conv-1')
    expect(runData.conversationLink).toBe('observed')
    expect(runData.cwd).toBe('/repo')
    expect(agentStarted!.agentId).toBe(mainAgentIdOf('conv-1'))
    expect((agentStarted!.data as { kind: string }).kind).toBe('main')

    // A second timestamped line never reopens anything.
    foldLifecycleEntry(state, ctx, 'main', otherEntry('assistant', '2026-01-01T00:00:02.000Z'), 2, emit)
    expect(events).toHaveLength(3)
  })

  it('carries the first claude-* model seen on the opening line as agent.started.model', () => {
    const state = emptyLifecycleFold()
    const { events, emit } = collector()
    const opening: Record<string, unknown> = {
      type: 'assistant', timestamp: '2026-01-01T00:00:01.000Z', message: { model: 'claude-opus-5' },
    }
    foldLifecycleEntry(state, ctx, 'main', opening, 1, emit)
    const agentStarted = events.find(e => e.type === 'agent.started')!
    expect((agentStarted.data as { model?: string }).model).toBe('claude-opus-5')
  })

  it('role subagent never emits session/run/agent.started, even on the first timestamped line', () => {
    const state = emptyLifecycleFold()
    const { events, emit } = collector()
    foldLifecycleEntry(state, ctx, 'subagent', mainOpeningEntry('2026-01-01T00:00:01.000Z'), 1, emit)
    expect(events).toHaveLength(0)
    expect(state.lastOccurredAt).toBe('2026-01-01T00:00:01.000Z')
  })
})

describe('finishLifecycleFold — ends only on final, and idempotently', () => {
  it('a transcript with no timestamped line emits nothing at all', () => {
    const state = emptyLifecycleFold()
    const { events, emit } = collector()
    finishLifecycleFold(state, ctx, 'main', true, emit)
    expect(events).toHaveLength(0)
  })

  it('final:false never emits ends, however much was folded', () => {
    const state = emptyLifecycleFold()
    const { events, emit } = collector()
    foldLifecycleEntry(state, ctx, 'main', mainOpeningEntry('2026-01-01T00:00:01.000Z'), 1, emit)
    const openCount = events.length
    finishLifecycleFold(state, ctx, 'main', false, emit)
    expect(events).toHaveLength(openCount)
  })

  it('main role: final:true closes agent, run and session, keyed on the LAST line', () => {
    const state = emptyLifecycleFold()
    const { events, emit } = collector()
    foldLifecycleEntry(state, ctx, 'main', mainOpeningEntry('2026-01-01T00:00:01.000Z'), 1, emit)
    foldLifecycleEntry(state, ctx, 'main', otherEntry('assistant', '2026-01-01T00:00:05.000Z'), 2, emit)
    const openCount = events.length

    finishLifecycleFold(state, ctx, 'main', true, emit)
    const closed = events.slice(openCount)
    expect(closed.map(e => e.type)).toEqual(['agent.ended', 'run.ended', 'session.ended'])
    for (const e of closed) {
      expect(e.occurredAt).toBe('2026-01-01T00:00:05.000Z')
      expect(e.provenance.sourceRef).toBe('claude:conv-1:2')
    }
    expect((closed[0]!.data as { status: string }).status).toBe('completed')
    expect(closed[0]!.agentId).toBe(mainAgentIdOf('conv-1'))
    expect(closed[1]!.agentId).toBeUndefined()
    expect(closed[2]!.agentId).toBeUndefined()
    assertWellFormed(closed)

    // Idempotent: nothing new folded since -> a second final finish emits nothing.
    finishLifecycleFold(state, ctx, 'main', true, emit)
    expect(events).toHaveLength(openCount + 3)
  })

  it('a resumed conversation ends again, at the NEW last line, after more was folded', () => {
    const state = emptyLifecycleFold()
    const { events, emit } = collector()
    foldLifecycleEntry(state, ctx, 'main', mainOpeningEntry('2026-01-01T00:00:01.000Z'), 1, emit)
    finishLifecycleFold(state, ctx, 'main', true, emit)
    const afterFirstEnd = events.length

    foldLifecycleEntry(state, ctx, 'main', otherEntry('assistant', '2026-01-01T00:00:09.000Z'), 2, emit)
    finishLifecycleFold(state, ctx, 'main', true, emit)
    const closedAgain = events.slice(afterFirstEnd)
    expect(closedAgain.map(e => e.type)).toEqual(['agent.ended', 'run.ended', 'session.ended'])
    expect(closedAgain[0]!.occurredAt).toBe('2026-01-01T00:00:09.000Z')
    expect(closedAgain[0]!.provenance.sourceRef).toBe('claude:conv-1:2')
  })

  it('subagent role: final:true emits only agent.ended, completed by default', () => {
    const state = emptyLifecycleFold()
    const { events, emit } = collector()
    foldLifecycleEntry(state, ctx, 'subagent', mainOpeningEntry('2026-01-01T00:00:01.000Z'), 1, emit)
    finishLifecycleFold(state, ctx, 'subagent', true, emit)
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('agent.ended')
    expect((events[0]!.data as { status: string }).status).toBe('completed')
  })

  it('subagent role: `subagentFailed` set by the caller flips the ended status to failed', () => {
    const state = emptyLifecycleFold()
    state.subagentFailed = true
    const { events, emit } = collector()
    foldLifecycleEntry(state, ctx, 'subagent', mainOpeningEntry('2026-01-01T00:00:01.000Z'), 1, emit)
    finishLifecycleFold(state, ctx, 'subagent', true, emit)
    expect((events[0]!.data as { status: string }).status).toBe('failed')
  })
})

describe('cloneLifecycleFold — independent copies', () => {
  it('mutating the clone never affects the original', () => {
    const state = emptyLifecycleFold()
    foldLifecycleEntry(state, ctx, 'main', mainOpeningEntry('2026-01-01T00:00:01.000Z'), 1, () => {})
    const clone = cloneLifecycleFold(state)
    foldLifecycleEntry(clone, ctx, 'main', otherEntry('assistant', '2026-01-01T00:00:02.000Z'), 2, () => {})
    expect(state.lastLineNo).toBe(1)
    expect(clone.lastLineNo).toBe(2)
    clone.launchSites.set('x', { lineNo: 99, occurredAt: 'z' })
    expect(state.launchSites.has('x')).toBe(false)
  })
})

describe('launchedInvocations — the main conversation\'s own Agent/Skill launches, seen so far', () => {
  it('is empty before anything is folded', () => {
    expect(launchedInvocations(emptyLifecycleFold())).toEqual([])
  })

  it('reports an ASYNC launch (no numbers in the result) as unmeasured', () => {
    const state = emptyLifecycleFold()
    foldLifecycleEntry(state, ctx, 'main', launchEntry('tu-1', '2026-01-01T00:00:01.000Z', { description: 'do the thing' }), 1, () => {})
    foldLifecycleEntry(state, ctx, 'main', resultEntry('tu-1', '2026-01-01T00:00:02.000Z', { agentId: 'agent-abc', status: 'async_launched' }), 2, () => {})
    const invocations = launchedInvocations(state)
    expect(invocations).toHaveLength(1)
    expect(invocations[0]!.toolUseId).toBe('tu-1')
    expect(invocations[0]!.agentId).toBe('agent-abc')
    expect(invocations[0]!.unmeasured).toBe(true)
    expect(invocations[0]!.description).toBe('do the thing')
  })

  it('reports a background launch the parent never answered as unmeasured too', () => {
    const state = emptyLifecycleFold()
    foldLifecycleEntry(state, ctx, 'main', launchEntry('tu-2', '2026-01-01T00:00:01.000Z', { subagentType: 'Explore' }), 1, () => {})
    const invocations = launchedInvocations(state)
    expect(invocations).toHaveLength(1)
    expect(invocations[0]!.toolUseId).toBe('tu-2')
    expect(invocations[0]!.agentId).toBeUndefined()
    expect(invocations[0]!.unmeasured).toBe(true)
  })

  it('records where each launch appeared, for subagentLaunchEvents to cite as sourceRef', () => {
    const state = emptyLifecycleFold()
    foldLifecycleEntry(state, ctx, 'main', launchEntry('tu-3', '2026-01-01T00:00:07.000Z'), 5, () => {})
    expect(state.launchSites.get('tu-3')).toEqual({ lineNo: 5, occurredAt: '2026-01-01T00:00:07.000Z' })
  })
})

describe('fallbackSubagentAgentId — a stable id for a launch nothing measured', () => {
  it('is deterministic for the same inputs', () => {
    expect(fallbackSubagentAgentId('conv-1', 'tu-1')).toBe(fallbackSubagentAgentId('conv-1', 'tu-1'))
  })

  it('differs across conversations and across tool_use ids', () => {
    expect(fallbackSubagentAgentId('conv-1', 'tu-1')).not.toBe(fallbackSubagentAgentId('conv-2', 'tu-1'))
    expect(fallbackSubagentAgentId('conv-1', 'tu-1')).not.toBe(fallbackSubagentAgentId('conv-1', 'tu-2'))
  })

  it('never collides with a real subagentIdOf id (different prefixed hash spaces)', () => {
    expect(fallbackSubagentAgentId('conv-1', 'tu-1')).not.toBe(subagentIdOf('conv-1', 'tu-1'))
  })
})

describe('subagentLaunchEvents — agent.started for every launch, agent.ended only for the unmeasured ones', () => {
  it('a claimed launch with a known launch site cites it as sourceRef and carries its model', () => {
    const { events, emit } = collector()
    const launches: SubagentLaunch[] = [{
      agentId: 'agent-abc',
      parentAgentId: mainAgentIdOf('conv-1'),
      agentType: 'Explore',
      description: 'find the bug',
      model: 'claude-haiku-5',
      launchSite: { lineNo: 12, occurredAt: '2026-01-01T00:00:03.000Z' },
      toolUseId: 'tu-1',
    }]
    subagentLaunchEvents(ctx, launches, emit)
    expect(events).toHaveLength(1)
    const [started] = events
    expect(started!.type).toBe('agent.started')
    expect(started!.agentId).toBe(subagentIdOf('conv-1', 'agent-abc'))
    expect(started!.provenance.sourceRef).toBe('claude:conv-1:12')
    expect(started!.occurredAt).toBe('2026-01-01T00:00:03.000Z')
    const data = started!.data as { kind: string; parentAgentId?: string; agentType?: string; description?: string; model?: string }
    expect(data.kind).toBe('subagent')
    expect(data.parentAgentId).toBe(mainAgentIdOf('conv-1'))
    expect(data.agentType).toBe('Explore')
    expect(data.description).toBe('find the bug')
    expect(data.model).toBe('claude-haiku-5')
    assertWellFormed(events)
  })

  it('a claimed launch with NO known launch site (a nested child, named only by its own meta) falls back to the :meta ref', () => {
    const { events, emit } = collector()
    const launches: SubagentLaunch[] = [{
      agentId: 'agent-child',
      parentAgentId: subagentIdOf('conv-1', 'agent-parent'),
      toolUseId: 'unused',
    }]
    subagentLaunchEvents(ctx, launches, emit)
    expect(events).toHaveLength(1)
    expect(events[0]!.provenance.sourceRef).toBe('claude:conv-1/subagents/agent-child:meta')
    // The parent named on the event is the SPAWNING SUBAGENT's own id, never the main agent's.
    expect((events[0]!.data as { parentAgentId?: string }).parentAgentId).toBe(subagentIdOf('conv-1', 'agent-parent'))
    expect((events[0]!.data as { parentAgentId?: string }).parentAgentId).not.toBe(mainAgentIdOf('conv-1'))
  })

  it('an UNMEASURED launch (no transcript found) emits started + ended{unmeasured}, and no model field', () => {
    const { events, emit } = collector()
    const launches: SubagentLaunch[] = [{
      agentId: null,
      parentAgentId: mainAgentIdOf('conv-1'),
      agentType: 'general-purpose',
      description: 'background work',
      toolUseId: 'tu-9',
      launchSite: { lineNo: 3, occurredAt: '2026-01-01T00:00:04.000Z' },
    }]
    subagentLaunchEvents(ctx, launches, emit)
    expect(events.map(e => e.type)).toEqual(['agent.started', 'agent.ended'])
    const [started, ended] = events
    expect(started!.agentId).toBe(fallbackSubagentAgentId('conv-1', 'tu-9'))
    expect(ended!.agentId).toBe(started!.agentId)
    expect('model' in (started!.data as object)).toBe(false)
    expect((ended!.data as { status: string }).status).toBe('unmeasured')
    // No model.* events are ever emitted by this module — this fold owns lifecycle only.
    expect(events.some(e => e.type.startsWith('model.'))).toBe(false)
    assertWellFormed(events)
  })

  it('several launches under different parents each carry their OWN parentAgentId — nesting is a passthrough, never inferred', () => {
    const { events, emit } = collector()
    const launches: SubagentLaunch[] = [
      { agentId: 'a1', parentAgentId: mainAgentIdOf('conv-1'), toolUseId: 't1', launchSite: { lineNo: 1, occurredAt: 't' } },
      { agentId: 'a2', parentAgentId: subagentIdOf('conv-1', 'a1'), toolUseId: 't2' },
    ]
    subagentLaunchEvents(ctx, launches, emit)
    expect(events).toHaveLength(2)
    expect((events[0]!.data as { parentAgentId?: string }).parentAgentId).toBe(mainAgentIdOf('conv-1'))
    expect((events[1]!.data as { parentAgentId?: string }).parentAgentId).toBe(subagentIdOf('conv-1', 'a1'))
  })

  it('forks produce nothing: a launch list that omits an unclaimed transcript emits nothing for it', () => {
    // A "fork" is a transcript `planAgentJoin` leaves in `AgentJoinPlan.unclaimed` — no invocation
    // ever claims it, so the caller never turns it into a `SubagentLaunch`. Simulate exactly that:
    // one real claimed launch, and confirm the total event count matches ONLY that one launch —
    // nothing appears for the fork that was (by construction) never included.
    const { events, emit } = collector()
    const launches: SubagentLaunch[] = [{
      agentId: 'claimed', parentAgentId: mainAgentIdOf('conv-1'), toolUseId: 'tu-claimed',
    }]
    subagentLaunchEvents(ctx, launches, emit)
    expect(events).toHaveLength(1)
    expect(events[0]!.agentId).toBe(subagentIdOf('conv-1', 'claimed'))
  })

  it('an empty launch list emits nothing at all', () => {
    const { events, emit } = collector()
    subagentLaunchEvents(ctx, [], emit)
    expect(events).toHaveLength(0)
  })
})
