import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { gitTestEnv } from '../core/src/gitTestEnv'
import { createDeliveryService, type OwnerRequestFact } from '../server/server/delivery/service'
import { enableOwnerRequestFlows } from '../server/server/flows/owner-message'
import { createDeliveryStore } from '../server/server/delivery/store'
import { deliveryRequest } from '../server/server/delivery/web'
import { runningSessionIds, type GateFacts, type StagedFact } from '../server/server/delivery/gates'
import type { ManagedSession } from '../server/server/sessions/types'
import { sessionProofToken } from './session-proof'

test('MCP task_phase and task_stage use the shared gate, authenticated dequeue, tick and read rules', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-delivery-'))
  const key = new Uint8Array(32).fill(7)
  writeFileSync(join(dir, 'session-identity.key'), Buffer.from(key).toString('hex'))
  let status = 'todo', draft: StagedFact = {}
  let joined = false, groupDraft: StagedFact = {}
  let requests: OwnerRequestFact[] = []
  const enabled = new Set<string>(), wakes: string[] = []
  const flowCommand = { verb: 'flow' as const, summary: { en: '', pt: '' }, run: async (args: string[], io: { out(s: string): void }) => {
    if (args[0] === 'ls') for (const name of ['pedido-do-dono', 'encaixe-do-pedido']) io.out(`${name}\t${enabled.has(name) ? 'enabled' : 'disabled'}`)
    else enabled.add(args[1]!)
    return 0
  } }
  const comments: string[] = []
  const registry = Array.from({ length: 79 }, (_, i) => ({ id: `lost-${i}` })) as ManagedSession[]
  const running = runningSessionIds(registry, [])
  const facts: GateFacts = {
    subtask: async id => ['s1', 'g1'].includes(id) ? { id, taskId: 't1', title: id, status, groupMember: id === 's1' && joined, ...(id === 's1' && joined ? { parentGroupId: 'g1' } : {}), blockedBy: [], staged: id === 's1' ? draft : groupDraft } : null,
    sessions: async () => [
      { id: 'leader', harness: 'codex', cwd: dir, role: 'leader', alive: true, worktree: false, taskId: 't1' },
      ...registry.map(m => ({ id: m.id, harness: 'codex', cwd: dir, role: 'worker', alive: running.has(m.id), worktree: true })),
    ],
    budgets: async () => [{ harness: 'codex', account: 'default', fiveHourPct: 10, weekPct: 10, stale: false }],
    memoryBytes: async () => 8 * 1024 ** 3, topCap: async () => 1, git: async () => '', gh: async () => '',
  }
  const service = createDeliveryService({
    store: createDeliveryStore(join(dir, 'deliveries.json')), facts,
    board: {
      stage: async (id, input) => { if (id === 'g1') groupDraft = input; else draft = input; return { ok: true } },
      setPhaseStatus: async () => ({ ok: true }), setCi: async () => {}, logStep: async () => {},
      comment: async (_t, _s, body) => { comments.push(body) }, subtaskFinished: async () => false,
    },
    autonomous: async () => true, emit: async () => {}, now: Date.now,
    requests: async () => { await enableOwnerRequestFlows([flowCommand]); return requests },
    notify: { session: async (id, text) => { wakes.push(`${id}:${text}`); return true }, owner: async () => { throw new Error('must never ask owner') } },
  })
  const seen: Array<{ path: string; body: Record<string, unknown> }> = []
  const api = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/api/engine') return Response.json({ flowsExperimental: true, flows: true })
    const body = req.method === 'POST' ? await req.json() as Record<string, unknown> : {}
    seen.push({ path, body })
    if (path === '/api/tasks/t1/subtasks' && body.id === 's1' && body.parentGroupId === 'g1') {
      joined = true
      await service.foldGroupMember('s1')
      return Response.json({ ok: true })
    }
    const r = await deliveryRequest(req.method, path, body, { service, verify: async (id, token) =>
      id === 'leader' && token === sessionProofToken(key, 'leader') ? 'leader' : null })
    return Response.json(r.body, { status: r.status })
  } })
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, 'agentistics-mcp.ts')],
    env: { ...gitTestEnv(), HOME: dir, AGENTISTICS_DIR: dir, AGENTISTICS_API: `http://127.0.0.1:${api.port}`, AGENTOP_MANAGED_ID: 'leader' } as Record<string, string>, stderr: 'pipe' })
  const client = new Client({ name: 'delivery-test', version: '1.0' })
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    const phase = tools.tools.find(t => t.name === 'agentistics_task_phase')!
    expect((phase.inputSchema.properties!.action as { enum: string[] }).enum).toContain('dequeue')
    expect((phase.inputSchema.properties!.action as { enum: string[] }).enum).toContain('tick')
    const call = async (name: string, args: Record<string, unknown>) => {
      const out = await client.callTool({ name, arguments: args })
      const block = (out.content as Array<{ text: string }>)[0]!
      return { error: out.isError, body: JSON.parse(block.text) }
    }
    const stage = { subtaskId: 's1', prompt: 'surface: Live\nFix queue', harness: 'codex', model: 'gpt-6.1-sol', effort: 'high', account: 'default' }
    expect((await call('agentistics_task_stage', stage)).body.record.gates.vaga.ok).toBe(true)
    expect((await call('agentistics_task_phase', { subtaskId: 's1', action: 'gate', name: 'vaga' })).body.gate.ok).toBe(true)
    const removed = await call('agentistics_task_phase', { subtaskId: 's1', action: 'dequeue', reason: 'already delivered elsewhere' })
    expect(removed.body.record.dequeued).toMatchObject({ actor: 'leader', reason: 'already delivered elsewhere' })
    expect((await call('agentistics_task_phase', { subtaskId: 's1' })).body.record.dequeued.reason).toBe('already delivered elsewhere')
    expect(comments).toHaveLength(1)
    await call('agentistics_task_stage', stage)
    status = 'in_review'
    expect((await call('agentistics_task_phase', { action: 'tick' })).body.actions).toContain('dequeue s1')
    expect(comments).toHaveLength(2)
    expect(seen.find(x => x.body.action === 'dequeue')!.body.session).toEqual({ id: 'leader', token: sessionProofToken(key, 'leader') })
    expect([...enabled]).toEqual(['pedido-do-dono', 'encaixe-do-pedido'])
    requests = [{ id: 'p-1', taskId: 't1', sessionId: 'retired', text: 'Move history', at: new Date(Date.now() - 11 * 60_000).toISOString(), state: 'open', linkedSubtaskIds: [] }]
    expect((await call('agentistics_task_phase', { action: 'tick' })).body.actions).toContain('request-wake leader:p-1')
    expect(wakes[0]).toContain('p-1')
    status = 'todo'
    await call('agentistics_task_stage', stage)
    const group = await call('agentistics_task_stage', { ...stage, subtaskId: 'g1', prompt: 'surface: Live' })
    expect(group.body.ok).toBe(true)
    expect(group.body.warnings.join(' ')).toContain('encaixe: s1')
    expect((await call('agentistics_task_subtask', { ref: 't1', id: 's1', parentGroupId: 'g1' })).body.ok).toBe(true)
    expect((await call('agentistics_task_phase', { subtaskId: 's1' })).body.record.dequeued.reason).toContain('group g1')
    expect(groupDraft.prompt).toContain('[group member s1]')
  } finally { await client.close(); api.stop(true); rmSync(dir, { recursive: true, force: true }) }
}, 20_000)
