import { test, expect } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { parseCopilotEvents, parseCopilotWorkspace, copilotGitRemote } from './copilot-parse'

// Minimal real-world-shaped sample — no session.shutdown (crashed/no clean exit)
const SAMPLE_NO_SHUTDOWN = [
  JSON.stringify({ type: 'session.start', data: { sessionId: 'uuid-abc-123', startTime: '2026-02-23T00:04:51.096Z', context: { cwd: '/home/u/proj', gitRoot: '/home/u/proj', branch: 'main', repository: 'user/repo' } }, timestamp: '2026-02-23T00:04:51.119Z' }),
  JSON.stringify({ type: 'session.info', data: { infoType: 'mcp', message: 'GitHub MCP Server: Connected' }, timestamp: '2026-02-23T00:05:00.000Z' }),
  JSON.stringify({ type: 'session.info', data: { infoType: 'authentication', message: 'Signed in successfully' }, timestamp: '2026-02-23T00:05:01.000Z' }),
  JSON.stringify({ type: 'user.message', data: { content: 'hello copilot' }, timestamp: '2026-02-23T00:06:00.000Z' }),
  JSON.stringify({ type: 'assistant.turn_start', data: { turnId: '0' }, timestamp: '2026-02-23T00:06:01.000Z' }),
  JSON.stringify({ type: 'assistant.turn_end', data: { turnId: '0' }, timestamp: '2026-02-23T00:07:00.000Z' }),
  JSON.stringify({ type: 'session.error', data: { errorType: 'query', message: 'Something failed' }, timestamp: '2026-02-23T00:07:01.000Z' }),
].join('\n')

// Session with a clean shutdown — carries full token metrics, model, and code changes
const SHUTDOWN_EVENT = {
  type: 'session.shutdown',
  data: {
    shutdownType: 'routine',
    totalPremiumRequests: 0.66,
    totalApiDurationMs: 5073,
    sessionStartTime: 1782082362688,
    codeChanges: {
      linesAdded: 12,
      linesRemoved: 3,
      filesModified: ['/home/u/proj/src/foo.ts', '/home/u/proj/src/bar.ts'],
    },
    modelMetrics: {
      'gpt-5.4-mini': {
        requests: { count: 2, cost: 0.66 },
        usage: {
          inputTokens: 37453,
          outputTokens: 65,
          cacheReadTokens: 18432,
          cacheWriteTokens: 0,
          reasoningTokens: 43,
        },
      },
    },
    currentModel: 'gpt-5.4-mini',
    currentTokens: 20294,
  },
  id: 'shutdown-event-id',
  timestamp: '2026-02-23T00:10:00.000Z',
}

const SAMPLE_WITH_SHUTDOWN = [
  JSON.stringify({ type: 'session.start', data: { sessionId: 'uuid-def-456', startTime: '2026-02-23T00:04:51.096Z', context: { cwd: '/home/u/proj' } }, timestamp: '2026-02-23T00:04:51.119Z' }),
  JSON.stringify({ type: 'user.message', data: { content: 'hello copilot' }, timestamp: '2026-02-23T00:06:00.000Z' }),
  JSON.stringify({ type: 'user.message', data: { content: 'second message' }, timestamp: '2026-02-23T01:00:00.000Z' }),
  JSON.stringify({ type: 'assistant.turn_start', data: { turnId: '0' }, timestamp: '2026-02-23T00:06:01.000Z' }),
  JSON.stringify(SHUTDOWN_EVENT),
].join('\n')

test('parses a copilot events.jsonl without shutdown into a SessionMeta', () => {
  const s = parseCopilotEvents(SAMPLE_NO_SHUTDOWN, 'fallback-id')
  expect(s).not.toBeNull()
  expect(s!.harness).toBe('copilot')
  expect(s!._source).toBe('jsonl')
  expect(s!.session_id).toBe('uuid-abc-123')
  expect(s!.project_path).toBe('/home/u/proj')
  expect(s!.start_time).toBe('2026-02-23T00:04:51.096Z')
  expect(s!.user_message_count).toBe(1)
  expect(s!.assistant_message_count).toBe(1)
  expect(s!.uses_mcp).toBe(true)
  expect(s!.tool_errors).toBe(1)
  // no tokens/model without clean shutdown
  expect(s!.input_tokens).toBe(0)
  expect(s!.output_tokens).toBe(0)
  expect(s!.cache_read_input_tokens).toBe(0)
  expect(s!.model).toBeUndefined()
  expect(s!.lines_added).toBe(0)
  expect(s!.lines_removed).toBe(0)
  expect(s!.files_modified).toBe(0)
  // first prompt captured from user.message
  expect(s!.first_prompt).toBe('hello copilot')
  // duration: from startTime to last event timestamp
  expect(s!.duration_minutes).toBeGreaterThan(0)
  // user.message at 00:06:00Z → hour=0, timestamp captured
  expect(s!.user_message_timestamps).toEqual(['2026-02-23T00:06:00.000Z'])
  // Hours are bucketed on the LOCAL clock (same convention as the Claude pipeline), so derive the
  // expectation from the host zone instead of pinning a UTC hour.
  expect(s!.message_hours).toEqual([new Date('2026-02-23T00:06:00.000Z').getHours()])
})

