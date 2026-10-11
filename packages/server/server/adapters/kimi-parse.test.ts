import { test, expect } from 'bun:test'
import {
  parseKimiState, kimiAgentIds, stripProvider, accumulateKimiWire, buildKimiSession,
} from './kimi-parse'

/** Real event shapes, trimmed. A turn is: turn.prompt → step.begin → tool.call/result → step.end,
 *  with a usage.record alongside the step.end that repeats its numbers exactly. */
const T0 = 1785191518480
const wire = (lines: unknown[]): string => lines.map(l => JSON.stringify(l)).join('\n')

const usageRecord = (over: Partial<Record<string, number>> = {}) => ({
  type: 'usage.record',
  model: 'google/gemini-3.5-flash-lite',
  usage: { inputOther: 100, output: 10, inputCacheRead: 50, inputCacheCreation: 5, ...over },
  usageScope: 'turn',
  time: T0 + 1000,
})
const stepEndEcho = (over: Partial<Record<string, number>> = {}) => ({
  type: 'context.append_loop_event',
  event: {
    type: 'step.end', turnId: '0', step: 1,
    // Byte-identical to the usage.record above — this is the trap.
    usage: { inputOther: 100, output: 10, inputCacheRead: 50, inputCacheCreation: 5, ...over },
    finishReason: 'end_turn',
  },
  time: T0 + 1000,
})
const userPrompt = (text: string, time = T0) => ({
  type: 'turn.prompt', input: [{ type: 'text', text }], origin: { kind: 'user' }, time,
})

test('token counts come from usage.record only — step.end repeats them', () => {
  // Summing both sources doubled every figure on real data.
  const totals = accumulateKimiWire(wire([userPrompt('salve'), usageRecord(), stepEndEcho()]))
  expect(totals.inputTokens).toBe(100)
  expect(totals.outputTokens).toBe(10)
  expect(totals.cacheRead).toBe(50)
  expect(totals.cacheCreation).toBe(5)
})

test('usage records accumulate across turns rather than replacing each other', () => {
  // They are per-turn increments, not a running total (unlike Codex, where the last one wins).
  const totals = accumulateKimiWire(wire([
    userPrompt('one'), usageRecord(), stepEndEcho(),
    usageRecord({ inputOther: 200, output: 20 }), stepEndEcho({ inputOther: 200, output: 20 }),
  ]))
  expect(totals.inputTokens).toBe(300)
  expect(totals.outputTokens).toBe(30)
})

test('the model loses its provider prefix so the pricing table can key on it', () => {
  expect(stripProvider('google/gemini-3.5-flash-lite')).toBe('gemini-3.5-flash-lite')
  expect(stripProvider('kimi-k2')).toBe('kimi-k2')
  expect(stripProvider('')).toBe('')
  const totals = accumulateKimiWire(wire([userPrompt('x'), usageRecord()]))
  expect(totals.model).toBe('gemini-3.5-flash-lite')
})

test('tools are counted from the nested loop events, with MCP recognised by its prefix', () => {
  const totals = accumulateKimiWire(wire([
    userPrompt('x'),
    { type: 'context.append_loop_event', event: { type: 'tool.call', name: 'Bash' }, time: T0 },
    { type: 'context.append_loop_event', event: { type: 'tool.call', name: 'Read' }, time: T0 },
    { type: 'context.append_loop_event', event: { type: 'tool.call', name: 'Read' }, time: T0 },
    { type: 'context.append_loop_event', event: { type: 'tool.call', name: 'mcp__db__query' }, time: T0 },
  ]))
  expect(totals.toolCounts).toEqual({ Bash: 1, Read: 2, mcp__db__query: 1 })
  expect(totals.usesMcp).toBe(true)
})

test('a failed tool result is counted once, however it reports the failure', () => {
  const totals = accumulateKimiWire(wire([
    userPrompt('x'),
    { type: 'context.append_loop_event', event: { type: 'tool.result', isError: true }, time: T0 },
    { type: 'context.append_loop_event', event: { type: 'tool.result', exitCode: 127 }, time: T0 },
    { type: 'context.append_loop_event', event: { type: 'tool.result', status: 'error' }, time: T0 },
    // Success in three flavours — none of these count.
    { type: 'context.append_loop_event', event: { type: 'tool.result', exitCode: 0 }, time: T0 },
    { type: 'context.append_loop_event', event: { type: 'tool.result', status: 'ok' }, time: T0 },
    { type: 'context.append_loop_event', event: { type: 'tool.result' }, time: T0 },
  ]))
  expect(totals.toolErrors).toBe(3)
})

test('only genuine user turns become prompts and activity hours', () => {
  const totals = accumulateKimiWire(wire([
    userPrompt('first'),
    { type: 'turn.prompt', input: [{ type: 'text', text: 'replayed' }], origin: { kind: 'system' }, time: T0 },
    userPrompt('second', T0 + 60_000),
  ]))
  expect(totals.userPrompts).toBe(2)
  expect(totals.firstPrompt).toBe('first')
  expect(totals.hours.length).toBe(2)
  expect(totals.hours[0]).toBe(new Date(T0).getHours()) // local clock, like every other adapter
})

