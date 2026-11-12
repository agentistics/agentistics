import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { gitTestEnv } from '../core/src/gitTestEnv'
import { sessionProofToken } from './session-proof'

/**
 * The real MCP process, a fake API: whatever arguments the model sends, the body that reaches
 * `POST /api/book/takeover` carries THIS session's own proof and never a forged `session`/`sessionId`.
 */
test('agentistics_book_takeover posts the caller\'s own proof, ignoring forged session arguments, and passes a 409 challenge through', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-book-takeover-'))
  const key = new Uint8Array(32).fill(7)
  writeFileSync(join(dir, 'session-identity.key'), Buffer.from(key).toString('hex'))
  const seen: Array<Record<string, any>> = []
  const api = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== '/api/book/takeover') return new Response('nope', { status: 404 })
      seen.push(await req.json() as Record<string, any>)
      return seen.length === 1
        ? Response.json({ ok: false, challenge: true, lastDeltaHash: 'delta-1' }, { status: 409 })
        : Response.json({ ok: true, phase: 'confirmed' })
    },
  })
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(import.meta.dir, 'agentistics-mcp.ts')],
    env: { ...gitTestEnv(), HOME: dir, AGENTISTICS_DIR: dir, AGENTISTICS_API: `http://127.0.0.1:${api.port}`, AGENTOP_MANAGED_ID: 'successor-1' } as Record<string, string>,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'book-takeover-test', version: '1.0' })
  try {
    await client.connect(transport)
    expect((await client.listTools()).tools.map(t => t.name)).toContain('agentistics_book_takeover')
    const forged = { id: 'old-leader', token: 'forged' }
    const first = await client.callTool({ name: 'agentistics_book_takeover', arguments: { taskId: 't-1', bookmarkHash: 'bm-1', session: forged, sessionId: 'old-leader' } })
    expect(first.isError).not.toBe(true)
    expect(JSON.parse((first.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ challenge: true, lastDeltaHash: 'delta-1' })
    const second = await client.callTool({ name: 'agentistics_book_takeover', arguments: { taskId: 't-1', bookmarkHash: 'bm-1', lastDeltaHash: 'delta-1', session: forged } })
    expect(JSON.parse((second.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ ok: true, phase: 'confirmed' })

    const own = { id: 'successor-1', token: sessionProofToken(key, 'successor-1') }
    expect(seen).toHaveLength(2)
    for (const body of seen) {
      expect(body.session).toEqual(own)
      expect(body.sessionId).toBeUndefined()
    }
    expect(seen[1]!.lastDeltaHash).toBe('delta-1')
  } finally {
    await client.close().catch(() => {})
    api.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)