test('extracts tokens, model, and code changes from session.shutdown', () => {
  const s = parseCopilotEvents(SAMPLE_WITH_SHUTDOWN, 'fallback-id')
  expect(s).not.toBeNull()
  expect(s!.session_id).toBe('uuid-def-456')
  // Token metrics from modelMetrics
  expect(s!.input_tokens).toBe(37453)
  expect(s!.output_tokens).toBe(65)
  expect(s!.cache_read_input_tokens).toBe(18432)
  expect(s!.cache_creation_input_tokens).toBe(0)
  // Model from currentModel
  expect(s!.model).toBe('gpt-5.4-mini')
  // Code changes
  expect(s!.lines_added).toBe(12)
  expect(s!.lines_removed).toBe(3)
  expect(s!.files_modified).toBe(2) // length of filesModified array
  // first_prompt from first user.message
  expect(s!.first_prompt).toBe('hello copilot')
  // Turn counts and timestamps still work
  expect(s!.user_message_count).toBe(2)
  expect(s!.assistant_message_count).toBe(1)
  expect(s!.user_message_timestamps).toEqual([
    '2026-02-23T00:06:00.000Z',
    '2026-02-23T01:00:00.000Z',
  ])
  expect(s!.message_hours).toEqual([
    new Date('2026-02-23T00:06:00.000Z').getHours(),
    new Date('2026-02-23T01:00:00.000Z').getHours(),
  ])
})

test('returns null on empty content', () => {
  expect(parseCopilotEvents('', 'fb')).toBeNull()
  expect(parseCopilotEvents('   \n  ', 'fb')).toBeNull()
})

test('falls back to fallbackId when no session.start present', () => {
  const noStart = JSON.stringify({ type: 'user.message', data: { content: 'hi' }, timestamp: '2026-02-23T01:00:00.000Z' })
  const s = parseCopilotEvents(noStart, 'dir-uuid')
  expect(s).not.toBeNull()
  expect(s!.session_id).toBe('dir-uuid')
  expect(s!.user_message_count).toBe(1)
  expect(s!.uses_mcp).toBe(false)
})

