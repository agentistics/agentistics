/**
 * The Codex replay fold, one rule per test. Every counter is checked against `parseCodexRollout`
 * over the SAME lines — the parser is the guard, not a restatement of it.
 */
import { describe, expect, test } from 'bun:test'
import type { AgentisticsEvent } from '@agentistics/core'
import { parseCodexRollout } from '../../adapters/codex-parse'
import { CODEX_ADAPTER_VERSION, codexContext } from './replay-core'
import { emptyCodexReplay, finishCodexReplay, foldCodexReplay, replayCodexRollout, snapshotOf } from './replay'

const ID = '00000000-0000-4000-8000-0000000000aa'
const AT = '2026-09-27T00:00:00.000Z'
const ctx = () => codexContext(ID, `rollout-x-${ID}`, AT)
const L = (o: unknown) => JSON.stringify(o)
const meta = (ts = '2026-05-25T18:25:51.000Z') =>
  L({ timestamp: ts, type: 'session_meta', payload: { id: ID, timestamp: '2026-05-25T18:25:50.000Z', cwd: '/p', cli_version: '1.2.3', model_provider: 'openai' } })
const model = (ts: string, m: string) => L({ timestamp: ts, type: 'turn_context', payload: { model: m } })
const user = (ts: string | undefined, text = 'hi') =>
  L({ ...(ts ? { timestamp: ts } : {}), type: 'event_msg', payload: { type: 'user_message', message: text } })
const tokens = (ts: string, input: number, cached: number, output: number, last = 0, win?: number) =>
  L({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
    last_token_usage: { input_tokens: last }, ...(win ? { model_context_window: win } : {}) } } })
const done = (ts: string, ms?: number) =>
  L({ timestamp: ts, type: 'event_msg', payload: { type: 'task_complete', ...(ms !== undefined ? { duration_ms: ms } : {}) } })
const agent = (ts: string) => L({ timestamp: ts, type: 'event_msg', payload: { type: 'agent_message', message: 'ok' } })
const call = (ts: string, name: string, cmd: string, id = 'c1') =>
  L({ timestamp: ts, type: 'response_item', payload: { type: 'function_call', name, arguments: L({ cmd }), call_id: id } })

const of = (evs: AgentisticsEvent[], type: string) => evs.filter(e => e.type === type)
const usageSum = (evs: AgentisticsEvent[]) => of(evs, 'model.completed').reduce((a, e) => {
  const u = (e as AgentisticsEvent<'model.completed'>).data.usage
  return { input: a.input + (u.input ?? 0), cacheRead: a.cacheRead + (u.cacheRead ?? 0), output: a.output + (u.output ?? 0) }
}, { input: 0, cacheRead: 0, output: 0 })

const TWO_TURNS = [
  meta(),
  model('2026-05-25T18:25:52.000Z', 'gpt-5.5'),
  user('2026-05-25T18:25:53.000Z'),
  tokens('2026-05-25T18:25:54.000Z', 100, 20, 5, 100, 258400),
  tokens('2026-05-25T18:25:54.500Z', 150, 20, 9, 60, 258400),
  done('2026-05-25T18:25:55.000Z', 2000),
  user('2026-05-25T18:26:53.000Z'),
  tokens('2026-05-25T18:26:57.000Z', 300, 80, 42, 90, 258400),
  agent('2026-05-25T18:26:58.000Z'),
]

