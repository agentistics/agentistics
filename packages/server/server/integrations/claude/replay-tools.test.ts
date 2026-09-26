import { describe, expect, test } from 'bun:test'
import type { AgentisticsEvent, ToolCompletedData, ToolFailedData, ToolKind, ToolRequestedData } from '@agentistics/core'
import { CLAUDE_ADAPTER_VERSION, lineRef, mainContext, toolExecutionIdOf } from './replay-core'
import { cloneToolFold, emptyToolFold, finishToolFold, foldToolEntry, type ToolFoldState } from './replay-tools'

const CTX = mainContext('conv-1', '2026-01-01T00:00:00.000Z')

function collector(): { events: AgentisticsEvent[]; emit: (e: AgentisticsEvent) => void } {
  const events: AgentisticsEvent[] = []
  return { events, emit: (e) => { events.push(e) } }
}

/** An assistant line whose content is exactly the given parts (text and/or tool_use blocks). */
function assistantLine(ts: string, content: Record<string, unknown>[]): Record<string, unknown> {
  return { type: 'assistant', timestamp: ts, message: { role: 'assistant', content } }
}

/** A user line answering one or more tool_use ids. `toolUseResult` mirrors the entry-level field
 *  Claude Code itself writes for a single-result line. */
function userLine(
  ts: string, results: Array<{ toolUseId: string; isError?: boolean; content?: unknown }>,
  toolUseResult?: unknown,
): Record<string, unknown> {
  return {
    type: 'user', timestamp: ts,
    message: {
      role: 'user',
      content: results.map(r => ({
        type: 'tool_result', tool_use_id: r.toolUseId, is_error: r.isError ?? false,
        content: r.content ?? 'ok',
      })),
    },
    ...(toolUseResult !== undefined ? { toolUseResult } : {}),
  }
}

describe('foldToolEntry — requests', () => {
  test('parallel tool_use blocks get ordinals 0..n and distinct execution ids', () => {
    const state = emptyToolFold()
    const { events, emit } = collector()
    const entry = assistantLine('2026-01-01T00:00:01.000Z', [
      { type: 'text', text: 'doing three things' }, // must not count toward the ordinal
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.ts' } },
      { type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'foo' } },
      { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'ls' } },
    ])

    foldToolEntry(state, CTX, entry, 5, emit)

    expect(events).toHaveLength(3)
    expect(events.every(e => e.type === 'tool.requested')).toBe(true)
    // The ordinal is not a field on the event itself — it is folded into the derived `eventId`
    // (see `makeEvent`/`deriveEventId`), so three requests on ONE line must still derive three
    // distinct ids even though every other input to the id (sourceRef, type) is identical.
    const ids = new Set(events.map(e => e.eventId))
    expect(ids.size).toBe(3)

    const execIds = new Set(events.map(e => (e.data as ToolRequestedData).toolExecutionId))
    expect(execIds.size).toBe(3)
    expect(execIds).toEqual(new Set([
      toolExecutionIdOf('conv-1', 't1'),
      toolExecutionIdOf('conv-1', 't2'),
      toolExecutionIdOf('conv-1', 't3'),
    ]))
  })

  test('every event carries its provenance and source record', () => {
    const state = emptyToolFold()
    const { events, emit } = collector()
    foldToolEntry(state, CTX, assistantLine('2026-01-01T00:00:01.000Z', [
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.ts' } },
    ]), 7, emit)

    expect(events).toHaveLength(1)
    const e = events[0]!
    expect(e.provenance.adapterVersion).toBe(CLAUDE_ADAPTER_VERSION)
    expect(e.provenance.confidence).toBe('exact')
    expect(e.provenance.sourceRef).toBe(lineRef(CTX, 7))
    expect(e.occurredAt).toBe('2026-01-01T00:00:01.000Z')
    expect(e.source.id).toBe('claude')
  })

  test('shell summary is commandSummary’d and redacted — a secret never survives into the event', () => {
    const state = emptyToolFold()
    const { events, emit } = collector()
    const secretCmd = 'echo sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    foldToolEntry(state, CTX, assistantLine('t', [
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: secretCmd } },
    ]), 1, emit)

    const data = events[0]!.data as ToolRequestedData
    expect(data.summary).toBeDefined()
    expect(data.summary).not.toContain('sk-ant-')
    expect(data.summary).toContain('[REDACTED]')
  })

  test('a non-shell tool never carries a summary, whatever its input holds', () => {
    const state = emptyToolFold()
    const { events, emit } = collector()
    foldToolEntry(state, CTX, assistantLine('t', [
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.ts', command: 'should never be read' } },
    ]), 1, emit)

    expect((events[0]!.data as ToolRequestedData).summary).toBeUndefined()
  })

  test('mcp__<server>__<tool> is classified as mcp and names the server', () => {
    const state = emptyToolFold()
    const { events, emit } = collector()
    foldToolEntry(state, CTX, assistantLine('t', [
      { type: 'tool_use', id: 't1', name: 'mcp__github__create_issue', input: {} },
    ]), 1, emit)

    const data = events[0]!.data as ToolRequestedData
    expect(data.kind).toBe('mcp')
    expect(data.mcpServer).toBe('github')
    expect(data.canonicalName).toBe('mcp__github__create_issue')
  })

  test('kind classification covers shell / file / search / agent / other', () => {
    const cases: Array<[string, ToolKind]> = [
      ['Bash', 'shell'], ['BashOutput', 'shell'], ['KillShell', 'shell'],
      ['Read', 'file'], ['Write', 'file'], ['Edit', 'file'], ['MultiEdit', 'file'], ['NotebookEdit', 'file'],
      ['Grep', 'search'], ['Glob', 'search'],
      ['Agent', 'agent'], ['Task', 'agent'],
      ['WebFetch', 'other'], ['TodoWrite', 'other'],
    ]
    for (const [name, kind] of cases) {
      const state = emptyToolFold()
      const { events, emit } = collector()
      foldToolEntry(state, CTX, assistantLine('t', [{ type: 'tool_use', id: 'x', name, input: {} }]), 1, emit)
      expect((events[0]!.data as ToolRequestedData).kind).toBe(kind)
    }
  })
})