test('malformed lines are skipped instead of throwing', () => {
  const totals = accumulateKimiWire([
    'not json',
    '{"type":"usage.record"}',            // no usage object
    JSON.stringify(userPrompt('ok')),
    '{"type":"context.append_loop_event"}', // no event
    '',
  ].join('\n'))
  expect(totals.userPrompts).toBe(1)
  expect(totals.inputTokens).toBe(0)
})

test('a session with no user turn is dropped, like a bootstrap stub', () => {
  const totals = accumulateKimiWire(wire([usageRecord(), stepEndEcho()]))
  expect(buildKimiSession('id', { createdAt: '2026-07-27T22:00:00.000Z' }, totals)).toBeNull()
})

test('state.json supplies the identity the wire does not carry', () => {
  const totals = accumulateKimiWire(wire([userPrompt('salve'), usageRecord(), stepEndEcho()]))
  const s = buildKimiSession('c72d917d', {
    title: 'salve',
    workDir: '/home/padawan',
    createdAt: '2026-07-27T22:26:15.061Z',
    updatedAt: '2026-07-27T22:35:50.015Z',
  }, totals)!
  expect(s.harness).toBe('kimi')
  expect(s.title).toBe('salve')
  expect(s.project_path).toBe('/home/padawan')
  expect(s.duration_minutes).toBe(10)
  expect(s.input_tokens).toBe(100)
})

test('the workDir falls back to the global index when state.json has none', () => {
  const totals = accumulateKimiWire(wire([userPrompt('x'), usageRecord()]))
  const s = buildKimiSession('id', { createdAt: '2026-07-27T22:00:00.000Z' }, totals, '/from/index')!
  expect(s.project_path).toBe('/from/index')
})

test('every agent of a session is read, so sub-agent work is not lost', () => {
  const state = parseKimiState(JSON.stringify({
    agents: { main: { parentAgentId: null }, 'agent_1': { parentAgentId: 'main' } },
  }))
  expect(kimiAgentIds(state).sort()).toEqual(['agent_1', 'main'])
  // A session with no agent map still reads the default agent.
  expect(kimiAgentIds(null)).toEqual(['main'])
  expect(kimiAgentIds({})).toEqual(['main'])
})

test('parseKimiState tolerates a missing or broken file', () => {
  expect(parseKimiState('')).toBeNull()
  expect(parseKimiState('{oops')).toBeNull()
  expect(parseKimiState('{"title":"t"}')?.title).toBe('t')
})

test('a local runtime prefix survives, because it is what says the call was free', () => {
  expect(stripProvider('ollama-local/qwen2.5-coder-7b')).toBe('ollama-local/qwen2.5-coder-7b')
  expect(stripProvider('ollama/llama3.1')).toBe('ollama/llama3.1')
})

test('a hosted provider prefix is still stripped, so the pricing table can key on the id', () => {
  expect(stripProvider('google/gemini-3.5-flash-lite')).toBe('gemini-3.5-flash-lite')
  expect(stripProvider('moonshot/kimi-k2')).toBe('kimi-k2')
})

/** A wire with one real prompt, so buildKimiSession does not drop the session as empty. */
const wireWithOnePrompt = () => accumulateKimiWire(wire([
  { type: 'turn.prompt', input: [{ type: 'text', text: 'oi' }], origin: { kind: 'user' }, time: T0 },
]))

// Kimi writes `createdAt` as an epoch NUMBER in most sessions and an ISO string in others —
// measured on a live machine: 10 of 11 were numbers. The declared type said `string`, so the number
// travelled all the way into the consolidate store and every consumer that treats start_time as a
// string (supplementStatsCache does `.slice(0, 10)`) threw — taking the WHOLE dashboard down over
// one session.
test('an epoch-number createdAt becomes an ISO start_time', () => {
  const state = parseKimiState(JSON.stringify({
    createdAt: 1785939883717,
    workDir: '/repo',
    agents: { main: { type: 'main' } },
  }))
  const s = buildKimiSession('abc', state, wireWithOnePrompt(), '/repo')!
  expect(typeof s.start_time).toBe('string')
  expect(s.start_time).toBe(new Date(1785939883717).toISOString())
})

test('an ISO createdAt is passed through untouched', () => {
  const state = parseKimiState(JSON.stringify({
    createdAt: '2026-08-05T14:01:24.097Z',
    workDir: '/repo',
    agents: { main: { type: 'main' } },
  }))
  const s = buildKimiSession('abc', state, wireWithOnePrompt(), '/repo')!
  expect(s.start_time).toBe('2026-08-05T14:01:24.097Z')
})

