import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { gitTestEnv } from '../core/src/gitTestEnv'
import { evidenceRequest } from '../server/server/delivery/evidence-web'
import { forgetClassifyCache } from '../server/server/delivery/classify-host'
import { sha256Hex } from '../server/server/delivery/evidence'
import { makeWorld, png } from '../server/server/delivery/evidence-world.testing'
import { sessionProofToken } from './session-proof'

/**
 * S1c — the MCP door, through a REAL stdio client calling the real tool, which reaches a fake API through the real `apiSend`
 * and lands in the real delivery service (real git, real deliveries.json). The tool supplies WHAT and the session proof;
 * everything else is the server's.
 */
let dir: string, api: ReturnType<typeof Bun.serve>, client: Client
const seen: Array<{ method: string; path: string; body: Record<string, unknown> }> = []
const key = new Uint8Array(32).fill(9)

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-evidence-'))
  forgetClassifyCache()
  writeFileSync(join(dir, 'session-identity.key'), Buffer.from(key).toString('hex'))
  const { svc } = makeWorld(dir)
  api = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const url = new URL(req.url)
    const m = /^\/api\/tasks\/([^/]+)\/evidence$/.exec(url.pathname)
    if (!m) return Response.json({ error: 'not_found' }, { status: 404 })
    const body = req.method === 'GET' ? {} : await req.json().catch(() => ({})) as Record<string, unknown>
    seen.push({ method: req.method, path: url.pathname + url.search, body })
    const r = await evidenceRequest(req.method, decodeURIComponent(m[1]!), Object.fromEntries(url.searchParams), body, {
      service: svc, verify: async (id, token) => (id === 'worker' && token === sessionProofToken(key, 'worker') ? 'worker' : id === 'worker2' && token === sessionProofToken(key, 'worker2') ? 'worker2' : null),
    })
    return Response.json(r.body, { status: r.status })
  } })
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, 'agentistics-mcp.ts')],
    env: { ...gitTestEnv(), HOME: dir, AGENTISTICS_DIR: dir, AGENTISTICS_API: `http://127.0.0.1:${api.port}`, AGENTOP_MANAGED_ID: 'worker' } as Record<string, string>, stderr: 'pipe' })
  client = new Client({ name: 'evidence-test', version: '1.0' })
  await client.connect(transport)
}, 30_000)
afterAll(async () => { await client?.close(); api?.stop(true); rmSync(dir, { recursive: true, force: true }) })

const call = async (args: Record<string, unknown>) => {
  const out = await client.callTool({ name: 'agentistics_task_evidence', arguments: args })
  const text = (out.content as Array<{ text: string }>)[0]!.text
  let body: any = text; try { body = JSON.parse(text) } catch { /* an error sentence */ }
  return { isError: out.isError === true, body, text }
}