describe('foldToolEntry — results', () => {
  function withPendingRequest(name: string, input: Record<string, unknown>): { state: ToolFoldState } {
    const state = emptyToolFold()
    foldToolEntry(state, CTX, assistantLine('t0', [{ type: 'tool_use', id: 't1', name, input }]), 1, () => {})
    return { state }
  }

  test('an ordinary result completes the matching request', () => {
    const { state } = withPendingRequest('Bash', { command: 'ls' })
    const { events, emit } = collector()
    foldToolEntry(state, CTX, userLine('t1', [{ toolUseId: 't1' }]), 2, emit)

    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('tool.completed')
    expect((events[0]!.data as ToolCompletedData).toolExecutionId).toBe(toolExecutionIdOf('conv-1', 't1'))
  })

  test('is_error true fails the tool with status "failed"', () => {
    const { state } = withPendingRequest('Bash', { command: 'false' })
    const { events, emit } = collector()
    foldToolEntry(state, CTX, userLine('t1', [{ toolUseId: 't1', isError: true }]), 2, emit)

    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('tool.failed')
    expect((events[0]!.data as ToolFailedData).status).toBe('failed')
  })

  test('a user-interrupted call is cancelled, not failed', () => {
    const { state } = withPendingRequest('Agent', { subagent_type: 'general-purpose' })
    const { events, emit } = collector()
    foldToolEntry(
      state, CTX,
      userLine('t1', [{ toolUseId: 't1', isError: true }], 'Error: [Request interrupted by user for tool use]'),
      2, emit,
    )

    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('tool.failed')
    expect((events[0]!.data as ToolFailedData).status).toBe('cancelled')
  })

  test('a result naming an id that was never requested still emits, on the fallback execution id', () => {
    const state = emptyToolFold()
    const { events, emit } = collector()
    foldToolEntry(state, CTX, userLine('t1', [{ toolUseId: 'unseen' }]), 9, emit)

    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('tool.completed')
    expect((events[0]!.data as ToolCompletedData).toolExecutionId).toBe(toolExecutionIdOf('conv-1', 'unseen'))
    // No request means no known file/line delta — never a claimed zero.
    expect((events[0]!.data as ToolCompletedData).filesTouched).toBeUndefined()
    expect((events[0]!.data as ToolCompletedData).linesAdded).toBeUndefined()
  })

  test('Edit reports the file it named and the delta from its OWN request input', () => {
    const { state } = withPendingRequest('Edit', {
      file_path: '/a.ts', old_string: 'const a = 1', new_string: 'const a = 2\nconst b = 3',
    })
    const { events, emit } = collector()
    foldToolEntry(state, CTX, userLine('t1', [{ toolUseId: 't1' }]), 2, emit)

    const data = events[0]!.data as ToolCompletedData
    expect(data.filesTouched).toEqual(['/a.ts'])
    // `replacementDelta`: 1 common line that differs (`changed = 1`) plus the extra line `new_string`
    // gained (`+1` added, `+0` removed) — see `edit-lines.ts`.
    expect(data.linesAdded).toBe(2)
    expect(data.linesRemoved).toBe(1)
  })

  test('Write reports the file and counts every line as added, none removed', () => {
    const { state } = withPendingRequest('Write', { file_path: '/new.ts', content: 'a\nb\nc' })
    const { events, emit } = collector()
    foldToolEntry(state, CTX, userLine('t1', [{ toolUseId: 't1' }]), 2, emit)

    const data = events[0]!.data as ToolCompletedData
    expect(data.filesTouched).toEqual(['/new.ts'])
    expect(data.linesAdded).toBe(3)
    expect(data.linesRemoved).toBe(0)
  })

  test('NotebookEdit reads its path from notebook_path, not file_path', () => {
    const { state } = withPendingRequest('NotebookEdit', {
      notebook_path: '/n.ipynb', old_source: 'x = 1', new_source: 'x = 2',
    })
    const { events, emit } = collector()
    foldToolEntry(state, CTX, userLine('t1', [{ toolUseId: 't1' }]), 2, emit)

    expect((events[0]!.data as ToolCompletedData).filesTouched).toEqual(['/n.ipynb'])
  })

  test('a Read never carries filesTouched or a line delta — only the WRITE tools do', () => {
    const { state } = withPendingRequest('Read', { file_path: '/a.ts' })
    const { events, emit } = collector()
    foldToolEntry(state, CTX, userLine('t1', [{ toolUseId: 't1' }]), 2, emit)

    const data = events[0]!.data as ToolCompletedData
    expect(data.filesTouched).toBeUndefined()
    expect(data.linesAdded).toBeUndefined()
    expect(data.linesRemoved).toBeUndefined()
  })

  test('durationMs is read only from a structural field on toolUseResult, never computed', () => {
    const { state } = withPendingRequest('Bash', { command: 'sleep 1' })
    const { events, emit } = collector()
    foldToolEntry(state, CTX, userLine('t1', [{ toolUseId: 't1' }], { totalDurationMs: 1234 }), 2, emit)
    expect((events[0]!.data as ToolCompletedData).durationMs).toBe(1234)

    const { state: state2 } = withPendingRequest('Bash', { command: 'sleep 1' })
    const { events: events2, emit: emit2 } = collector()
    foldToolEntry(state2, CTX, userLine('t1', [{ toolUseId: 't1' }]), 2, emit2)
    expect((events2[0]!.data as ToolCompletedData).durationMs).toBeUndefined()
  })

  test('a pending request whose result never arrives emits nothing at finish', () => {
    const { state } = withPendingRequest('Bash', { command: 'sleep 100' })
    const { events, emit } = collector()
    finishToolFold(state, CTX, true, emit)
    finishToolFold(state, CTX, false, emit) // idempotent, either way
    expect(events).toEqual([])
  })
})

describe('foldToolEntry — chunk independence', () => {
  test('splitting the request and result across a cloned state yields the same event as one pass', () => {
    const request = assistantLine('t0', [{ type: 'tool_use', id: 't1', name: 'Edit', input: {
      file_path: '/a.ts', old_string: 'a', new_string: 'ab',
    } }])
    const result = userLine('t1', [{ toolUseId: 't1' }])

    // One continuous fold.
    const whole = emptyToolFold()
    const { events: wholeEvents, emit: wholeEmit } = collector()
    foldToolEntry(whole, CTX, request, 1, wholeEmit)
    foldToolEntry(whole, CTX, result, 2, wholeEmit)

    // The SAME two lines, but the state is cloned in between — as a resumed walk would.
    const first = emptyToolFold()
    const { events: splitEvents, emit: splitEmit } = collector()
    foldToolEntry(first, CTX, request, 1, splitEmit)
    const resumed = cloneToolFold(first)
    foldToolEntry(resumed, CTX, result, 2, splitEmit)

    expect(splitEvents).toEqual(wholeEvents)
  })
})