describe('the trap: cumulative usage becomes ONE delta per turn', () => {
  const evs = replayCodexRollout(ctx(), TWO_TURNS)

  test('one model.completed per turn, keyed on the LAST token_count of the turn', () => {
    const mc = of(evs, 'model.completed') as AgentisticsEvent<'model.completed'>[]
    expect(mc.map(e => e.provenance.sourceRef)).toEqual([`codex:${ID}:5`, `codex:${ID}:8`])
    // turn 1: snapshot (150-20, 20, 9); turn 2: (220, 80, 42) minus it.
    expect(mc[0]!.data.usage).toEqual({ input: 130, cacheRead: 20, output: 9 })
    expect(mc[1]!.data.usage).toEqual({ input: 90, cacheRead: 60, output: 33 })
    for (const e of mc) {
      expect(e.provenance.confidence).toBe('exact')
      expect(e.data.usage.cacheWrite).toBeUndefined() // D21: never stated by the parser's reading
      expect(e.data.model).toBe('gpt-5.5')
      expect(e.data.provider).toBe('openai')
    }
    expect(mc[0]!.data.contextTokens).toBe(60)
    expect(mc[1]!.data.contextWindow).toBe(258400)
  })

  test('the deltas telescope to exactly the parser\'s last-wins totals', () => {
    const legacy = parseCodexRollout(TWO_TURNS.join('\n'), 'f')!
    expect(usageSum(evs)).toEqual({ input: legacy.input_tokens ?? 0, cacheRead: legacy.cache_read_input_tokens ?? 0, output: legacy.output_tokens ?? 0 })
  })

  test('a rate-limits-only token_count and an unchanged snapshot emit nothing', () => {
    const lines = [meta(), user('2026-05-25T18:25:53.000Z'),
      tokens('2026-05-25T18:25:54.000Z', 100, 20, 5),
      L({ timestamp: '2026-05-25T18:25:54.100Z', type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: {} } }),
      done('2026-05-25T18:25:55.000Z'),
      user('2026-05-25T18:26:00.000Z'),
      tokens('2026-05-25T18:26:01.000Z', 100, 20, 5),
    ]
    expect(of(replayCodexRollout(ctx(), lines), 'model.completed')).toHaveLength(1)
  })

  test('the snapshot is the parser\'s split: input minus cached, output kept when absent', () => {
    expect(snapshotOf({ info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 30 } } }, { input: 0, cacheRead: 0, output: 7 }))
      .toEqual({ input: 0, cacheRead: 30, output: 7 })
    expect(snapshotOf({ info: null }, null)).toBeNull()
  })

  test('a counter that goes DOWN restarts the series: the pending delta is emitted, the new one counted whole', () => {
    const lines = [meta(), model('2026-05-25T18:25:52.000Z', 'm'), user('2026-05-25T18:25:53.000Z'),
      tokens('2026-05-25T18:25:54.000Z', 1000, 200, 50), tokens('2026-05-25T18:25:55.000Z', 400, 100, 10)]
    const u = of(replayCodexRollout(ctx(), lines), 'model.completed').map(e => (e as AgentisticsEvent<'model.completed'>).data.usage)
    expect(u).toEqual([{ input: 800, cacheRead: 200, output: 50 }, { input: 300, cacheRead: 100, output: 10 }])
    // Legacy keeps only the last snapshot here — the one row the differential must EXPLAIN.
    expect(parseCodexRollout(lines.join('\n'), 'f')!.input_tokens).toBe(300)
  })
})

describe('finish', () => {
  test('a non-final finish emits nothing; the final one emits the held turn, its close and the ends', () => {
    const s = emptyCodexReplay(ctx())
    const out: AgentisticsEvent[] = []
    foldCodexReplay(s, TWO_TURNS, e => out.push(e))
    const before = out.length
    finishCodexReplay(s, { final: false }, e => out.push(e))
    expect(out.length).toBe(before)
    finishCodexReplay(s, { final: true }, e => out.push(e))
    expect(out.slice(before).map(e => e.type)).toEqual(['model.completed', 'turn.ended', 'agent.ended', 'run.ended', 'session.ended'])
    const again: AgentisticsEvent[] = []
    finishCodexReplay(s, { final: true }, e => again.push(e))
    expect(again).toEqual([])
  })
})

