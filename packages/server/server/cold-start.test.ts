import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyClaudeParse, foldClaudeParse, foldClaudeParseYielding, iterLines } from './jsonl'
import { summarizeSubagentTranscript, summarizeSubagentTranscriptYielding } from './subagent-parse'
import { parseCodexRollout, parseCodexRolloutYielding } from './adapters/codex-parse'

const user = JSON.stringify({ type: 'user', timestamp: '2026-01-01T10:00:00Z', cwd: '/fixture', message: { content: 'hello' } })
const assistant = (output: number) => JSON.stringify({
  type: 'assistant', timestamp: '2026-01-01T10:00:05Z',
  message: { id: 'same-response', model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: output }, content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: '/fixture/a.ts' } }] },
})
const transcript = [' ', user, assistant(1), 'bad json', assistant(8), ''].join('\n')

test('cooperative Claude and subagent folds preserve all fixture counters, including last-wins usage', async () => {
  const expected = emptyClaudeParse()
  foldClaudeParse(expected, iterLines(transcript))
  const actual = emptyClaudeParse()
  await foldClaudeParseYielding(actual, iterLines(transcript))
  expect(actual).toEqual(expected)
  expect(actual.outputTokens).toBe(8)
  expect(await summarizeSubagentTranscriptYielding(iterLines(transcript)))
    .toEqual(summarizeSubagentTranscript(iterLines(transcript)))
})

test('cooperative Codex parser preserves the entire fixture session', async () => {
  const content = [
    JSON.stringify({ type: 'session_meta', payload: { id: 'fixture', cwd: '/fixture', timestamp: '2026-01-01T10:00:00Z' } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-01-01T10:00:01Z', payload: { type: 'user_message', message: 'hello' } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-01-01T10:00:02Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 8 } } } }),
    '',
  ].join('\n')
  const expected = parseCodexRollout(content, 'fallback')
  expect(await parseCodexRolloutYielding(content, 'fallback')).toEqual(expected)
  expect(expected).toMatchObject({ session_id: 'fixture', input_tokens: 15, output_tokens: 8 })
  expect(await parseCodexRolloutYielding(' \n', 'empty')).toBeNull()
})

// A subprocess keeps Bun's module mocks and data.ts's process-wide cache out of other tests.
// The tiny HTTP shell exercises the real buildApiResponse guard without booting index.ts's
// unrelated daemons. Port 0 and a fresh HOME/data dir keep the owner's service/store untouched.
const HTTP_SCENARIO = `
import { mock } from 'bun:test'
import { runCooperatively } from './cooperative-work'
import { parseCodexRollout, parseCodexRolloutYielding } from './adapters/codex-parse'
const fixtureText = JSON.stringify({ type: 'session_meta', timestamp: '2026-01-01T10:00:00.000Z', payload: { id: 'fixture', timestamp: '2026-01-01T10:00:00.000Z', cwd: '' } })
const fixture = parseCodexRollout(fixtureText, 'fallback')
let builds = 0, released = false, complete = false
let signal!: () => void
const started = new Promise<void>(resolve => { signal = resolve })
const health = await import('./health')
mock.module('./health', () => ({ ...health, runHealthChecks: async () => [] }))
mock.module('./adapters/types', () => ({
  harnessEnabled: () => true,
  getEnabledAdapters: async () => [{
    id: 'codex', isAvailable: () => true, dataRoot: '/unused',
    loadSessions: async () => {
      builds++; signal()
      await runCooperatively((function* () {
        while (!released) {
          const until = performance.now() + 2
          while (performance.now() < until) { /* stub CPU-bound parsing */ }
          yield
        }
      })())
      return [await parseCodexRolloutYielding(fixtureText, 'fallback')]
    },
  }],
}))
const { buildApiResponse } = await import('./data')
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 10,
  async fetch(req) {
    if (new URL(req.url).pathname === '/api/health') return Response.json({ ok: true, complete })
    const result = await buildApiResponse()
    complete = true
    return Response.json(result)
  },
})
try {
  const pending = Array.from({ length: 8 }, () => fetch(new URL('/api/data', server.url)))
  await started
  const at = performance.now()
  const health = await fetch(new URL('/api/health', server.url), { signal: AbortSignal.timeout(1000) }).then(r => r.json())
  const healthMs = performance.now() - at
  released = true
  const payloads = await Promise.all(pending.map(async r => (await r).json()))
  const identical = payloads.every(p => JSON.stringify(p) === JSON.stringify(payloads[0]))
  console.log('RESULT ' + JSON.stringify({ health, healthMs, builds, identical, fixtureUnchanged: JSON.stringify(payloads[0].sessions) === JSON.stringify([fixture]), sessions: payloads[0].sessions }))
} finally { released = true; server.stop(true) }
process.exit(0)
`

test('health answers during a slow cold build; concurrent data requests share one identical payload', () => {
  const home = mkdtempSync(join(tmpdir(), 'agentistics-cold-start-'))
  try {
    const child = Bun.spawnSync([process.execPath, '-e', HTTP_SCENARIO], {
      cwd: import.meta.dir,
      env: { ...process.env, HOME: home, CLAUDE_DIR: join(home, '.claude'), AGENTISTICS_DIR: join(home, 'data'), AGENTISTICS_ARCHIVE: '0', AGENTISTICS_JOURNAL: '0', AGENTISTICS_ENGINE: '0', AGENTISTICS_PARSE_CACHE: '0', AGENTISTICS_TEAM_CENTRAL: '0', AGENTISTICS_TEAM: '0', AGENTISTICS_TELEMETRY: '0', PORT: '0', WEB_PORT: '0' },
      timeout: 15_000,
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(child.exitCode, child.stderr.toString()).toBe(0)
    const line = child.stdout.toString().split('\n').find(l => l.startsWith('RESULT '))
    expect(line, child.stdout.toString()).toBeDefined()
    const result = JSON.parse(line!.slice(7))
    expect(result.health).toEqual({ ok: true, complete: false })
    expect(result.healthMs).toBeLessThan(1000)
    expect(result.builds).toBe(1)
    expect(result.identical).toBe(true)
    expect(result.fixtureUnchanged).toBe(true)
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0].session_id).toBe('fixture')
  } finally { rmSync(home, { recursive: true, force: true }) }
}, 20_000)
