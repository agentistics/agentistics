import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { gitTestEnv } from '../core/src/gitTestEnv'

// B4 r2: `agentistics_task_subtask` with `dismissPlaceholder: true` + `id` is the placeholder-only door (never a general remove).
test('agentistics_task_subtask dismissPlaceholder sends exactly {id, dismissPlaceholder} and surfaces a refusal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-subtask-dismiss-'))
  const seen: Array<Record<string, unknown>> = []
  const api = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/api/engine') return Response.json({})
    if (path === '/api/tasks/t1/subtasks') {
      const body = await req.json() as Record<string, unknown>
      seen.push(body)
      return body.id === 'real' ? Response.json({ ok: false, reason: 'not_a_placeholder', message: 'not a placeholder' }, { status: 422 }) : Response.json({ ok: true })
    }
    return Response.json({})
  } })
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, 'agentistics-mcp.ts')],
    env: { ...gitTestEnv(), HOME: dir, AGENTISTICS_DIR: dir, AGENTISTICS_API: `http://127.0.0.1:${api.port}` } as Record<string, string>, stderr: 'pipe' })
  const client = new Client({ name: 'subtask-dismiss-test', version: '1.0' })
  const call = async (args: Record<string, unknown>) => {
    seen.length = 0
    const out = await client.callTool({ name: 'agentistics_task_subtask', arguments: { ref: 't1', ...args } })
    return (out.content as Array<{ text: string }>)[0]!.text
  }
  try {
    await client.connect(transport)
    expect(JSON.parse(await call({ id: 'ph', dismissPlaceholder: true })).ok).toBe(true)
    expect(seen).toEqual([{ id: 'ph', dismissPlaceholder: true }])
    expect(await call({ id: 'real', dismissPlaceholder: true, title: 'x', done: true })).toContain('not_a_placeholder')
    expect(seen).toEqual([{ id: 'real', dismissPlaceholder: true }])
  } finally { await client.close(); api.stop(true) }
})