describe('turns (D22/D25) — where activeTime.ts opens and closes them', () => {
  const evs = replayCodexRollout(ctx(), TWO_TURNS)
  test('a turn.started per user_message; measured on task_complete, last-line at the end', () => {
    expect(of(evs, 'turn.started').map(e => e.provenance.sourceRef)).toEqual([`codex:${ID}:3`, `codex:${ID}:7`])
    const ends = of(evs, 'turn.ended') as AgentisticsEvent<'turn.ended'>[]
    expect(ends.map(e => [e.provenance.sourceRef, e.data])).toEqual([
      [`codex:${ID}:6`, { close: 'measured', durationMs: 2000 }],
      [`codex:${ID}:9`, { close: 'last-line' }],
    ])
  })

  test('the next prompt closes an unmeasured turn at the last TIMED line before it', () => {
    const lines = [meta(), user('2026-05-25T18:25:53.000Z'), agent('2026-05-25T18:25:58.000Z'),
      L({ type: 'event_msg', payload: { type: 'agent_message', message: 'untimed' } }), user('2026-05-25T18:30:00.000Z')]
    const ends = of(replayCodexRollout(ctx(), lines), 'turn.ended')
    expect(ends[0]!.provenance.sourceRef).toBe(`codex:${ID}:3`)
  })

  test('an unstamped user_message is still a turn, on the replay clock and estimated', () => {
    const e = of(replayCodexRollout(ctx(), [meta(), user(undefined)]), 'turn.started')[0]!
    expect(e.provenance.confidence).toBe('estimated')
    expect(e.occurredAt).toBe(AT)
  })

  test('a measurement with no open turn invents nothing', () => {
    expect(of(replayCodexRollout(ctx(), [meta(), done('2026-05-25T18:25:55.000Z', 900)]), 'turn.ended')).toEqual([])
  })
})

describe('lifecycle, tools and the text rule', () => {
  const evs = replayCodexRollout(ctx(), [...TWO_TURNS,
    call('2026-05-25T18:27:00.000Z', 'exec_command', 'cd /secret/dir && git commit -m "SECRET-MSG"'),
    user('2026-05-25T18:27:01.000Z', 'SECRET-PROMPT')])

  test('opens on the session_meta at ITS stated start, names the conversation and the cli', () => {
    const run = of(evs, 'run.started')[0] as AgentisticsEvent<'run.started'>
    expect(run.occurredAt).toBe('2026-05-25T18:25:50.000Z')
    expect(run.data).toEqual({ harness: 'codex', harnessVersion: '1.2.3', conversationId: ID, conversationLink: 'observed', cwd: '/p' })
  })

  test('a tool is named by the harness and canonicalised; a shell command only as its summary', () => {
    const t = of(evs, 'tool.requested')[0] as AgentisticsEvent<'tool.requested'>
    expect(t.data.name).toBe('exec_command')
    expect(t.data.canonicalName).toBe('Bash')
    expect(t.data.kind).toBe('shell')
    expect(t.data.summary?.startsWith('git commit')).toBe(true)
  })

  test('no prompt, answer or raw command text reaches an event', () => {
    const json = JSON.stringify(evs)
    expect(json).not.toContain('SECRET-PROMPT')
    expect(json).not.toContain('/secret/dir')
  })

  test('every envelope names this adapter; replaying twice derives the identical ids', () => {
    for (const e of evs) expect(e.provenance.adapterVersion).toBe(CODEX_ADAPTER_VERSION)
    const again = replayCodexRollout(ctx(), [...TWO_TURNS,
      call('2026-05-25T18:27:00.000Z', 'exec_command', 'cd /secret/dir && git commit -m "SECRET-MSG"'),
      user('2026-05-25T18:27:01.000Z', 'SECRET-PROMPT')])
    expect(again.map(e => e.eventId)).toEqual(evs.map(e => e.eventId))
    expect(new Set(evs.map(e => e.eventId)).size).toBe(evs.length)
  })
})
