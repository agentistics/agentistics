import { test, expect } from 'bun:test'
import { parseCodexRollout } from './codex-parse'

const SAMPLE = [
  JSON.stringify({ timestamp: '2026-05-25T18:25:51.037Z', type: 'session_meta', payload: { id: 'abc-123', timestamp: '2026-05-25T18:25:50.087Z', cwd: '/home/u/proj', model_provider: 'openai' } }),
  JSON.stringify({ timestamp: '2026-05-25T18:25:52.000Z', type: 'turn_context', payload: { model: 'gpt-5.5', cwd: '/home/u/proj' } }),
  JSON.stringify({ timestamp: '2026-05-25T18:25:53.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'hi' } }),
  JSON.stringify({ timestamp: '2026-05-25T18:25:54.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 5 } } } }),
  JSON.stringify({ timestamp: '2026-05-25T18:25:55.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'hello' } }),
  JSON.stringify({ timestamp: '2026-05-25T18:25:56.000Z', type: 'response_item', payload: { type: 'web_search_call' } }),
  JSON.stringify({ timestamp: '2026-05-25T18:25:57.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 300, cached_input_tokens: 80, output_tokens: 42 } } } }),
].join('\n')

test('parses a codex rollout (real envelope format) into a SessionMeta', () => {
  const s = parseCodexRollout(SAMPLE, 'fallback-id')
  expect(s).not.toBeNull()
  expect(s!.session_id).toBe('abc-123')
  expect(s!.harness).toBe('codex')
  expect(s!.project_path).toBe('/home/u/proj')
  expect(s!.model).toBe('gpt-5.5')
  // last token_count wins (cumulative); input is non-cached portion (300-80), cache stored separately
  expect(s!.input_tokens).toBe(220)
  expect(s!.cache_read_input_tokens).toBe(80)
  expect(s!.output_tokens).toBe(42)
  expect(s!.user_message_count).toBe(1)
  expect(s!.assistant_message_count).toBe(1)
  expect(s!.uses_web_search).toBe(true)
  expect(s!.tool_counts['web_search_call']).toBe(1)
  expect(s!.start_time).toBe('2026-05-25T18:25:50.087Z')
  expect(s!._source).toBe('jsonl')
  // first_prompt = text of the first user_message
  expect(s!.first_prompt).toBe('hi')
  // message_hours: user_message at 18:25:53Z + agent_message at 18:25:55Z, bucketed on the LOCAL
  // clock (same convention as the Claude pipeline), so the expected hour follows the host's zone.
  const localHour = new Date('2026-05-25T18:25:53.000Z').getHours()
  expect(s!.message_hours).toEqual([localHour, localHour])
  // user_message_timestamps: only the user_message line
  expect(s!.user_message_timestamps).toEqual(['2026-05-25T18:25:53.000Z'])
})

test('falls back to fallbackId and returns null on empty', () => {
  expect(parseCodexRollout('', 'fb')).toBeNull()
  const noMeta = parseCodexRollout(JSON.stringify({ type: 'event_msg', payload: { type: 'user_message' } }), 'fb-2')
  expect(noMeta!.session_id).toBe('fb-2')
  expect(noMeta!.user_message_count).toBe(1)
})

// Real shape, from a rollout on disk: the tool's NAME is in `payload.name` and the command is a
// JSON string in `payload.arguments`. Counting the envelope type instead reported every tool as
// "function_call", which says nothing and cannot be compared with another harness.
const SHELL = [
  JSON.stringify({ timestamp: '2026-05-25T18:25:51.000Z', type: 'session_meta', payload: { id: 's1', timestamp: '2026-05-25T18:25:50.000Z', cwd: '/repo' } }),
  JSON.stringify({ timestamp: '2026-05-25T18:25:52.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'git add -A && git commit -m "x"', workdir: '/repo' }) } }),
  JSON.stringify({ timestamp: '2026-05-25T18:25:53.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'git push origin main' }) } }),
  JSON.stringify({ timestamp: '2026-05-25T18:25:54.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'bun test' }) } }),
].join('\n')

test('counts codex shell commands under the shared tool name', () => {
  const s = parseCodexRollout(SHELL, 'f')!
  expect(s.tool_counts['Bash']).toBe(3)
  expect(s.tool_counts['function_call']).toBeUndefined()
})

test('counts codex git commits and pushes from the command it actually ran', () => {
  const s = parseCodexRollout(SHELL, 'f')!
  expect(s.git_commits).toBe(1)
  expect(s.git_pushes).toBe(1)
})

test('malformed arguments never throw and never count', () => {
  const lines = [
    JSON.stringify({ timestamp: '2026-05-25T18:25:51.000Z', type: 'session_meta', payload: { id: 's2', timestamp: '2026-05-25T18:25:50.000Z', cwd: '/repo' } }),
    JSON.stringify({ timestamp: '2026-05-25T18:25:52.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{not json' } }),
  ].join('\n')
  const s = parseCodexRollout(lines, 'f')!
  expect(s.git_commits).toBe(0)
  expect(s.tool_counts['Bash']).toBe(1)
})

// An `exec` / subagent rollout: Codex opens a turn with `task_started` and closes it with
// `task_complete`, but no human `user_message` ever appears.
const EXEC = [
  JSON.stringify({ timestamp: '2026-05-25T18:00:00.000Z', type: 'session_meta', payload: { id: 'x1', timestamp: '2026-05-25T18:00:00.000Z', cwd: '/repo' } }),
  JSON.stringify({ timestamp: '2026-05-25T18:00:01.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', started_at: 1779732001 } }),
  JSON.stringify({ timestamp: '2026-05-25T18:00:05.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'ok' } }),
  JSON.stringify({ timestamp: '2026-05-25T18:03:00.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', duration_ms: 172709 } }),
].join('\n')

test('task_started opens a turn when no user_message did (exec rollouts)', () => {
  const s = parseCodexRollout(EXEC, 'f')!
  expect(s.active_minutes).toBe(Math.round(172709 / 60000))
  expect(s.user_message_count).toBe(0)
})

test('task_started followed by user_message does not change active time', () => {
  const withUser = [
    EXEC.split('\n')[0],
    JSON.stringify({ timestamp: '2026-05-25T18:00:01.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }),
    JSON.stringify({ timestamp: '2026-05-25T18:00:02.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'hi' } }),
    JSON.stringify({ timestamp: '2026-05-25T18:03:00.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', duration_ms: 120000 } }),
  ].join('\n')
  const s = parseCodexRollout(withUser, 'f')!
  expect(s.active_minutes).toBe(2)
  expect(s.user_message_count).toBe(1)
})