// Same trap, the sibling field: `updatedAt` is written by the same Kimi CLI in the same state.json
// and is exactly as likely to be an epoch number — measured on this same live machine: 10 of 11
// session files had a numeric `updatedAt`. It was declared `string` only and read raw (skipping
// `isoFromKimiTime`), so a numeric `end_time` reached SessionMeta and crashed `parseISO` on the
// frontend — the same class of bug as createdAt, caught a second time instead of fixed once.
test('an epoch-number updatedAt becomes an ISO end_time', () => {
  const state = parseKimiState(JSON.stringify({
    createdAt: '2026-08-05T14:01:24.097Z',
    updatedAt: 1785940839984,
    workDir: '/repo',
    agents: { main: { type: 'main' } },
  }))
  const s = buildKimiSession('abc', state, wireWithOnePrompt(), '/repo')!
  expect(typeof s.end_time).toBe('string')
  expect(s.end_time).toBe(new Date(1785940839984).toISOString())
})

test('an ISO updatedAt is passed through untouched', () => {
  const state = parseKimiState(JSON.stringify({
    createdAt: '2026-08-05T14:01:24.097Z',
    updatedAt: '2026-08-05T14:05:00.000Z',
    workDir: '/repo',
    agents: { main: { type: 'main' } },
  }))
  const s = buildKimiSession('abc', state, wireWithOnePrompt(), '/repo')!
  expect(s.end_time).toBe('2026-08-05T14:05:00.000Z')
})

// Shape verified against a live wire.jsonl AND against the tool schema Kimi itself sends to the
// model (`llm.tools_snapshot`): Bash declares `properties.command` — "The command to execute."
test('counts kimi git commands from the Bash tool call', () => {
  const totals = accumulateKimiWire(wire([
    { type: 'turn.prompt', input: [{ type: 'text', text: 'commita' }], origin: { kind: 'user' }, time: T0 },
    { type: 'context.append_loop_event', event: { type: 'tool.call', name: 'Bash', args: { command: 'git add -A && git commit -m "x"' } }, time: T0 },
    { type: 'context.append_loop_event', event: { type: 'tool.call', name: 'Bash', args: { command: 'git push' } }, time: T0 },
    { type: 'context.append_loop_event', event: { type: 'tool.call', name: 'Bash', args: { command: 'bun test' } }, time: T0 },
  ]))
  const s = buildKimiSession('k1', null, totals, '/repo')!
  expect(s.git_commits).toBe(1)
  expect(s.git_pushes).toBe(1)
  expect(s.tool_counts['Bash']).toBe(3)
})

test('a Bash call with no command counts as a call and nothing more', () => {
  const totals = accumulateKimiWire(wire([
    { type: 'turn.prompt', input: [{ type: 'text', text: 'oi' }], origin: { kind: 'user' }, time: T0 },
    { type: 'context.append_loop_event', event: { type: 'tool.call', name: 'Bash', args: {} }, time: T0 },
  ]))
  const s = buildKimiSession('k2', null, totals, '/repo')!
  expect(s.git_commits).toBe(0)
  expect(s.tool_counts['Bash']).toBe(1)
})

// A run that failed before any model answered: the wire names the model it tried (`llm.request`,
// `profile.bind`) but carries no `usage.record`.
const llmRequest = (over: Record<string, unknown> = {}) => ({
  type: 'llm.request', provider: 'ollama-local', model: 'qwen-x', modelAlias: 'ollama-local/qwen-x', time: T0 + 500, ...over,
})

test('with no usage.record the model comes from llm.request and tokens are flagged unavailable', () => {
  const totals = accumulateKimiWire(wire([userPrompt('hi'), llmRequest(), llmRequest()]))
  const s = buildKimiSession('k1', null, totals, '/w')!
  expect(s.model).toBe('ollama-local/qwen-x')
  expect(s.tokens_unavailable).toBe(true)
})

test('profile.bind.modelAlias is a fallback behind llm.request', () => {
  const bind = { type: 'profile.bind', modelAlias: 'google/gemini-3.5-flash-lite', time: T0 + 100 }
  const onlyBind = buildKimiSession('k', null, accumulateKimiWire(wire([bind, userPrompt('hi')])), '/w')!
  expect(onlyBind.model).toBe('gemini-3.5-flash-lite')
  const both = buildKimiSession('k', null, accumulateKimiWire(wire([bind, userPrompt('hi'), llmRequest()])), '/w')!
  expect(both.model).toBe('ollama-local/qwen-x')
})

test('a usage.record model wins over llm.request, and tokens are not flagged', () => {
  const totals = accumulateKimiWire(wire([userPrompt('hi'), llmRequest(), usageRecord()]))
  const s = buildKimiSession('k', null, totals, '/w')!
  expect(s.model).toBe('gemini-3.5-flash-lite')
  expect(s.tokens_unavailable).toBeUndefined()
  expect(s.input_tokens).toBe(100)
})
