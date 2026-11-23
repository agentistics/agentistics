/**
 * QA S2b (Opus): the board CATCH-UP through the REAL host board (task-web setPhaseStatus), inside the sweep's envelope,
 * in the test's isolated AGENTISTICS_DIR (scripts/test-preload.ts). The author's suite mocks setPhaseStatus.
 */
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { unattributedContext } from './guard'

test('CU1 catch-up through the production board effect', async () => {
  // The production host binds its default paths at import time. Isolate those imports and policy from other suites.
  if (process.env.S2B_HOST_PROBE !== '1') {
    const root = mkdtempSync(join(tmpdir(), 'sweep-host-'))
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], { env: { ...process.env, S2B_HOST_PROBE: '1', HOME: root, AGENTISTICS_DIR: join(root, 'agentistics-test-data') }, stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => child.kill(), 55_000)
    try {
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      console.log(stdout)
      expect(exit, stdout + stderr).toBe(0)
    } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill(); await child.exited }; rmSync(root, { recursive: true, force: true }) }
    return
  }
  const dir = process.env.AGENTISTICS_DIR!
  expect(/agentistics-test-data|agentistics-throwaway/.test(dir)).toBe(true)
  const T = Date.now(), ISO = new Date(T).toISOString()
  const { createTaskStore } = await import('../sessions/task-store')
  const { createGuaranteesStore } = await import('./activation')
  const { createGuardsStore } = await import('./guards-store')
  const { newDelivery } = await import('./machine')
  const def = (id: string, label: string, stage: string, order: number, prot = false) => ({ id, label, color: '#112233', protected: prot, order, stage }) as never
  const tasks = createTaskStore(join(dir, 'tasks.json'))
  await tasks.seedStatuses([def('todo', 'To do', 'queue', 0, true), def('in_progress', 'In progress', 'running', 1, true), def('blocked', 'Blocked', 'blocked', 2, true), def('done', 'Done', 'published', 3, true), def('in_review', 'In review', 'leader', 4)])
  await tasks.upsertTask({ id: 't1', title: 't1', status: 'in_progress', createdAt: ISO, updatedAt: ISO } as never, unattributedContext())
  await tasks.upsertSubtask({ id: 'p1', taskId: 't1', title: 'p1', done: false, status: 'in_progress', createdAt: ISO, updatedAt: ISO } as never, unattributedContext())
  const g = createGuaranteesStore(join(dir, 'guarantees.json'))
  const facts = (now: number) => ({ now: new Date(now).toISOString(), build: 'qa', capabilities: ['S0', 'S1', 'S2', 'S3'], migrated: ['a'], unexplainedWouldRefuse: 0 }) as never
  const check = async () => ({ ok: true as const, via: 'legacy-browser' as const })
  expect(await g.setState('a', 'shadow', { check, facts: facts(T - 25 * 3600_000) })).toEqual({ ok: true })
  expect(await g.setState('a', 'on', { check, facts: facts(T) })).toEqual({ ok: true })
  const r = newDelivery({ subtaskId: 'p1', taskId: 't1', at: ISO }) as any
  r.phase = 'revisao_lider'; r.revision = 2
  r.history = [{ from: 'fila', to: 'executando', at: ISO, actor: 'flow:entrega', revision: 1, detail: 'start' }]
  r.evidence = [{ id: 'e1', sha256: 'aa', revision: 1 }]
  writeFileSync(join(dir, 'deliveries.json'), JSON.stringify({ version: 1, deliveries: { p1: r } }))
  const gs = createGuardsStore(join(dir, 'guards.json'))
  const doc = await gs.read()
  await gs.write({ ...doc, migrations: { a: { version: 1, at: ISO } }, checkpoints: { p1: { key: 'p1', rank: 1, boardStatus: 'in_review', boardStage: 'leader', phase: 'revisao_lider', revision: 2, headSha: null, auth: [{ kind: 'evidence', ids: ['e1'], sha256: ['aa'] }], by: { kind: 'flow', engine: 'entrega' } as never, at: ISO, transitionId: 'tr-p1' } } } as never)
  const { deliveryService } = await import('./host')
  const logs: string[] = []
  const svc = deliveryService({ notify: { session: async () => true, owner: async () => undefined } as never, emit: async () => undefined, autonomous: async () => true, autoReconcile: () => false, log: (l: string) => logs.push(l) } as never)
  const out: unknown[] = []
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now()
    const a = (await svc.tick()).actions
    const board = JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8')).subtasks.find((s: any) => s.id === 'p1').status
    out.push({ tick: i, ms: Math.round(performance.now() - t0), sweep: a.filter((x: string) => x.startsWith('sweep')), board })
  }
  // the same call the sweep's catch-up makes (host.ts setPhaseStatus → task-web patchSubtask with the flow context), outside and inside the envelope
  const web = await import('../sessions/task-web')
  const { flowContext } = await import('./guard')
  const { withGuardEnvelope } = await import('./guard-transaction')
  const paths = { tasks: join(dir, 'tasks.json'), deliveries: join(dir, 'deliveries.json'), guards: join(dir, 'guards.json') }
  const direct = async () => { try { const o = await web.patchSubtask('p1', { status: 'in_review' } as never, flowContext()); return JSON.stringify(o).slice(0, 400) } catch (e: any) { return `THREW ${e?.constructor?.name} ${e?.code ?? ''} ${String(e?.message).slice(0, 300)}` } }
  console.log('CU1-inside-envelope', await withGuardEnvelope(paths, direct))
  console.log('CU1', JSON.stringify(out), 'logs', JSON.stringify(logs.filter(l => /sweep|guard/.test(l)).slice(0, 5)))
  expect((out.at(-1) as any).board).toBe('in_review')
}, 60_000)