describe('agentistics_task_evidence', () => {
  test('the tool is listed, in the schema the briefing describes', async () => {
    const tool = (await client.listTools()).tools.find(t => t.name === 'agentistics_task_evidence')!
    expect(tool).toBeTruthy()
    expect((tool.inputSchema.properties!.action as { enum: string[] }).enum).toEqual(['add', 'list', 'remove'])
    expect(Object.keys(tool.inputSchema.properties!)).not.toContain('sha256')   // a caller cannot even name a hash
  })

  test('add filePath → uploaded as bytes with the SESSION PROOF; the item carries the server\'s hash and the verified identity', async () => {
    const f = join(dir, 'desk.png'); const bytes = png(1280, 800, 90); writeFileSync(f, bytes)
    const r = await call({ ref: 't1', subtaskId: 'p1', kind: 'screenshot', filePath: f, sha256: 'forged', headSha: 'x' })
    expect(r.isError).toBe(false)
    expect(r.body.evidence).toMatchObject({ kind: 'screenshot', by: 'worker', sha256: sha256Hex(bytes), width: 1280 })
    const sent = seen.at(-1)!
    expect(sent.method).toBe('POST'); expect(sent.path).toBe('/api/tasks/t1/evidence')
    expect(sent.body.session).toEqual({ id: 'worker', token: sessionProofToken(key, 'worker') })
    expect(sent.body.bytesBase64).toBe(Buffer.from(bytes).toString('base64')); expect(sent.body.name).toBe('desk.png')
    expect(sent.body).not.toHaveProperty('sha256'); expect(sent.body).not.toHaveProperty('headSha')   // never forwarded
  })

  test('list and remove go through GET / DELETE with the proof', async () => {
    const listed = await call({ ref: 't1', subtaskId: 'p1', action: 'list' })
    expect(listed.body.evidence.length).toBeGreaterThanOrEqual(1); expect(listed.body.binding).toHaveProperty('headSha')
    expect(seen.at(-1)).toMatchObject({ method: 'GET', path: '/api/tasks/t1/evidence?subtaskId=p1' })
    const id = listed.body.evidence[0].id
    const removed = await call({ ref: 't1', subtaskId: 'p1', action: 'remove', evidenceId: id })
    expect(removed.isError).toBe(false)
    expect(seen.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/tasks/t1/evidence', body: { evidenceId: id, session: { id: 'worker' } } })
  })

  test('a refusal reaches the caller as an error carrying the server\'s own code (reuse across pieces → evidence_reused)', async () => {
    const f = join(dir, 'shared.png'); writeFileSync(f, png(1280, 800, 91))
    expect((await call({ ref: 't1', subtaskId: 'p1', kind: 'screenshot', filePath: f })).isError).toBe(false)
    // the same bytes on the OTHER piece, attached by that piece's own session
    const sent = seen.at(-1)!
    const r = await fetch(`http://127.0.0.1:${api.port}/api/tasks/t1/evidence`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...sent.body, subtaskId: 'p2', session: { id: 'worker2', token: sessionProofToken(key, 'worker2') } }) })
    expect(r.status).toBe(409); expect(await r.json()).toMatchObject({ error: 'evidence_reused' })
    const bad = await call({ ref: 't1', subtaskId: 'p1', kind: 'screenshot', filePath: (() => { const g = join(dir, 'tiny.png'); writeFileSync(g, png(1, 1)); return g })() })
    expect(bad.isError).toBe(true); expect(bad.text).toContain('evidence_invalid')
  })

  test('an oversize file is refused BEFORE it is read and before any request is made', async () => {
    const big = join(dir, 'big.bin'); writeFileSync(big, Buffer.alloc(8 * 1024 * 1024 + 1))
    const before = seen.length
    const r = await call({ ref: 't1', subtaskId: 'p1', kind: 'screenshot', filePath: big })
    expect(r.isError).toBe(true); expect(r.text).toMatch(/8 MB/); expect(seen.length).toBe(before)
  })

  test('argument errors make no request: two payloads, no payload, no kind, no ref, remove without id', async () => {
    const before = seen.length
    for (const args of [
      { ref: 't1', kind: 'screenshot', filePath: '/x', fileId: 'y' }, { ref: 't1', kind: 'screenshot' }, { ref: 't1', filePath: '/x' }, { kind: 'screenshot', fileId: 'y' }, { ref: 't1', action: 'remove' },
    ]) expect((await call(args)).isError, JSON.stringify(args)).toBe(true)
    expect(seen.length).toBe(before)
  })

  test('probes and file ids travel as named; a probe with an extra field is refused by the server', async () => {
    expect((await call({ ref: 't1', subtaskId: 'p1', kind: 'probe', probe: { kind: 'bundle', literal: 'a-literal-of-12+' } })).isError).toBe(false)
    const extra = await call({ ref: 't1', subtaskId: 'p1', kind: 'probe', probe: { kind: 'bundle', literal: 'another-literal-12', sneaky: true } })
    expect(extra.isError).toBe(true); expect(extra.text).toContain('probe-extra-field')
  })
})
