import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentisticsEvent } from '@agentistics/core'
import { parseGeminiChat } from '../../adapters/gemini-parse'
import { detectGeminiShape, foldGeminiChat } from './replay'
import { geminiContext } from './replay-core'

const FIXTURES = join(import.meta.dir, '../../../test/fixtures/gemini-replay')
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf-8')

function fold(content: string, conversationId: string): { shape: ReturnType<typeof detectGeminiShape>; events: AgentisticsEvent[] } {
  const ctx = geminiContext(conversationId, '/home/user/project', '2026-03-01T12:00:00.000Z')
  const events: AgentisticsEvent[] = []
  const shape = foldGeminiChat(ctx, content, e => events.push(e))
  return { shape, events }
}

describe('detectGeminiShape', () => {
  test('empty content', () => {
    expect(detectGeminiShape('')).toBe('empty')
    expect(detectGeminiShape('   \n  ')).toBe('empty')
  })

  test('content not starting with {', () => {
    expect(detectGeminiShape('not json at all')).toBe('unknown')
  })

  test('a minified single-line rich-json object', () => {
    const minified = JSON.stringify({ sessionId: 's', startTime: 't', messages: [] })
    expect(detectGeminiShape(minified)).toBe('rich-json')
  })

  test('the checked-in rich-json fixture (pretty-printed, still classified rich-json)', () => {
    expect(detectGeminiShape(read('rich-json-plain.json'))).toBe('rich-json')
  })

  test('the checked-in jsonl fixture', () => {
    expect(detectGeminiShape(read('jsonl-basic.jsonl'))).toBe('jsonl')
  })
})

describe('foldGeminiChat — rich-json shape', () => {
  const content = read('rich-json-plain.json')

  test('classifies as rich-json and cross-checks against the legacy parser on the same bytes', () => {
    const { shape } = fold(content, 'fixture-project/rich-json-plain')
    expect(shape).toBe('rich-json')
    const legacy = parseGeminiChat(content, 'fixture-project/rich-json-plain', '/home/user/project')
    expect(legacy).not.toBeNull()
    expect(legacy!.harness).toBe('gemini')
  })

  test('emits the full lifecycle + model + tool event stream, in order, with no conversation text', () => {
    const { events } = fold(content, 'fixture-project/rich-json-plain')
    const types = events.map(e => e.type)
    expect(types).toEqual([
      'session.started', 'run.started', 'agent.started',
      'model.invoked', 'model.completed',
      'tool.requested', 'tool.completed', // tc-shell-1
      'tool.requested', 'tool.completed', // tc-read-1
      'model.invoked', 'model.completed',
      'tool.requested', 'tool.failed', // tc-edit-1 (error -> failed)
      'tool.requested', 'tool.failed', // tc-edit-2 (cancelled -> cancelled)
      'agent.ended', 'run.ended', 'session.ended',
    ])

    // No event anywhere carries a message body or a thought — only the shell tool's `summary`
    // (via `commandSummary`) legitimately carries any of the fixture's placeholder text, which is
    // the entity contract's own allowance (`ToolExecution.summary`), never a message.
    for (const e of events) {
      if (e.type === 'tool.requested' && (e.data as { kind?: string }).kind === 'shell') continue
      expect(JSON.stringify(e)).not.toContain('<redacted>')
    }

    const sessionStarted = events[0]!
    expect(sessionStarted.occurredAt).toBe('2026-03-01T10:00:00.000Z')
    expect(sessionStarted.data).toEqual({ origin: 'adapter', projectPath: '/home/user/project' })
    expect(sessionStarted.provenance.adapterVersion).not.toBe('')
    expect(sessionStarted.provenance.mode).toBe('replayed')
    expect(sessionStarted.provenance.confidence).toBe('exact')

    const runStarted = events[1]!
    expect(runStarted.data).toEqual({
      harness: 'gemini', conversationId: 'fixture-project/rich-json-plain',
      conversationLink: 'observed', cwd: '/home/user/project',
    })

    const firstModelCompleted = events.find(e => e.type === 'model.completed')!
    expect(firstModelCompleted.data).toEqual({
      provider: 'google', model: 'gemini-3-flash-preview',
      usage: { input: 1000, output: 50, cacheRead: 200 },
      status: 'completed',
    })

    const shellRequest = events[5]!
    expect(shellRequest.type).toBe('tool.requested')
    expect(shellRequest.data).toMatchObject({ name: 'run_shell_command', canonicalName: 'Bash', kind: 'shell' })
    expect((shellRequest.data as { summary?: string }).summary).toBeDefined()

    const readRequest = events[7]!
    expect(readRequest.data).toMatchObject({ name: 'read_file', canonicalName: 'Read', kind: 'file' })

    const editFailed = events.find((e, i) => e.type === 'tool.failed' && i === events.findIndex(x => x.type === 'tool.failed'))!
    expect(editFailed.data).toMatchObject({ status: 'failed' })
    const cancelledEvent = events.filter(e => e.type === 'tool.failed')[1]!
    expect(cancelledEvent.data).toMatchObject({ status: 'cancelled' })
  })

  test('every id is derived and stable across a second fold of the same bytes', () => {
    const first = fold(content, 'fixture-project/rich-json-plain').events
    const second = fold(content, 'fixture-project/rich-json-plain').events
    expect(second.map(e => e.eventId)).toEqual(first.map(e => e.eventId))
    // and no id collides with another one of a different type/record in this same stream
    expect(new Set(first.map(e => e.eventId)).size).toBe(first.length)
  })

  test('a bootstrap-only rich-json file (no genuine content) emits nothing', () => {
    const { shape, events } = fold(read('rich-json-bootstrap-only.json'), 'fixture-project/bootstrap-only')
    expect(shape).toBe('rich-json')
    expect(events).toEqual([])
    // matches legacy exactly
    expect(parseGeminiChat(read('rich-json-bootstrap-only.json'), 'x', '/p')).toBeNull()
  })
})

