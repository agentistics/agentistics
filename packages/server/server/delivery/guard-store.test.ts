/**
 * S2a — the STORE guard, rule A, at the two choke points (spec §2.5): `task-store.ts` `write()` and `delivery/store.ts`
 * `update()`. Real git (throwaway), real tasks.json / deliveries.json / guards.json / guarantees.json in a temp dir, the real
 * guarantee activation primitives. Covers spec §3.5 items 1–7 at the store (every door ends here) and the positive control 20.
 *
 * Every NEGATIVE asserts the exact code AND that tasks.json and deliveries.json are byte-identical after the attempt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGuaranteesStore, type ActivationFacts } from './activation'
import { forgetClassifyCache, execGit } from './classify-host'
import { GuardRefused, type GuardContext } from './guard'
import { createGuardsStore } from './guards-store'
import { createDeliveryStore } from './store'
import { ruleAState } from './guard-host'
import { lockFile } from '../sessions/file-lock'
import { writeSealed } from './guard-integrity'
import { GuardBusy, GuardLockOrderError } from './guard-locks'
import { withGuardTransaction } from './guard-transaction'
import { gitSync, put } from './git-fixture.testing'
import { T, makeWorld, shot } from './evidence-world.testing'
import { createTaskStore } from '../sessions/task-store'
import type { Subtask } from '../sessions/task-model'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'guard-store-')); forgetClassifyCache() })
afterEach(() => rmSync(root, { recursive: true, force: true }))

const ISO = '2026-11-13T09:00:00.000Z'
const ctx: GuardContext = { principal: { kind: 'unattributed' } }
const def = (id: string, label: string, stage: string, order: number, prot = false) => ({ id, label, color: '#112233', protected: prot, order, stage }) as never
const DEFS = [
  def('todo', 'To do', 'queue', 0, true), def('in_progress', 'In progress', 'running', 1, true), def('blocked', 'Blocked', 'blocked', 2, true), def('done', 'Done', 'published', 3, true),
  def('in_review', 'In review', 'leader', 4), def('pr_merge', 'PR merge', 'merge', 5), def('ci', 'CI', 'ci', 6),
  def('review_ready', 'Review ready', 'leader', 7), def('shipped', 'Shipped', 'published', 8),
]
const sub = (id: string, over: Partial<Subtask> = {}): Subtask => ({ id, taskId: 't1', title: id, done: false, status: 'in_progress', createdAt: ISO, updatedAt: ISO, ...over }) as Subtask

async function setup(o: { rule?: 'off' | 'shadow' | 'on' } = {}) {
  const world = makeWorld(root)
  const deps = { sessions: async () => world.sessions, git: execGit }
  const tasks = createTaskStore(join(root, 'tasks.json'), { guard: { deps, now: () => T } })
  await tasks.seedStatuses(DEFS)
  await tasks.upsertTask({ id: 't1', title: 't1', status: 'in_progress', createdAt: ISO, updatedAt: ISO } as never)
  await tasks.upsertSubtask(sub('p1')); await tasks.upsertSubtask(sub('p2'))
  const rule = o.rule ?? 'on'
  if (rule !== 'off') {
    const g = createGuaranteesStore(join(root, 'guarantees.json'))
    const check = async () => ({ ok: true as const, via: 'legacy-browser' as const })
    const facts = (now: string): ActivationFacts => ({ now, build: 'test', capabilities: ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'], migrated: ['a'], unexplainedWouldRefuse: 0 })
    const earlier = new Date(T - 25 * 3600_000).toISOString()
    expect(await g.setState('a', 'shadow', { check, facts: facts(earlier) })).toEqual({ ok: true })
    if (rule === 'on') expect(await g.setState('a', 'on', { check, facts: facts(new Date(T).toISOString()) })).toEqual({ ok: true })
  }
  const deliveries = createDeliveryStore(join(root, 'deliveries.json'), { guard: { deps, now: () => T } })
  return { world, tasks, deliveries, deps }
}

const bytes = () => ({ tasks: readFileSync(join(root, 'tasks.json'), 'utf8'), deliveries: existsSync(join(root, 'deliveries.json')) ? readFileSync(join(root, 'deliveries.json'), 'utf8') : '' })
const checkpoints = async () => (await createGuardsStore(join(root, 'guards.json')).read()).checkpoints

async function attachAll(svc: ReturnType<typeof makeWorld>['svc'], id = 'p1') {
  for (const input of [shot(1280, 1), shot(390, 2), { kind: 'probe', probe: { kind: 'bundle', literal: 'a-literal-of-12+' } }]) {
    const r = await svc.evidenceAdd(id, input as never, 'worker')
    expect(r.ok, JSON.stringify(r)).toBe(true)
  }
}

async function refusal(run: () => Promise<unknown>): Promise<GuardRefused> {
  try { await run() } catch (e) { if (e instanceof GuardRefused) return e; throw e }
  throw new Error('expected a GuardRefused, the write went through')
}

describe('rule OFF (the default) changes nothing', () => {
  test('no guarantees.json: a rank-raising write is exactly what it always was, with no context, and nothing is created', async () => {
    const { tasks } = await setup({ rule: 'off' })
    await tasks.upsertSubtask(sub('p1', { status: 'in_review' }))
    await tasks.patchTask('t1', { status: 'done' })
    expect((await tasks.read()).subtasks.find(s => s.id === 'p1')!.status).toBe('in_review')
    for (const f of ['guards.json', 'guarantees.json', 'guard-integrity.key']) expect(existsSync(join(root, f)), f).toBe(false)
  })
  test('a delivery phase raise with no context is also untouched while the rule is off', async () => {
    const { world, deliveries } = await setup({ rule: 'off' })
    await world.svc.ensure('p1')
    await deliveries.update(doc => { doc.deliveries.p1!.phase = 'revisao_lider' })
    expect((await deliveries.get('p1'))!.phase).toBe('revisao_lider')
    expect(existsSync(join(root, 'guards.json'))).toBe(false)
  })
})

describe('§3.5.1–3 the board hook: a status that raises a piece is refused without evidence', () => {
  for (const status of ['in_review', 'pr_merge', 'ci', 'done', 'review_ready', 'shipped']) {
    test(`subtask → ${status}: evidence_required, both documents byte-identical, no checkpoint`, async () => {
      const { world, tasks } = await setup()
      await world.svc.ensure('p1')
      const before = bytes()
      const e = await refusal(() => tasks.upsertSubtask(sub('p1', { status }), ctx))
      expect(e).toMatchObject({ code: 'evidence_required', status: 422, piece: 'p1' })
      expect(e.message).toContain('screenshot')
      expect(bytes()).toEqual(before)
      expect(await checkpoints()).toEqual({})
    })
  }
  test('a TASK with no subtasks is a piece too (patchTask → in_review is refused)', async () => {
    const { tasks } = await setup()
    await tasks.removeSubtask('p1'); await tasks.removeSubtask('p2')
    const before = bytes()
    const e = await refusal(() => tasks.patchTask('t1', { status: 'in_review' }, { guard: ctx }))
    expect(e.code).toBe('evidence_required'); expect(bytes()).toEqual(before)
  })
  test('the CI signal alone raises the piece (the Live shows it on CI): refused without evidence', async () => {
    const { tasks } = await setup()
    const before = bytes()
    const e = await refusal(() => tasks.upsertSubtask(sub('p1', { ci: { mergedMain: true, releaseGreen: false, tagPublished: false, tag: null, pr: null } } as never), { principal: { kind: 'flow', engine: 'entrega' } }))
    expect(e.code).toBe('evidence_required'); expect(bytes()).toEqual(before)
  })
  test('lowering a rank, rank-0 moves, a status-neutral write and a group MEMBER are never refused', async () => {
    const { tasks } = await setup()
    await tasks.upsertSubtask(sub('g', { isGroup: true } as never))
    await tasks.upsertSubtask(sub('m', { parentGroupId: 'g' } as never))
    await tasks.upsertSubtask(sub('m', { parentGroupId: 'g', status: 'in_review' } as never), ctx) // a member inherits its group's rules
    await tasks.upsertSubtask(sub('p2', { status: 'blocked' }), ctx)
    await tasks.upsertSubtask(sub('p2', { status: 'todo', title: 'renamed' }), ctx)
    await tasks.addComment({ id: 'c1', taskId: 't1', author: 'x', body: 'hi', createdAt: ISO } as never)
    expect((await tasks.read()).subtasks.find(s => s.id === 'm')!.status).toBe('in_review')
  })
})

describe('fail closed: a door that forgot to say who is asking', () => {
  test('even WITH full evidence, a raising write carrying no context is refused guard_context_required', async () => {
    const { world, tasks } = await setup()
    await attachAll(world.svc)
    const before = bytes()
    const e = await refusal(() => tasks.upsertSubtask(sub('p1', { status: 'in_review' })))
    expect(e).toMatchObject({ code: 'guard_context_required', status: 422 })
    expect(bytes()).toEqual(before)
  })
  test('the delivery store fails closed the same way', async () => {
    const { world, deliveries } = await setup()
    await attachAll(world.svc)
    const before = bytes()
    const e = await refusal(() => deliveries.update(doc => { doc.deliveries.p1!.phase = 'revisao_lider' }))
    expect(e.code).toBe('guard_context_required'); expect(bytes()).toEqual(before)
  })
})

describe('§3.5.20 positive control — valid desktop + mobile screenshots + probe at the current HEAD', () => {
  test('the board move succeeds and the checkpoint carries auth: evidence with exactly those ids', async () => {
    const { world, tasks } = await setup()
    await attachAll(world.svc)
    const rec = (await world.svc.get('p1'))!
    await tasks.upsertSubtask(sub('p1', { status: 'in_review' }), ctx)
    expect((await tasks.read()).subtasks.find(s => s.id === 'p1')!.status).toBe('in_review')
    const cp = (await checkpoints()).p1!
    expect(cp).toMatchObject({ rank: 1, boardStatus: 'in_review', headSha: gitSync(world.repo, 'rev-parse', 'HEAD'), classification: { category: 'screen' } })
    expect(cp.auth).toEqual([{ kind: 'evidence', ids: rec.evidence!.map(i => i.id), sha256: rec.evidence!.map(i => i.sha256) }])
    expect((await createGuardsStore(join(root, 'guards.json')).read()).intents).toEqual({}) // two-phase commit finished
  })
  test('the delivery phase move succeeds the same way and the checkpoint names the phase', async () => {
    const { world, deliveries } = await setup()
    await attachAll(world.svc)
    await deliveries.update(doc => { doc.deliveries.p1!.phase = 'revisao_lider' }, { guard: ctx })
    expect((await deliveries.get('p1'))!.phase).toBe('revisao_lider')
    expect((await checkpoints()).p1).toMatchObject({ rank: 1, phase: 'revisao_lider' })
  })
  test('later ranks reuse the checkpoint: pr_merge after review is allowed with the evidence still current, refused once HEAD moved', async () => {
    const { world, tasks } = await setup()
    await attachAll(world.svc)
    await tasks.upsertSubtask(sub('p1', { status: 'in_review' }), ctx)
    await tasks.upsertSubtask(sub('p1', { status: 'pr_merge' }), ctx)
    expect((await checkpoints()).p1!.rank).toBe(2)
    put(world.repo, 'packages/web/src/b.tsx'); gitSync(world.repo, 'add', '-A'); gitSync(world.repo, 'commit', '-m', 'more')
    const e = await refusal(() => tasks.upsertSubtask(sub('p1', { status: 'ci' }), ctx))
    expect(e.code).toBe('evidence_stale')
    expect((await tasks.read()).subtasks.find(s => s.id === 'p1')!.status).toBe('pr_merge')
  })
})

describe('the guard reads the checkout NOW, at every guarded move', () => {
  test('an uncommitted edit after the evidence → uncommitted_changes', async () => {
    const { world, tasks } = await setup()
    await attachAll(world.svc)
    put(world.repo, 'packages/server/server/dirty.ts', 'export {}')
    const before = bytes()
    const e = await refusal(() => tasks.upsertSubtask(sub('p1', { status: 'in_review' }), ctx))
    expect(e.code).toBe('uncommitted_changes'); expect(bytes()).toEqual(before)
  })
  test('a piece with no filed session → classification_required', async () => {
    const { world, tasks } = await setup()
    world.sessions.length = 0
    await tasks.upsertSubtask(sub('p3'), undefined)
    const before = bytes()
    const e = await refusal(() => tasks.upsertSubtask(sub('p3', { status: 'in_review' }), ctx))
    expect(e.code).toBe('classification_required'); expect(bytes()).toEqual(before)
  })
})

describe('the delivery hook (phase raises)', () => {
  test('F6: an internal option cannot redirect the activation lock to another file', async () => {
    const { world, deliveries } = await setup()
    await world.svc.ensure('p1')
    const before = bytes()
    await expect(deliveries.update(doc => { doc.deliveries.p1!.phase = 'publicado' }, { evidence: true, guardsPath: join(root, 'other-guards.json') })).rejects.toBeInstanceOf(GuardLockOrderError)
    expect(bytes()).toEqual(before)
  })
  test('F6: parallel store instances inside one envelope retain every write', async () => {
    const { tasks, world, deliveries } = await setup()
    await world.svc.ensure('p1')
    const otherTasks = createTaskStore(join(root, 'tasks.json'))
    const otherDeliveries = createDeliveryStore(join(root, 'deliveries.json'))
    const paths = { tasks: join(root, 'tasks.json'), deliveries: join(root, 'deliveries.json'), guards: join(root, 'guards.json') }
    await withGuardTransaction(paths, async () => {
      await Promise.all([tasks.addComment({ id: 'c-a', taskId: 't1', author: 'worker', body: 'a', createdAt: ISO } as never), otherTasks.addComment({ id: 'c-b', taskId: 't1', author: 'worker', body: 'b', createdAt: ISO } as never)])
      await Promise.all([deliveries.update(async doc => { await Bun.sleep(15); doc.deliveries.p1!.branch = 'branch' }), otherDeliveries.update(doc => { doc.deliveries.p1!.qaModel = 'QA' })])
    })
    expect((await tasks.read()).comments.map(c => c.id)).toEqual(['c-a', 'c-b'])
    expect(await deliveries.get('p1')).toMatchObject({ branch: 'branch', qaModel: 'QA' })
  })
  for (const name of ['tasks', 'deliveries', 'guards']) test(`F6: real board hook times out ${name} with 409 and unchanged books`, async () => {
    const { tasks } = await setup()
    const blocker = await lockFile(join(root, name + '.json'))
    const before = bytes()
    try {
      const e = await tasks.upsertSubtask(sub('p1', { status: 'in_review' }), ctx).catch(e => e)
      expect(e).toBeInstanceOf(GuardBusy)
      expect(e).toMatchObject({ code: 'guard_busy', status: 409, lock: name })
      expect(bytes()).toEqual(before)
    } finally { await blocker.release() }
  }, 12_000)
  test('F6: two processes use real hooks and transition with board effects under the complete envelope', async () => {
    const { world } = await setup()
    await attachAll(world.svc)
    Object.assign(world.sessions.find(s => s.id === 'worker')!, { model: 'claude-sonnet-4' })
    world.sessions.push({ ...world.sessions.find(s => s.id === 'worker')!, id: 'qa-race', label: 'QA', model: 'gpt-6', harness: 'codex' } as never)
    writeFileSync(join(root, 'race-sessions.json'), JSON.stringify(world.sessions))
    const workers = ['board', 'phase'].map(role => Bun.spawn([process.execPath, join(import.meta.dir, 'guard-store-locks.testing.ts'), root, role], {
      env: { ...process.env, AGENTISTICS_TASKS_FILE: join(root, 'tasks.json'), AGENTISTICS_DELIVERIES_FILE: join(root, 'deliveries.json') }, stdout: 'pipe', stderr: 'pipe',
    }))
    const timer = setTimeout(() => { for (const p of workers) p.kill() }, 25_000)
    try {
      for (const p of workers) {
        const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()])
        expect(code, out + err).toBe(0)
        expect(out).toContain('8 real-store iterations')
      }
    } finally { clearTimeout(timer); for (const p of workers) if (p.exitCode === null) p.kill() }
  }, 30_000)
  test('F6: activation during a blocked guard acquisition is read after acquisition', async () => {
    const { tasks } = await setup({ rule: 'shadow' })
    const g = createGuaranteesStore(join(root, 'guarantees.json'))
    const doc = (await g.read()).doc
    const lock = await lockFile(join(root, 'guards.json'))
    const before = bytes()
    const moving = tasks.upsertSubtask(sub('p1', { status: 'in_review' }), ctx).then(() => null, e => e)
    try {
      await new Promise(resolve => setTimeout(resolve, 150))
      doc.rules.a!.state = 'on'
      await writeSealed(g.path, 'guarantees', doc)
    } finally { await lock.release() }
    expect(await moving).toBeInstanceOf(GuardRefused)
    expect(bytes()).toEqual(before)
  })
  test('F5: evidence option cannot suppress phase detection', async () => {
    const { world, deliveries } = await setup()
    await world.svc.ensure('p1')
    const before = bytes()
    expect((await refusal(() => deliveries.update(doc => { doc.deliveries.p1!.phase = 'publicado' }, { evidence: true }))).code).toBe('guard_context_required')
    expect(bytes()).toEqual(before)
  })
  test('F4: advanced adoption and same-rank relinking require authorization', async () => {
    const { world, deliveries } = await setup()
    await world.svc.ensure('p1')
    const before = bytes()
    await refusal(() => deliveries.update(doc => { doc.deliveries.p2 = { ...doc.deliveries.p1!, subtaskId: 'p2', phase: 'publicado' } }))
    expect(bytes()).toEqual(before)
    await attachAll(world.svc)
    await deliveries.update(doc => { doc.deliveries.p1!.phase = 'revisao_lider' }, { guard: ctx })
    const reviewed = bytes()
    await refusal(() => deliveries.update(doc => { doc.deliveries.p1!.taskId = 'another-task' }))
    expect(bytes()).toEqual(reviewed)
  })
  test('F2: deleting documents and key with witness retained never reads OFF', async () => {
    const { tasks } = await setup()
    expect(await ruleAState(root)).toBe('on')
    for (const f of ['guarantees.json', 'guards.json', 'guard-integrity.key']) rmSync(join(root, f))
    const before = bytes()
    expect(await ruleAState(root)).toBe('on')
    expect((await refusal(() => tasks.upsertSubtask(sub('p1', { status: 'in_review' }), ctx))).code).toBe('guards_unreadable')
    expect(bytes()).toEqual(before)
    const child = Bun.spawnSync([process.execPath, '-e', `const { ruleAState } = await import(${JSON.stringify(join(import.meta.dir, 'guard-host.ts'))}); const { createTaskStore } = await import(${JSON.stringify(join(import.meta.dir, '../sessions/task-store.ts'))}); const store = createTaskStore(${JSON.stringify(join(root, 'tasks.json'))}); const s = (await store.read()).subtasks.find(s => s.id === 'p1'); try { await store.upsertSubtask({ ...s, status: 'in_review' }); console.log('UNGUARDED') } catch(e) { console.log(await ruleAState(${JSON.stringify(root)}), e.code) }`])
    expect(child.exitCode).toBe(0)
    expect(child.stdout.toString().trim()).toBe('on guards_unreadable')
    expect(bytes()).toEqual(before)
    rmSync(join(root, 'guard-seal'), { recursive: true })
    expect(await ruleAState(root)).toBe('on') // running-process latch survives loss of every disk anchor
  })
  test('F4: deleting the last child exposes a protected task piece', async () => {
    const { tasks } = await setup()
    expect(await tasks.patchTask('t1', { status: 'in_review' }, { allowOpenSubtasks: true })).toBe(true)
    await tasks.removeSubtask('p1')
    const before = bytes()
    await refusal(() => tasks.removeSubtask('p2'))
    expect(bytes()).toEqual(before)
  })
  test('F7: adjustment invalidates old evidence even at the same HEAD', async () => {
    const { world, tasks, deliveries } = await setup()
    await attachAll(world.svc)
    await deliveries.update(doc => { const r = doc.deliveries.p1!; r.revision += 2; r.phase = 'qa'; r.history.push({ from: 'qa', to: 'ajuste', at: ISO, actor: 'worker', detail: 'recapture', revision: r.revision - 1 }) })
    const before = bytes()
    expect((await refusal(() => tasks.upsertSubtask(sub('p1', { status: 'in_review' }), ctx))).code).toBe('evidence_required')
    expect(bytes()).toEqual(before)
    for (const input of [shot(1280, 11), shot(390, 12), { kind: 'probe', probe: { kind: 'bundle', literal: 'fresh-round-literal-14+' } }]) expect((await world.svc.evidenceAdd('p1', input as never, 'worker')).ok).toBe(true)
    await tasks.upsertSubtask(sub('p1', { status: 'in_review' }), ctx)
    await deliveries.update(doc => { const r = doc.deliveries.p1!; r.phase = 'pr_merge'; r.revision++ }, { guard: ctx })
    expect((await deliveries.get('p1'))!.phase).toBe('pr_merge') // a normal revision increment keeps this capture round
  })
  test('F4: dissolving a group cannot expose an unauthorized advanced member', async () => {
    const { tasks } = await setup()
    await tasks.upsertSubtask(sub('g', { isGroup: true } as never))
    await tasks.upsertSubtask(sub('m', { parentGroupId: 'g', status: 'in_review' } as never))
    const before = bytes()
    await refusal(() => tasks.removeSubtask('g'))
    expect(bytes()).toEqual(before)
  })
  test('no evidence → evidence_required, deliveries.json byte-identical', async () => {
    const { world, deliveries } = await setup()
    await world.svc.ensure('p1')
    const before = bytes()
    const e = await refusal(() => deliveries.update(doc => { doc.deliveries.p1!.phase = 'revisao_lider' }, { guard: ctx }))
    expect(e.code).toBe('evidence_required'); expect(bytes()).toEqual(before)
  })
  test('an ADOPTION (a new record already past the queue) is not a raise; lowering a phase never is', async () => {
    const { world, deliveries } = await setup()
    await world.svc.ensure('p1')
    await deliveries.update(doc => { doc.deliveries.p1!.phase = 'qa' })
    expect((await deliveries.get('p1'))!.phase).toBe('qa')
  })
})

describe('shadow reports and never refuses', () => {
  test('a raising write with no evidence goes through, and no checkpoint is invented', async () => {
    const { world, tasks } = await setup({ rule: 'shadow' })
    await world.svc.ensure('p1')
    const warn = console.warn; const seen: string[] = []
    console.warn = (...a: unknown[]) => { seen.push(a.join(' ')) }
    try { await tasks.upsertSubtask(sub('p1', { status: 'in_review' }), ctx) } finally { console.warn = warn }
    expect((await tasks.read()).subtasks.find(s => s.id === 'p1')!.status).toBe('in_review')
    expect(seen.some(s => s.includes('would_refuse') && s.includes('evidence_required'))).toBe(true)
    expect(await checkpoints()).toEqual({})
  })
})

describe('a grandfathered checkpoint covers what was already in flight (ranks ≤ 3)', () => {
  for (const status of ['in_review', 'ci']) for (const dirty of [false, true]) test(`F3: rank-0 inherited piece → ${status}, dirty=${dirty}`, async () => {
    const { world, tasks } = await setup()
    const g = createGuardsStore(join(root, 'guards.json')); const doc = await g.read()
    await g.write({ ...doc, checkpoints: { p1: { key: 'p1', rank: 0, boardStatus: 'in_progress', boardStage: 'running', phase: null, revision: 1, headSha: null, auth: [{ kind: 'grandfathered', at: ISO }], by: { kind: 'flow' }, at: ISO, transitionId: 'tr-g0' } } })
    put(world.repo, 'packages/web/src/new.tsx'); gitSync(world.repo, 'add', '-A'); gitSync(world.repo, 'commit', '-m', 'new work')
    if (dirty) put(world.repo, 'packages/web/src/dirty.tsx')
    const before = bytes()
    expect((await refusal(() => tasks.upsertSubtask(sub('p1', { status }), ctx))).code).toBe(dirty ? 'uncommitted_changes' : 'evidence_required')
    expect(bytes()).toEqual(before)
    expect((await checkpoints()).p1!.rank).toBe(0)
  })
  test('F3: a grandfathered checkpoint never authorizes new progress', async () => {
    const { world, tasks } = await setup()
    await world.svc.ensure('p1')
    const migrated = JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8'))
    migrated.subtasks.find((s: { id: string }) => s.id === 'p1').status = 'in_review'
    writeFileSync(join(root, 'tasks.json'), JSON.stringify(migrated))
    const g = createGuardsStore(join(root, 'guards.json'))
    const doc = await g.read()
    await g.write({ ...doc, checkpoints: { p1: { key: 'p1', rank: 1, boardStatus: 'in_review', boardStage: 'leader', phase: null, revision: 1, headSha: null, auth: [{ kind: 'grandfathered', at: ISO }], by: { kind: 'flow' }, at: ISO, transitionId: 'tr-g' } } })
    await tasks.addComment({ id: 'migration-preserved', taskId: 't1', author: 'worker', body: 'unchanged migrated work', createdAt: ISO } as never)
    expect((await tasks.read()).subtasks.find(s => s.id === 'p1')!.status).toBe('in_review')
    expect((await checkpoints()).p1!.auth).toEqual([{ kind: 'grandfathered', at: ISO }])
    const before = bytes()
    expect((await refusal(() => tasks.upsertSubtask(sub('p1', { status: 'pr_merge' }), ctx))).code).toBe('evidence_required')
    expect(bytes()).toEqual(before)
    expect((await checkpoints()).p1).toMatchObject({ rank: 1 })
    const e = await refusal(() => tasks.upsertSubtask(sub('p1', { status: 'done' }), ctx))
    expect(e.code).toBe('evidence_required')
  })
})
