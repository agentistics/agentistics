/**
 * ENTREGA.GARANTIDA S0d.5 (QA F5) — EVERY MCP task write reaches the server carrying this pane's session proof.
 * The QA's mutants survived the old suite: M1 (proof injection removed from `apiSend`), M2 (`task_claim` sending
 * `session: null`) and M10 (`task_delete` sends no body, so no proof). This drives each write tool through the REAL
 * MCP process against a fake API and asserts the proof on every non-GET `/api/tasks*` request it makes.
 */
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { gitTestEnv } from '../core/src/gitTestEnv'
import { sessionProofToken, withTaskWriteProof } from './session-proof'

const ID = 's-proof-test'
const KEY = Buffer.alloc(32, 9) // a throwaway test key, not a credential
const WANT = { id: ID, token: sessionProofToken(KEY, ID) }

/** Every board-writing tool, with arguments that make it write. Several tools have more than one write path. */
const CALLS: Array<[string, Record<string, unknown>]> = [
  ['agentistics_task_create', { title: 'T' }],
  ['agentistics_task_status', { ref: 't1', status: 'in_progress' }],
  ['agentistics_task_status_edit', { label: 'X', color: '#000000' }],
  ['agentistics_task_status_edit', { id: 'x', label: 'Y' }],
  ['agentistics_task_status_edit', { id: 'x', remove: true }],
  ['agentistics_task_type_edit', { label: 'X' }],
  ['agentistics_task_type_edit', { id: 'x', label: 'Y' }],
  ['agentistics_task_type_edit', { id: 'x', remove: true }],
  ['agentistics_task_comment', { ref: 't1', body: 'hi', author: 'w' }],
  ['agentistics_task_subtask', { ref: 't1', title: 'S' }],
  ['agentistics_task_subtask', { ref: 't1', id: 's1', done: true }],
  ['agentistics_task_subtask', { ref: 't1', id: 's1', parentGroupId: 'g1', done: true }],
  ['agentistics_task_link', { ref: 't1', url: 'https://example.invalid', label: 'l' }],
  ['agentistics_task_blocked_by', { ref: 't1', blockedBy: [] }],
  ['agentistics_task_claim', { ref: 't1', by: 'me' }],
  ['agentistics_task_claim', { ref: 't1', by: 'me', release: true }],
  ['agentistics_task_edit', { ref: 't1', title: 'New' }],
  ['agentistics_task_session', { ref: 't1', sessionId: 'x' }],
  ['agentistics_task_session', { detach: 'x' }],
  ['agentistics_task_delete', { ref: 't1' }],
]

test('withTaskWriteProof: a bodiless task write carries the proof as its body; reads and other routes are untouched', () => {
  expect(withTaskWriteProof('DELETE', '/api/tasks/t1', undefined, WANT)).toEqual({ session: WANT })
  expect(withTaskWriteProof('POST', '/api/tasks/t1/claim', { by: 'me' }, WANT)).toEqual({ by: 'me', session: WANT })
  expect(withTaskWriteProof('GET', '/api/tasks/t1', undefined, WANT)).toBeUndefined()
  expect(withTaskWriteProof('DELETE', '/api/session-groups/g', undefined, WANT)).toBeUndefined()
  expect(withTaskWriteProof('DELETE', '/api/tasks/t1', undefined, undefined)).toBeUndefined()
})

test('every MCP task-write tool sends this session\'s proof on every write request (kills M1, M2, M10)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-write-proof-'))
  writeFileSync(join(dir, 'session-identity.key'), KEY.toString('hex'), { mode: 0o600 })
  const writes: Array<{ tool: string; method: string; path: string; body: unknown }> = []
  let current = ''
  const api = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname
    if (req.method !== 'GET' && path.startsWith('/api/tasks')) {
      const text = await req.text()
      writes.push({ tool: current, method: req.method, path, body: text ? JSON.parse(text) : undefined })
    }
    return Response.json({ ok: true })
  } })
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, 'agentistics-mcp.ts')],
    env: { ...gitTestEnv(), HOME: dir, AGENTISTICS_DIR: dir, AGENTOP_MANAGED_ID: ID, AGENTISTICS_API: `http://127.0.0.1:${api.port}` } as Record<string, string>, stderr: 'pipe' })
  const client = new Client({ name: 'write-proof-test', version: '1.0' })
  try {
    await client.connect(transport)
    for (const [name, args] of CALLS) {
      current = name
      const before = writes.length
      const out = await client.callTool({ name, arguments: args })
      expect(out.isError === true, `${name} failed: ${JSON.stringify(out.content)}`).toBe(false)
      expect(writes.length, `${name} made no write request`).toBeGreaterThan(before)
    }
    for (const w of writes) expect((w.body as { session?: unknown } | undefined)?.session, `${w.tool}: ${w.method} ${w.path}`).toEqual(WANT)
    // every tool on the S1c allowlist (UNPROVEN_UNTIL_S0A) is covered here
    for (const t of ['agentistics_task_create', 'agentistics_task_status', 'agentistics_task_status_edit', 'agentistics_task_type_edit', 'agentistics_task_subtask',
      'agentistics_task_link', 'agentistics_task_blocked_by', 'agentistics_task_claim', 'agentistics_task_edit', 'agentistics_task_session', 'agentistics_task_delete']) {
      expect(writes.some(w => w.tool === t), t).toBe(true)
    }
  } finally { await client.close(); api.stop(true); rmSync(dir, { recursive: true, force: true }) }
}, 30_000)
