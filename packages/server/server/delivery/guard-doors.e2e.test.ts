/**
 * S2a — spec §3.5 items 1–7 and 20, THROUGH THE DOORS (a real `index.ts` server on an ephemeral port, the real MCP stdio server
 * and a real MCP client, the real `agentop task` CLI entry, real git, real tasks.json / deliveries.json / guards.json), plus the
 * rule-OFF proof per door (the guarantee is `off` by default and nothing a user does today may change).
 *
 * Setup for every negative: the board has every semantic status seeded (`in_review`, `pr_merge`, `ci`, `done`, and the custom
 * "Review ready" / "Shipped"), the piece has a filed session with a resolvable CLEAN checkout whose diff touches
 * `packages/web`, all other gates satisfied — so the ONLY missing thing is the evidence. Each negative asserts the exact code
 * AND that tasks.json and deliveries.json are byte-identical after the attempt.
 *
 * Pieces: p1 (REST positive), p2 (MCP positive), p3 (handback positive), p4 (flow gate); t2 is a TASK-level piece (no subtasks)
 * for the status doors (a task with subtasks is not a piece).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { gitTestEnv } from '../../../core/src/gitTestEnv'
import { createGuaranteesStore, type ActivationFacts } from './activation'
import { execGit, forgetClassifyCache } from './classify-host'
import { createGuardsStore } from './guards-store'
import { gitSync } from './git-fixture.testing'
import { T, makeWorld, shot } from './evidence-world.testing'
import { createTaskStore } from '../sessions/task-store'
import { createSessionRegistry } from '../sessions/registry'
import { unattributedContext } from './guard'

const SERVER_ROOT = join(import.meta.dir, '..', '..')
const ISO = '2026-11-13T09:00:00.000Z'
const def = (id: string, label: string, stage: string, order: number, prot = false) => ({ id, label, color: '#112233', protected: prot, order, stage }) as never
const DEFS = [
  def('todo', 'To do', 'queue', 0, true), def('in_progress', 'In progress', 'running', 1, true), def('blocked', 'Blocked', 'blocked', 2, true), def('done', 'Done', 'published', 3, true),
  def('in_review', 'In review', 'leader', 4), def('pr_merge', 'PR merge', 'merge', 5), def('ci', 'CI', 'ci', 6),
  def('review_ready', 'Review ready', 'leader', 7), def('shipped', 'Shipped', 'published', 8),
]

interface Env { root: string; base: string; world: ReturnType<typeof makeWorld>; proc: ReturnType<typeof Bun.spawn>; client: Client; stop: () => Promise<void> }

const sub = (id: string) => ({ id, taskId: 't1', title: id, done: false, status: 'in_progress', createdAt: ISO, updatedAt: ISO }) as never
const bytes = (root: string) => ({ tasks: readFileSync(join(root, 'tasks.json'), 'utf8'), deliveries: existsSync(join(root, 'deliveries.json')) ? readFileSync(join(root, 'deliveries.json'), 'utf8') : '' })

async function activate(root: string, rule: 'on' | 'off'): Promise<void> {
  if (rule === 'off') return
  const g = createGuaranteesStore(join(root, 'guarantees.json'))
  const check = async () => ({ ok: true as const, via: 'legacy-browser' as const })
  const facts = (now: string): ActivationFacts => ({ now, build: 'test', capabilities: ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'], migrated: ['a'], unexplainedWouldRefuse: 0 })
  expect(await g.setState('a', 'shadow', { check, facts: facts(new Date(T - 25 * 3600_000).toISOString()) })).toEqual({ ok: true })
  expect(await g.setState('a', 'on', { check, facts: facts(new Date(T).toISOString()) })).toEqual({ ok: true })
}

async function boot(rule: 'on' | 'off'): Promise<Env> {
  const root = mkdtempSync(join(tmpdir(), 'guard-doors-'))
  forgetClassifyCache()
  const world = makeWorld(root)
  const deps = { sessions: async () => world.sessions, git: execGit }
  const tasks = createTaskStore(join(root, 'tasks.json'), { guard: { deps, now: () => T } })
  await tasks.seedStatuses(DEFS)
  await tasks.upsertTask({ id: 't1', title: 't1', status: 'in_progress', createdAt: ISO, updatedAt: ISO } as never, unattributedContext())
  await tasks.upsertTask({ id: 't2', title: 't2', status: 'in_progress', createdAt: ISO, updatedAt: ISO } as never, unattributedContext())
  for (const id of ['p1', 'p2', 'p3', 'p4']) await tasks.upsertSubtask(sub(id), unattributedContext())
  // the registry the SERVER's guard reads its checkouts from: one session per piece, filed in the repository
  const registry = createSessionRegistry(join(root, 'managed-sessions.json'))
  for (const [id, taskId, subtaskId] of [['worker', 't1', 'p1'], ['worker2', 't1', 'p2'], ['worker3', 't1', 'p3'], ['worker4', 't1', 'p4'], ['worker-t2', 't2', undefined]] as const) {
    await registry.add({ id, harness: 'claude', cwd: world.repo, createdAt: ISO, taskId, ...(subtaskId ? { subtaskId } : {}) } as never)
  }
  await activate(root, rule)

  const reservation = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = reservation.port!
  reservation.stop(true)
  const env = { ...gitTestEnv(), HOME: root, AGENTISTICS_DIR: root, PORT: String(port), SERVE_STATIC: '0', AGENTISTICS_TELEMETRY: '0', NODE_ENV: 'test' } as Record<string, string>
  const proc = Bun.spawn([process.execPath, join(SERVER_ROOT, 'server', 'index.ts')], { env, stdout: 'ignore', stderr: 'pipe' })
  const errors = new Response(proc.stderr).text()
  const base = `http://127.0.0.1:${port}`
  let ready = false
  for (let i = 0; i < 400 && !ready; i++) {
    try { ready = (await fetch(`${base}/api/tasks/statuses`)).ok } catch { /* booting */ }
    if (proc.exitCode !== null) throw new Error(await errors)
    if (!ready) await Bun.sleep(50)
  }
  expect(ready).toBe(true)
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(SERVER_ROOT, '..', 'mcp', 'agentistics-mcp.ts')], env: { ...env, AGENTISTICS_API: base } as Record<string, string>, stderr: 'pipe' })
  const client = new Client({ name: 'guard-doors', version: '1.0' })
  await client.connect(transport)
  return { root, base, world, proc, client, stop: async () => { await client.close().catch(() => undefined); proc.kill(); await proc.exited; await errors.catch(() => ''); rmSync(root, { recursive: true, force: true }) } }
}