test('mcp flag only set by session.info with infoType=mcp', () => {
  const noMcp = [
    JSON.stringify({ type: 'session.start', data: { sessionId: 'x', startTime: '2026-01-01T00:00:00.000Z', context: { cwd: '/a' } }, timestamp: '2026-01-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'session.info', data: { infoType: 'authentication', message: 'ok' }, timestamp: '2026-01-01T00:00:01.000Z' }),
  ].join('\n')
  const s = parseCopilotEvents(noMcp, 'fb')
  expect(s!.uses_mcp).toBe(false)
})

test('skips malformed JSON lines gracefully', () => {
  const mixed = [
    'not valid json',
    JSON.stringify({ type: 'session.start', data: { sessionId: 'ok-id', startTime: '2026-03-01T10:00:00.000Z', context: { cwd: '/home/x' } }, timestamp: '2026-03-01T10:00:00.000Z' }),
    '{broken',
    JSON.stringify({ type: 'user.message', data: { content: 'test' }, timestamp: '2026-03-01T10:01:00.000Z' }),
  ].join('\n')
  const s = parseCopilotEvents(mixed, 'fb')
  expect(s).not.toBeNull()
  expect(s!.session_id).toBe('ok-id')
  expect(s!.user_message_count).toBe(1)
})

// --- workspace.yaml: the identity events.jsonl does not carry -----------------------------------

const REAL_WORKSPACE = `id: 155dfe66-173e-4397-b5e9-9f7062d456ba
cwd: /home/padawan/prontuario
git_root: /home/padawan/prontuario
repository: blpsoares/prontuario
host_type: github
branch: main
client_name: github/cli
name: Salve Coding Session
user_named: false
summary_count: 0
created_at: 2026-07-27T22:37:43.507Z
`

test('parseCopilotWorkspace reads the fields the session needs', () => {
  const ws = parseCopilotWorkspace(REAL_WORKSPACE)
  expect(ws.cwd).toBe('/home/padawan/prontuario')
  expect(ws.repository).toBe('blpsoares/prontuario')
  expect(ws.hostType).toBe('github')
  expect(ws.branch).toBe('main')
  expect(ws.name).toBe('Salve Coding Session')
})

test('parseCopilotWorkspace keeps agentop session identity when Copilot uses a different UUID', () => {
  expect(parseCopilotWorkspace('id: copilot-uuid\nmc_session_id: agentop-session\n').mcSessionId).toBe('agentop-session')
})

test('reads a sanitized current fixture with cumulative premium-request checkpoints', async () => {
  const fixture = await readFile(new URL('./fixtures/copilot-current-events.jsonl', import.meta.url), 'utf8')
  const s = parseCopilotEvents(fixture, 'fallback')!
  expect(s.session_id).toBe('copilot-uuid')
  expect(s.model).toBe('gpt-5.6-luna')
  expect(s.copilot_credits).toEqual({ nanoAiu: 808713000, premiumRequests: 2 })
  expect(s.input_tokens + s.output_tokens + s.cache_read_input_tokens! + s.cache_creation_input_tokens!).toBe(29)
})

test('parseCopilotWorkspace survives junk without throwing', () => {
  expect(parseCopilotWorkspace('')).toEqual({})
  expect(parseCopilotWorkspace('no-colon-here\n\n# comment: x')).toEqual({})
  // A quoted value keeps its content, not its quotes.
  expect(parseCopilotWorkspace('name: "Quoted Name"').name).toBe('Quoted Name')
  // An indented line belongs to a nested structure we do not read.
  expect(parseCopilotWorkspace('outer:\n  cwd: /nested').cwd).toBeUndefined()
})

test('a github repository becomes the same remote key every other harness uses', () => {
  expect(copilotGitRemote(parseCopilotWorkspace(REAL_WORKSPACE))).toBe('github.com/blpsoares/prontuario')
})

test('a non-github host is left unattributed rather than guessed', () => {
  // The enterprise hostname is not recorded anywhere in this file, and inventing one would file the
  // sessions under a repository that does not exist.
  expect(copilotGitRemote({ repository: 'org/repo', hostType: 'ghes' })).toBeUndefined()
  expect(copilotGitRemote({ hostType: 'github' })).toBeUndefined()
  expect(copilotGitRemote({})).toBeUndefined()
})

// `tool.execution_start` carries the tool name and its arguments — the reason `tools: false` in the
// capability table was simply out of date. The matching `_complete` can carry a unified diff.
const TOOLS = [
  JSON.stringify({ type: 'session.start', timestamp: '2026-02-13T14:35:00.000Z', data: { workspace: '/repo' } }),
  JSON.stringify({ type: 'user.message', timestamp: '2026-02-13T14:35:10.000Z', data: { content: 'go' } }),
  JSON.stringify({ type: 'tool.execution_start', timestamp: '2026-02-13T14:35:20.000Z', data: { toolCallId: 't1', toolName: 'view', arguments: { path: '/repo/a.ts' } } }),
  JSON.stringify({ type: 'tool.execution_start', timestamp: '2026-02-13T14:35:21.000Z', data: { toolCallId: 't2', toolName: 'bash', arguments: { command: 'git commit -m x && git push' } } }),
  JSON.stringify({ type: 'tool.execution_start', timestamp: '2026-02-13T14:35:22.000Z', data: { toolCallId: 't3', toolName: 'bash', arguments: { command: 'bun test' } } }),
].join('\n')

test('counts copilot tools under the shared names', () => {
  const s = parseCopilotEvents(TOOLS, 'f')!
  expect(s.tool_counts['Read']).toBe(1)
  expect(s.tool_counts['Bash']).toBe(2)
})

test('counts copilot git commands from the shell tool it actually ran', () => {
  const s = parseCopilotEvents(TOOLS, 'f')!
  expect(s.git_commits).toBe(1)
  expect(s.git_pushes).toBe(1)
})

test('a tool with no name is not counted under an empty key', () => {
  const lines = [
    JSON.stringify({ type: 'session.start', timestamp: '2026-02-13T14:35:00.000Z', data: { workspace: '/repo' } }),
    JSON.stringify({ type: 'user.message', timestamp: '2026-02-13T14:35:10.000Z', data: { content: 'go' } }),
    JSON.stringify({ type: 'tool.execution_start', timestamp: '2026-02-13T14:35:20.000Z', data: { toolCallId: 't1' } }),
  ].join('\n')
  const s = parseCopilotEvents(lines, 'f')!
  expect(Object.keys(s.tool_counts)).toEqual([])
})
