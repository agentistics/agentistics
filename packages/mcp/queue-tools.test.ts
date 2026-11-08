import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { gitTestEnv } from '../core/src/gitTestEnv'
import { createDeliveryService } from '../server/server/delivery/service'
import { createDeliveryStore } from '../server/server/delivery/store'
import { deliveryRequest } from '../server/server/delivery/web'
import type { GateFacts, SessionFact } from '../server/server/delivery/gates'
import { sessionProofToken } from './session-proof'

test('MCP agentistics_task_queue reads the queue the Fila tab reads, and agentistics_task_queue_answer drives the same flow (sim | nao | agendar)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-queue-'))
  const key = new Uint8Array(32).fill(9)
  writeFileSync(join(dir, 'session-identity.key'), Buffer.from(key).toString('hex'))
  const priorities: Record<string, string> = { s1: 'low', s2: 'urgent', s3: 'medium' }
  const told: Array<{ id: string; text: string }> = [], spawned: string[] = [], comments: string[] = []
  const sessions: SessionFact[] = [{ id: 'leader', harness: 'claude', cwd: dir, role: 'leader', alive: true, worktree: false, taskId: 't1' }]
  const facts: GateFacts = {
    subtask: async id => (priorities[id] ? { id, taskId: 't1', title: `Peça ${id}`, status: 'todo', groupMember: false, blockedBy: [], priority: priorities[id]!, staged: { prompt: `brief ${id}`, harness: 'claude', model: 'claude-sonnet-5-5', effort: 'high', account: 'acc_1', cwd: dir } } : null),
    sessions: async () => sessions,
    budgets: async () => [{ harness: 'claude', account: 'acc_1', fiveHourPct: 10, weekPct: 10, stale: false }],
    memoryBytes: async () => 8 * 1024 ** 3, topCap: async () => 9, git: async () => '', gh: async () => '',
    queueExtras: async id => ({ taskTitle: 'Tarefa', members: [], notes: { total: 1, last: [{ author: 'ana', at: '2026-11-07T10:00:00Z', body: `nota de ${id}` }] } }),
  }
  const service = createDeliveryService({
    store: createDeliveryStore(join(dir, 'deliveries.json')), facts,
    board: {
      stage: async () => ({ ok: true }), setPhaseStatus: async () => ({ ok: true }), setCi: async () => {}, logStep: async () => {},
      comment: async (_t, s, body) => { comments.push(`${s}: ${body}`) }, subtaskFinished: async () => false,
    },
    autonomous: async () => false, emit: async () => {}, now: Date.now,
    spawn: async r => { spawned.push(r.subtaskId); return { ok: true, sessionId: `new-${r.subtaskId}` } },
    notify: { session: async (id, text) => { told.push({ id, text }); return true }, owner: async () => { throw new Error('must never ask owner') } },
  })
  const api = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname
    const body = req.method === 'POST' ? await req.json() as Record<string, unknown> : {}
    const r = await deliveryRequest(req.method, path, body, { service, verify: async (id, token) => (id === 'leader' && token === sessionProofToken(key, 'leader') ? 'leader' : null) })
    return Response.json(r.body, { status: r.status })
  } })
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, 'agentistics-mcp.ts')],
    env: { ...gitTestEnv(), HOME: dir, AGENTISTICS_DIR: dir, AGENTISTICS_API: `http://127.0.0.1:${api.port}`, AGENTOP_MANAGED_ID: 'leader' } as Record<string, string>, stderr: 'pipe' })
  const client = new Client({ name: 'queue-test', version: '1.0' })
  try {
    await client.connect(transport)
    const names = (await client.listTools()).tools.map(t => t.name)
    expect(names).toContain('agentistics_task_queue')
    expect(names).toContain('agentistics_task_queue_answer')
    const call = async (name: string, args: Record<string, unknown>) => {
      const out = await client.callTool({ name, arguments: args })
      const block = (out.content as Array<{ text: string }>)[0]!
      let body: any = null
      try { body = JSON.parse(block.text) } catch { body = block.text }
      return { error: out.isError === true, body }
    }
    for (const id of ['s1', 's2', 's3']) await service.ensure(id, { leaderSessionId: 'leader' })

    // READ: the order is the leaving order (priority), with everything the tab shows.
    const all = await call('agentistics_task_queue', {})
    expect(all.body.items.map((i: { subtaskId: string }) => i.subtaskId)).toEqual(['s2', 's3', 's1'])
    const one = await call('agentistics_task_queue', { taskId: 't1' })
    expect(one.body.items[0]).toMatchObject({ subtaskId: 's2', priority: 'urgent', position: 1, taskTitle: 'Tarefa' })
    expect(one.body.items[0].predispatch).toMatchObject({ harness: 'claude', model: 'claude-sonnet-5-5', prompt: 'brief s2' })
    expect(one.body.items[0].notes.last[0].body).toBe('nota de s2')
    expect((await call('agentistics_task_queue', { taskId: 'nope' })).body.items).toEqual([])

    // RUN: the flow asks the leader about the first one.
    const run = await call('agentistics_task_queue_answer', { runNow: true })
    expect(run.body.actions.some((a: string) => a.startsWith('fila-pergunta s2'))).toBe(true)
    expect(told).toHaveLength(1)
    expect(told[0]!.text).toContain('[from flow fila · confirmar]')
    expect((await call('agentistics_task_queue', {})).body.items[0].ask).toMatchObject({ delivered: true, approved: false, onTimeout: 'esperar' })

    // ANSWER nao / agendar / invalid
    const refused = await call('agentistics_task_queue_answer', { subtaskId: 's2', answer: 'nao' })
    expect(refused.error).toBe(true)
    expect(String(refused.body)).toContain('resposta_invalida')
    const nao = await call('agentistics_task_queue_answer', { subtaskId: 's2', answer: 'nao depois do release' })
    expect(nao.body.record.queueHold).toMatchObject({ kind: 'nao', reason: 'depois do release', actor: 'leader' })
    const until = new Date(Date.now() + 3 * 3600_000).toISOString()
    const ag = await call('agentistics_task_queue_answer', { subtaskId: 's3', answer: `agendar ${until} depois da reunião` })
    expect(ag.body.record.queueHold).toMatchObject({ kind: 'agendar', until })
    const past = await call('agentistics_task_queue_answer', { subtaskId: 's1', answer: `agendar ${new Date(Date.now() - 1000).toISOString()} x` })
    expect(past.error).toBe(true)
    expect(String(past.body)).toContain('resposta_invalida')
    const view = (await call('agentistics_task_queue', {})).body.items
    expect(view.find((i: { subtaskId: string }) => i.subtaskId === 's2').hold).toMatchObject({ kind: 'nao', active: true })
    expect(view.find((i: { subtaskId: string }) => i.subtaskId === 's3').hold).toMatchObject({ kind: 'agendar', active: true, until })
    expect(comments.some(c => c.startsWith('s2:') && c.includes('depois do release') && c.includes('leader'))).toBe(true)

    // ANSWER sim: opens the session once, even asked twice.
    expect((await call('agentistics_task_queue_answer', { subtaskId: 's1', answer: 'sim' })).body.record.phase).toBe('executando')
    expect((await call('agentistics_task_queue_answer', { subtaskId: 's1', answer: 'sim' })).body.ok).toBe(true)
    expect(spawned).toEqual(['s1'])
    expect((await call('agentistics_task_queue', {})).body.recent[0]).toMatchObject({ subtaskId: 's1', sessionId: 'new-s1' })
    expect((await call('agentistics_task_queue_answer', { subtaskId: 's1' })).error).toBe(true)
  } finally { await client.close(); api.stop(true); rmSync(dir, { recursive: true, force: true }) }
}, 30_000)