const post = (e: Env, path: string, body: unknown) => fetch(`${e.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) as any }))
const mcp = async (e: Env, name: string, args: Record<string, unknown>) => {
  const r = await e.client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text: string }> }
  return { isError: r.isError === true, text: r.content.map(c => c.text).join('\n') }
}
const cli = async (e: Env, ...argv: string[]) => {
  const p = Bun.spawn([process.execPath, join(SERVER_ROOT, 'bin', 'cli.ts'), ...argv], { env: { ...gitTestEnv(), HOME: e.root, AGENTISTICS_DIR: e.root, AGENTISTICS_API: e.base, PORT: new URL(e.base).port, NODE_ENV: 'test' } as Record<string, string>, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out, err }
}
async function attachAll(e: Env, id: string, as: string) {
  const n = Number(id.slice(1)) * 100 // unique bytes per piece: evidence is unique per piece and revision
  for (const input of [shot(1280, n + 1), shot(390, n + 2), { kind: 'probe', probe: { kind: 'bundle', literal: `a-literal-of-12+-${id}` } }]) {
    const r = await e.world.svc.evidenceAdd(id, input as never, as)
    expect(r.ok, JSON.stringify(r)).toBe(true)
  }
}
const checkpoints = async (e: Env) => (await createGuardsStore(join(e.root, 'guards.json')).read()).checkpoints
const REFUSED = /evidence_required/
const SENTENCE = /cannot move to review yet|needs a|screenshot/

describe('rule ON — the negatives (the only thing missing is the evidence)', () => {
  let e: Env
  beforeAll(async () => { e = await boot('on') }, 90_000)
  afterAll(async () => { await e?.stop() })

  test('O1 REST: completing group members cannot publish the derived group without judgement', async () => {
    // The r4 Opus REST attack: members have no sessions and are individually exempt from done_needs_session.
    const group = await post(e, '/api/tasks/t1/subtasks', { title: 'group', isGroup: true })
    expect(group.status).toBe(200)
    const members: string[] = []
    for (const title of ['m1', 'm2']) {
      const member = await post(e, '/api/tasks/t1/subtasks', { title })
      expect(member.status).toBe(200)
      members.push(member.body.id)
      expect((await post(e, '/api/tasks/t1/subtasks', { id: member.body.id, parentGroupId: group.body.id })).status).toBe(200)
    }
    expect((await post(e, '/api/tasks/t1/subtasks', { id: members[0], status: 'done' })).status).toBe(200)
    const before = bytes(e.root)
    const attack = await post(e, '/api/tasks/t1/subtasks', { id: members[1], status: 'done' })
    expect(attack.status).toBe(422)
    expect(attack.body.guard).toMatchObject({ code: 'classification_required', piece: group.body.id })
    expect(attack.body.guard.message.length).toBeGreaterThan(0)
    expect(attack.body.guard.messagePt.length).toBeGreaterThan(0)
    expect(bytes(e.root)).toEqual(before)
    const detail = await fetch(`${e.base}/api/tasks/t1`).then(r => r.json()) as any
    expect(detail.task.subtasks.find((s: any) => s.id === group.body.id).status).not.toBe('done')
    expect((await checkpoints(e))[group.body.id]).toBeUndefined()
  })

  test('§3.5.1 MCP agentistics_task_status {status: in_review} → refused evidence_required, the guard\'s sentence, nothing written', async () => {
    const before = bytes(e.root)
    const r = await mcp(e, 'agentistics_task_status', { ref: 't2', status: 'in_review' })
    expect(r.isError).toBe(true); expect(r.text).toMatch(REFUSED); expect(r.text).toMatch(SENTENCE)
    expect(bytes(e.root)).toEqual(before)
  })

  test('§3.5.2 MCP agentistics_task_subtask edit {status: in_review} → refused', async () => {
    const before = bytes(e.root)
    const r = await mcp(e, 'agentistics_task_subtask', { ref: 't1', id: 'p1', status: 'in_review' })
    expect(r.isError).toBe(true); expect(r.text).toMatch(REFUSED)
    expect(bytes(e.root)).toEqual(before)
  })

  test('§3.5.3 REST POST /api/tasks/<ref> (status) and the web drag payload → 422 evidence_required with the sentence (EN + PT)', async () => {
    const before = bytes(e.root)
    const r = await post(e, '/api/tasks/t2', { status: 'in_review' })
    expect(r.status).toBe(422)
    expect(r.body).toMatchObject({ ok: false, message: 'evidence_required', guard: { code: 'evidence_required', piece: 't2' } })
    expect(r.body.guard.message).toMatch(SENTENCE); expect(r.body.guard.messagePt).toContain('Esta peça ainda não pode ir para revisão')
    // the web's drag between columns is the same call on the subtask route
    const drag = await post(e, '/api/tasks/t1/subtasks', { id: 'p1', status: 'in_review' })
    expect(drag.status).toBe(422); expect(drag.body.guard.code).toBe('evidence_required')
    expect(bytes(e.root)).toEqual(before)
  })

  test('§3.5.4 CLI `agentop task deliver <ref>` (the CLI\'s only forward move; there is no `task mark`) → exit 2 and the same sentence', async () => {
    const before = bytes(e.root)
    const r = await cli(e, 'task', 'deliver', 't2')
    expect(r.code).toBe(2); expect(r.err).toMatch(SENTENCE)
    expect(bytes(e.root)).toEqual(before)
    const rest = await post(e, '/api/tasks/t2', { status: 'done' })
    expect(r.err).toContain(rest.body.guard.message) // one sentence, three doors
  })

  test('§3.5.7 jump doors: pr_merge, ci, done and the custom "Review ready" / "Shipped" statuses, setSubtaskDone → each refused with the guard\'s code (never unknown_status)', async () => {
    const before = bytes(e.root)
    for (const status of ['pr_merge', 'ci', 'done', 'review_ready', 'shipped']) {
      for (const [path, body] of [['/api/tasks/t2', { status }], ['/api/tasks/t1/subtasks', { id: 'p1', status }]] as const) {
        const r = await post(e, path, body)
        expect(r.status, `${status} ${path}`).toBe(422)
        expect(r.body.guard?.code, `${status} ${path}`).toBe('evidence_required')
      }
    }
    const done = await post(e, '/api/tasks/t1/subtasks', { id: 'p1', done: true }) // setSubtaskDone
    expect(done.status).toBe(422); expect(done.body.guard.code).toBe('evidence_required')
    const viaMcp = await mcp(e, 'agentistics_task_status', { ref: 't2', status: 'shipped' })
    expect(viaMcp.isError).toBe(true); expect(viaMcp.text).toMatch(REFUSED)
    expect(bytes(e.root)).toEqual(before)
  })

  test('§3.5.20 positive control — REST: valid desktop + mobile screenshots + probe at HEAD → the move succeeds, the checkpoint carries auth: evidence with those ids', async () => {
    await attachAll(e, 'p1', 'worker')
    const rec = (await e.world.svc.get('p1'))!
    const r = await post(e, '/api/tasks/t1/subtasks', { id: 'p1', status: 'in_review' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const cp = (await checkpoints(e)).p1!
    expect(cp).toMatchObject({ rank: 1, boardStatus: 'in_review', headSha: gitSync(e.world.repo, 'rev-parse', 'HEAD') })
    expect(cp.auth).toEqual([{ kind: 'evidence', ids: rec.evidence!.map(i => i.id), sha256: rec.evidence!.map(i => i.sha256) }])
  })

  test('§3.5.20 positive control — MCP: the same evidence on another piece lets agentistics_task_subtask move it', async () => {
    await attachAll(e, 'p2', 'worker2')
    const r = await mcp(e, 'agentistics_task_subtask', { ref: 't1', id: 'p2', status: 'in_review' })
    expect(r.isError, r.text).toBe(false)
    expect((await checkpoints(e)).p2).toMatchObject({ rank: 1, boardStatus: 'in_review' })
  })
})

describe('rule OFF (the default) — nothing a user does today changes, at every door', () => {
  let e: Env
  beforeAll(async () => { e = await boot('off') }, 90_000)
  afterAll(async () => { await e?.stop() })

  test('REST: the same moves with NO evidence succeed, exactly as before', async () => {
    expect((await post(e, '/api/tasks/t1/subtasks', { id: 'p1', status: 'in_review' })).status).toBe(200)
    expect((await post(e, '/api/tasks/t2', { status: 'in_review' })).status).toBe(200)
    expect((await post(e, '/api/tasks/t1/subtasks', { id: 'p2', done: true })).status).toBe(200)
  })
  test('MCP: agentistics_task_status / agentistics_task_subtask succeed with no evidence', async () => {
    expect((await mcp(e, 'agentistics_task_status', { ref: 't2', status: 'shipped' })).isError).toBe(false)
    expect((await mcp(e, 'agentistics_task_subtask', { ref: 't1', id: 'p3', status: 'in_review' })).isError).toBe(false)
  })
  test('r9 D: the MCP tick {id, done} really changes the piece status and is idempotent (done:true, again, done:false, again)', async () => {
    const statusOf = async () => ((await (await fetch(`${e.base}/api/tasks/t1`)).json()) as any).task.subtasks.find((s: any) => s.id === 'p1').status
    const first = await mcp(e, 'agentistics_task_subtask', { ref: 't1', id: 'p1', done: true })
    expect(first.isError, first.text).toBe(false)
    const afterFirst = await statusOf()
    expect(afterFirst).toBe('done')
    const again = await mcp(e, 'agentistics_task_subtask', { ref: 't1', id: 'p1', done: true })
    expect(again.isError, again.text).toBe(false)
    expect(await statusOf()).toBe('done')
    const off = await mcp(e, 'agentistics_task_subtask', { ref: 't1', id: 'p1', done: false })
    expect(off.isError, off.text).toBe(false)
    expect(await statusOf()).toBe('todo')
    expect((await mcp(e, 'agentistics_task_subtask', { ref: 't1', id: 'p1', done: false })).isError).toBe(false)
    expect(await statusOf()).toBe('todo')
  })
  test('CLI: agentop task deliver succeeds with no evidence (exit 0)', async () => {
    const r = await cli(e, 'task', 'deliver', 't2')
    expect(r.code, r.err).toBe(0)
  })
  test('and no checkpoint file was ever created (the board\'s own stage mirror may exist; the rule stays off)', () => {
    expect(existsSync(join(e.root, 'guards.json'))).toBe(false)
  })
})

describe('§3.5.6 flow phase qa → revisao_lider (APROVADO) needs the evidencia gate', () => {
  let e: Env
  beforeAll(async () => { e = await boot('on') }, 90_000)
  afterAll(async () => { await e?.stop() })

  const toQa = async () => {
    await e.world.svc.ensure('p4')
    const head = gitSync(e.world.repo, 'rev-parse', 'HEAD')
    // the piece sits in qa at the verified head (the record's own fields; a rank-0 move, so the store lets it through)
    const store = (await import('./store')).createDeliveryStore(join(e.root, 'deliveries.json'))
    await store.update(doc => { const r = doc.deliveries.p4!; r.phase = 'qa'; r.headSha = head; r.branch = 'feat/x' }, { guard: unattributedContext() })
    const author = e.world.sessions.find(s => s.id === 'worker4')!
    Object.assign(author, { model: 'claude-sonnet-4' })
    e.world.sessions.push({ ...author, id: 'qa-p4', harness: 'codex', model: 'gpt-6', label: 'QA' } as never)
  }

  test('without evidence: refused code portao, the missing list names the evidencia gate, deliveries.json byte-identical', async () => {
    await toQa()
    const before = bytes(e.root)
    const r = await (e.world.svc as any).transition('p4', 'revisao_lider', { verdict: 'APROVADO', findings: 'looks right' }, 'worker4')
    expect(r).toMatchObject({ ok: false, code: 'portao' })
    expect(r.missing.join(' ')).toMatch(/evidencia/)
    expect(r.missing.join(' ')).not.toMatch(/qa-modelo/)
    expect(bytes(e.root)).toEqual(before)
    expect((await e.world.svc.get('p4'))!.phase).toBe('qa') // the phase did not move (gate verdicts are recorded, as they always were)
  })

  test('the gate itself (agentop flow gate evidencia) says what is missing, then passes once the evidence is attached', async () => {
    const miss = await (e.world.svc as any).gate('p4', 'evidencia', 'worker4')
    expect(miss).toMatchObject({ ok: false, code: 'portao' }); expect(miss.sentence).toMatch(SENTENCE)
    await attachAll(e, 'p4', 'worker4')
    const ok = await (e.world.svc as any).gate('p4', 'evidencia', 'worker4')
    expect(ok).toMatchObject({ ok: true }); expect(ok.gate.evidence.ids.length).toBe(3)
  })
})

describe('§3.5.5 the handback is HELD, never lost; and the other doors (engine board, cockpit finish, flow) are bound the same way', () => {
  test('handback: the comment is recorded, the subtask stays in_progress, the reply names what is missing — then, with evidence, the same handback moves it', async () => {
    const e = await boot('on')
    try {
      const script = (body: string) => `
        const sm = await import(${JSON.stringify(join(SERVER_ROOT, 'server', 'sessions', 'session-message.ts'))})
        const src = await import(${JSON.stringify(join(SERVER_ROOT, 'server', 'sessions', 'task-source.ts'))})
        const real = await sm.defaultMessageDeps()
        const comments = []
        const deps = { rows: async () => [{ id: 'leader', title: 'Leader', conversationId: 'c-l' }, { id: 'worker3', title: 'W', conversationId: 'c-w' }],
          prompt: async () => ({ ok: true, message: 'sent' }), now: () => Date.now(),
          senderTask: async () => ({ taskId: 't1', subtaskId: 'p3' }),
          comment: async (taskId, c) => { comments.push(c.body); return real.comment(taskId, c) },
          handbackSubtask: real.handbackSubtask }
        ${body}
        const w = await src.loadTaskWorld()
        console.log(JSON.stringify({ reply, status: w.book.subtasks.find(s => s.id === 'p3').status, recorded: w.book.comments.filter(c => c.subtaskId === 'p3').length }))
      `
      const run = async (body: string) => {
        const p = Bun.spawn([process.execPath, '-e', script(body)], { env: { ...gitTestEnv(), HOME: e.root, AGENTISTICS_DIR: e.root, NODE_ENV: 'test' } as Record<string, string>, stdout: 'pipe', stderr: 'pipe' })
        const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
        if (await p.exited !== 0) throw new Error(err.split('\n').slice(-6).join(' | '))
        return JSON.parse(out.trim().split('\n').filter(Boolean).at(-1)!)
      }
      const before = bytes(e.root).deliveries
      const held = await run(`const reply = await sm.sendSessionMessage('worker3', { to: 'leader', kind: 'handback', body: 'done, please review' }, deps)`)
      expect(held.status).toBe('in_progress'); expect(held.recorded).toBe(1)
      expect(held.reply).toMatchObject({ ok: true, delivered: true, held: { code: 'evidence_required' } })
      expect(held.reply.message).toMatch(/Handback held/); expect(held.reply.message).toMatch(SENTENCE)
      expect(bytes(e.root).deliveries).toEqual(before)
      await attachAll(e, 'p3', 'worker3')
      await Bun.sleep(1100) // the pair rate limit is per process; this is a fresh one, but keep the second send clearly later
      const moved = await run(`const reply = await sm.sendSessionMessage('worker3', { to: 'leader', kind: 'handback', body: 'done again' }, deps)`)
      expect(moved.status).toBe('in_review'); expect(moved.reply.held).toBeUndefined()
    } finally { await e.stop() }
  }, 120_000)

  test('engine board status, cockpit finish and the flow (antigas / setPhaseStatus) contexts are refused by the store too', async () => {
    const e = await boot('on')
    try {
      const script = `
        const guard = await import(${JSON.stringify(join(SERVER_ROOT, 'server', 'delivery', 'guard.ts'))})
        const tw = await import(${JSON.stringify(join(SERVER_ROOT, 'server', 'sessions', 'task-web.ts'))})
        const { hostEngineBoard } = await import(${JSON.stringify(join(SERVER_ROOT, 'server', 'engine', 'engine-board.ts'))})
        const board = hostEngineBoard(() => 'en')
        const engine = await board.status('t2', { status: 'in_review', actor: 'engine' })
        const cockpit = await tw.markTask('t2', 'done', 'cockpit', { guard: guard.unattributedContext() })
        const antigas = await tw.markTask('t2', 'done', 'flow:antigas', { guard: guard.flowContext() })
        const phase = await tw.patchSubtask('p1', { status: 'in_review' }, guard.flowContext())
        console.log(JSON.stringify({ engine, cockpit: cockpit.guard?.code, antigas: antigas.guard?.code, phase: phase.guard?.code }))
      `
      const p = Bun.spawn([process.execPath, '-e', script], { env: { ...gitTestEnv(), HOME: e.root, AGENTISTICS_DIR: e.root, NODE_ENV: 'test' } as Record<string, string>, stdout: 'pipe', stderr: 'pipe' })
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
      expect(await p.exited, err).toBe(0)
      const r = JSON.parse(out.trim().split('\n').filter(Boolean).at(-1)!)
      expect(r).toMatchObject({ cockpit: 'evidence_required', antigas: 'evidence_required', phase: 'evidence_required' })
      expect(r.engine).toMatchObject({ ok: false, status: 422 })
      expect(JSON.stringify(r.engine)).toContain('evidence_required')
    } finally { await e.stop() }
  }, 120_000)

  test('the doors pass a context (source wiring): index.ts, cli-task, the cockpit finish, the delivery host and the engine board', () => {
    const src = (rel: string) => readFileSync(join(SERVER_ROOT, rel), 'utf8')
    expect(src('server/index.ts')).toMatch(/setSubtaskDone\(body\.id, body\.done, guardCtx\)/)
    expect(src('server/index.ts')).toMatch(/guard: guardCtx/)
    expect(src('server/sessions/cli-task.ts')).toMatch(/guard: \{ principal: who\.principal \}/)
    expect(src('server/cli-start.ts')).toMatch(/guard: unattributedContext\(\)/)
    expect(src('server/delivery/host.ts')).toMatch(/guard: flowContext\(\)/)
    expect(src('server/engine/engine-board.ts')).toMatch(/unattributedContext\(\)/)
  })
})
