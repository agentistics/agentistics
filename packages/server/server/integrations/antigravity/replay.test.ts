/**
 * The agy transcript fold, over `test/fixtures/antigravity-replay` — a HAND-BUILT conversation in the
 * measured shape of a real one (every step type the parser gates on, a replayed CONVERSATION_HISTORY
 * step, a duplicated `step_index`, an unparseable line, a slash command, an INVOKE_SUBAGENT step), with
 * every prompt, reply and argument text replaced by a placeholder (master §42).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentisticsEvent } from '@agentistics/core'
import { childContext, mainAgentIdOf, mainContext, ANTIGRAVITY_ADAPTER_VERSION } from './replay-core'
import { emptyAntigravityReplay, finishAntigravityReplay, foldAntigravityReplay } from './replay'

const FIX = join(import.meta.dir, '../../../test/fixtures/antigravity-replay')
const P = 'aaaaaaaa-0000-4000-8000-000000000001'
const C = 'cccccccc-0000-4000-8000-000000000002'
const AT = '2027-01-01T00:00:00.000Z'
const parentLines = (): string[] =>
  readFileSync(join(FIX, 'brain', P, '.system_generated/logs/transcript_full.jsonl'), 'utf-8').split('\n')

function foldWhole(lines: string[], final = true): { events: AgentisticsEvent[]; state: ReturnType<typeof emptyAntigravityReplay> } {
  const events: AgentisticsEvent[] = []
  const state = emptyAntigravityReplay(mainContext(P, AT, '/work/app'), 'main')
  foldAntigravityReplay(state, lines, e => events.push(e))
  finishAntigravityReplay(state, { final }, e => events.push(e))
  return { events, state }
}

const brief = (e: AgentisticsEvent) => `${e.type}@${(e.provenance.sourceRef ?? '').split(':').pop()}`

describe('agy transcript fold — the golden stream', () => {
  test('emits exactly the expected events, in order', () => {
    const { events } = foldWhole(parentLines())
    expect(events.map(brief)).toEqual([
      'session.started@1', 'run.started@1', 'agent.started@1', 'turn.started@1',
      // line 2: view_file + replace_file_content requested; the edit's payload deltas; run_command's
      // REQUEST is skipped (its execution is the RUN_COMMAND step)
      'tool.requested@2', 'tool.requested@2', 'tool.completed@2',
      // line 3 is unparseable; line 4 is VIEW_FILE (an execution with no event)
      'tool.completed@5',                         // CODE_ACTION: the files it names
      'tool.requested@6', 'tool.completed@6',     // RUN_COMMAND exit 0 — the duplicate on line 7 is skipped
      // line 8 is CONVERSATION_HISTORY — a replay, skipped
      'tool.requested@9', 'tool.requested@9',     // invoke_subagent, search_web
      // line 10: INVOKE_SUBAGENT — a child link, no event of its own
      'tool.requested@11', 'tool.failed@11',      // RUN_COMMAND exit 1
      'model.failed@12',                          // ERROR_MESSAGE
      'turn.ended@12', 'turn.started@13',         // the slash command is a counted user message
      'turn.ended@14', 'turn.started@15',
      'turn.ended@16', 'agent.ended@16',
    ])
  })

  test('the counters and names are legacy\'s', () => {
    const { events, state } = foldWhole(parentLines())
    const edit = events.find(e => e.type === 'tool.completed' && e.provenance.sourceRef!.endsWith(':2'))!
    expect(edit.data).toMatchObject({ filesTouched: ['/work/app/a.ts'], linesAdded: 3, linesRemoved: 2 })
    const code = events.find(e => e.type === 'tool.completed' && e.provenance.sourceRef!.endsWith(':5'))!
    expect(code.data).toMatchObject({ filesTouched: ['/work/app/a.ts', '/work/app/b.ts'] })
    const failed = events.find(e => e.type === 'tool.failed')!
    expect(failed.data).toMatchObject({ status: 'failed', errorClass: 'exit_code', exitCode: 1 })
    const err = events.find(e => e.type === 'model.failed')!
    expect(err.data).toMatchObject({ errorClass: 'error_2', model: 'unknown', provider: 'other' })
    expect(err.provenance.confidence).toBe('estimated')
    const shell = events.filter(e => e.type === 'tool.requested' && (e.data as { canonicalName: string }).canonicalName === 'Bash')
    expect(shell.map(e => (e.data as { name: string }).name)).toEqual(['RUN_COMMAND', 'RUN_COMMAND'])
    expect(state.genuine).toBe(true)
    expect(state.userMessages).toBe(3)
    expect([...state.childIds]).toEqual([C])
  })

  test('turn.started carries the step\'s own created_at verbatim, and a person\'s turn only', () => {
    const { events } = foldWhole(parentLines())
    const turns = events.filter(e => e.type === 'turn.started')
    expect(turns.map(e => e.occurredAt)).toEqual(['2026-08-14T10:00:00Z', '2026-08-14T10:05:00Z', '2026-08-14T10:30:00Z'])
    for (const t of turns) expect(t.data).toEqual({ by: 'user' })
  })

  test('every event names this adapter and a re-readable record, and carries no conversation text', () => {
    const { events } = foldWhole(parentLines())
    for (const e of events) {
      expect(e.provenance.adapterVersion).toBe(ANTIGRAVITY_ADAPTER_VERSION)
      expect(e.provenance.mode).toBe('replayed')
      expect(['exact', 'estimated']).toContain(e.provenance.confidence)
      expect(e.provenance.sourceRef).toMatch(new RegExp(`^antigravity:${P}:\\d+$`))
      expect(JSON.stringify(e.data)).not.toContain('<redacted>')
      expect(JSON.stringify(e.data)).not.toContain('USER_REQUEST')
    }
  })

  test('a slash-only conversation is not genuine, and emits its lifecycle but nothing is a prompt', () => {
    const line = JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-08-14T09:00:00Z', content: '<USER_REQUEST>/help</USER_REQUEST>' })
    const { state, events } = foldWhole([line])
    expect(state.genuine).toBe(false)
    expect(state.userMessages).toBe(1)
    expect(events.filter(e => e.type === 'turn.started')).toHaveLength(1)
  })

  test('a non-final finish closes nothing', () => {
    const { events } = foldWhole(parentLines(), false)
    expect(events.some(e => e.type === 'agent.ended')).toBe(false)
    expect(events.filter(e => e.type === 'turn.ended')).toHaveLength(2)
  })
})

describe('agy transcript fold — the P1 properties', () => {
  test('folding in N uneven chunks emits the same events as folding whole', () => {
    const lines = parentLines()
    const whole = foldWhole(lines).events
    let seed = 7
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31 }
    for (let round = 0; round < 25; round++) {
      const events: AgentisticsEvent[] = []
      const state = emptyAntigravityReplay(mainContext(P, AT, '/work/app'), 'main')
      let i = 0
      while (i < lines.length) {
        const n = 1 + Math.floor(rnd() * 4)
        foldAntigravityReplay(state, lines.slice(i, i + n), e => events.push(e))
        if (rnd() < 0.3) finishAntigravityReplay(state, { final: false }, e => events.push(e))
        i += n
      }
      finishAntigravityReplay(state, { final: true }, e => events.push(e))
      expect(events).toEqual(whole)
    }
  })

  test('replaying twice derives identical ids; a second final finish emits nothing', () => {
    const a = foldWhole(parentLines())
    const b = foldWhole(parentLines())
    expect(a.events.map(e => e.eventId)).toEqual(b.events.map(e => e.eventId))
    expect(new Set(a.events.map(e => e.eventId)).size).toBe(a.events.length)
    const again: AgentisticsEvent[] = []
    finishAntigravityReplay(a.state, { final: true }, e => again.push(e))
    expect(again).toEqual([])
  })

  test('a child conversation opens a subagent under its parent and counts no person\'s turn', () => {
    const lines = readFileSync(join(FIX, 'brain', C, '.system_generated/logs/transcript_full.jsonl'), 'utf-8').split('\n')
    const events: AgentisticsEvent[] = []
    const state = emptyAntigravityReplay(childContext(P, C, mainAgentIdOf(P), AT), 'child')
    foldAntigravityReplay(state, lines, e => events.push(e))
    finishAntigravityReplay(state, { final: true }, e => events.push(e))
    expect(events.some(e => e.type.startsWith('turn.') || e.type.startsWith('session.') || e.type.startsWith('run.'))).toBe(false)
    const start = events.find(e => e.type === 'agent.started')!
    expect(start.data).toEqual({ kind: 'subagent', parentAgentId: mainAgentIdOf(P), agentType: 'invoke_subagent' })
    expect(start.sessionId).toBe(mainContext(P, AT).sessionId)
    expect(start.runId).toBe(mainContext(P, AT).runId)
  })
})