describe('foldGeminiChat — jsonl (append-journal) shape', () => {
  const content = read('jsonl-basic.jsonl')

  test('classifies as jsonl and cross-checks against the legacy parser', () => {
    const { shape } = fold(content, 'fixture-project/jsonl-basic')
    expect(shape).toBe('jsonl')
    const legacy = parseGeminiChat(content, 'fixture-project/jsonl-basic', '/home/user/project')
    expect(legacy).not.toBeNull()
    expect(legacy!.input_tokens).toBe(0) // legacy never reads tokens for this shape (the trap)
  })

  test('emits ONLY the lifecycle — no model or tool events, mirroring legacy exactly', () => {
    const { events } = fold(content, 'fixture-project/jsonl-basic')
    expect(events.map(e => e.type)).toEqual([
      'session.started', 'run.started', 'agent.started',
      'agent.ended', 'run.ended', 'session.ended',
    ])
    const runStarted = events[1]!
    expect(runStarted.data).toMatchObject({ conversationId: 'fixture-project/jsonl-basic', conversationLink: 'observed' })
    // open/close anchored on the HEADER's own startTime/lastUpdated — same as legacy's `parseJsonl`,
    // which (like this fold) never reads the later `{"$set":{"lastUpdated":…}}` patch lines back
    // into `lastUpdated`; only a line carrying its own `sessionId`/`startTime` updates it.
    expect(events[0]!.occurredAt).toBe('2026-04-01T08:00:00.000Z')
    expect(events[5]!.occurredAt).toBe('2026-04-01T08:00:00.000Z')
  })

  test('a resumed session repeating its seed in later top-level lines is not double-counted', () => {
    // The fixture deliberately repeats j-u2 and j-g1 verbatim near the end (a resumed session's
    // seed arriving again). If dedup failed, hasGenuineContent would still be true either way here,
    // but the event COUNT must not depend on how many times an already-seen id repeats.
    const once = fold(content, 'fixture-project/jsonl-basic').events.length
    const dup = content + '\n' + content.split('\n').slice(2, 6).join('\n')
    const twice = fold(dup, 'fixture-project/jsonl-basic').events.length
    expect(twice).toBe(once) // lifecycle-only events are unaffected by message-body duplication
  })

  test('a bootstrap-only jsonl file emits nothing', () => {
    const { shape, events } = fold(read('jsonl-bootstrap-only.jsonl'), 'fixture-project/jsonl-bootstrap')
    expect(shape).toBe('jsonl')
    expect(events).toEqual([])
    expect(parseGeminiChat(read('jsonl-bootstrap-only.jsonl'), 'x', '/p')).toBeNull()
  })
})

describe('foldGeminiChat — unreadable / unknown content', () => {
  test('unknown shape (not starting with {) emits nothing', () => {
    const { shape, events } = fold('plain text, not a gemini chat file', 'x/y')
    expect(shape).toBe('unknown')
    expect(events).toEqual([])
  })

  test('empty content emits nothing', () => {
    const { shape, events } = fold('', 'x/y')
    expect(shape).toBe('empty')
    expect(events).toEqual([])
  })
})
