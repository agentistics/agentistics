import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { gitTestEnv } from '../core/src/gitTestEnv'

// `done` beside a named column used to be dropped with an ok answer (LIVE.REVISAO-MAC).
test('agentistics_task_subtask forwards done beside named columns and refuses a conflicting status', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-subtask-done-'))
  const seen: Array<Record<string, unknown>> = []
  let refuseDone = false
  const api = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/api/engine') return Response.json({})
    if (path === '/api/tasks/t1/subtasks') {
      const body = await req.json() as Record<string, unknown>
      seen.push(body)
      if (refuseDone && (body.status === 'done' || body.done === true)) return Response.json({ ok: false, message: 'done_needs_session' }, { status: 422 })
      return Response.json({ ok: true })
    }
    return Response.json({})
  } })
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, 'agentistics-mcp.ts')],
    env: { ...gitTestEnv(), HOME: dir, AGENTISTICS_DIR: dir, AGENTISTICS_API: `http://127.0.0.1:${api.port}` } as Record<string, string>, stderr: 'pipe' })
  const client = new Client({ name: 'subtask-done-test', version: '1.0' })
  const call = async (args: Record<string, unknown>) => {
    seen.length = 0
    const out = await client.callTool({ name: 'agentistics_task_subtask', arguments: { ref: 't1', ...args } })
    return { isError: out.isError === true, text: (out.content as Array<{ text: string }>)[0]!.text }
  }
  try {
    await client.connect(transport)
    // title + done persists the close in the same edit
    expect((await call({ id: 's1', title: 'New', done: true })).isError).toBe(false)
    expect(seen).toEqual([{ id: 's1', title: 'New', status: 'done' }])
    // conflicting status is an error and writes nothing
    const conflict = await call({ id: 's1', status: 'in_review', done: true })
    expect(conflict.isError).toBe(true)
    expect(seen).toEqual([])
    // done + status done is one write
    expect((await call({ id: 's1', status: 'done', done: true })).isError).toBe(false)
    expect(seen).toEqual([{ id: 's1', status: 'done' }])
    // join then close, in order
    expect((await call({ id: 's1', parentGroupId: 'g1', done: true })).isError).toBe(false)
    expect(seen).toEqual([{ id: 's1', parentGroupId: 'g1' }, { id: 's1', status: 'done' }])
    // bare tick unchanged
    await call({ id: 's1', done: true })
    expect(seen).toEqual([{ id: 's1', done: true }])
    // done=false with a non-done status is a reopen into that status, not a conflict.
    expect((await call({ id: 's1', status: 'in_review', done: false })).isError).toBe(false)
    expect(seen).toEqual([{ id: 's1', status: 'in_review' }])
    expect((await call({ id: 's1', status: 'done', done: false })).isError).toBe(true)
    expect(seen).toEqual([])
    // done_needs_session still surfaces as an error
    refuseDone = true
    const refused = await call({ id: 's1', title: 'X', done: true })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('done_needs_session')
  } finally { await client.close(); api.stop(true); rmSync(dir, { recursive: true, force: true }) }
}, 20_000)
