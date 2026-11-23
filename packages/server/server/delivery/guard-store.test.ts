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
import { T, makeWorld, shot, png } from './evidence-world.testing'
import { buildEvidenceItem } from './evidence'
import { createTaskStore } from '../sessions/task-store'
import type { Subtask } from '../sessions/task-model'
import { unattributedContext } from './guard'

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
  await tasks.upsertTask({ id: 't1', title: 't1', status: 'in_progress', createdAt: ISO, updatedAt: ISO } as never, unattributedContext())
  await tasks.upsertSubtask(sub('p1'), unattributedContext()); await tasks.upsertSubtask(sub('p2'), unattributedContext())
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

for (const via of ['vault-credential', 'legacy-browser'] as const) test(`S2B-6 owner principal persists owner authorization via ${via}`, async () => {
  const { world, tasks } = await setup()
  await world.svc.ensure('p1')
  await attachAll(world.svc)
  const principal = via === 'vault-credential' ? { kind: 'owner' as const, via, grantId: 'test-grant' } : { kind: 'owner' as const, via }
  await tasks.upsertSubtask(sub('p1', { status: 'in_review' }), { principal })
  expect((await checkpoints()).p1!.auth).toContainEqual({ kind: 'owner', via })
  expect((await checkpoints()).p1!.auth.some(a => a.kind === 'evidence')).toBe(true)
})

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
    await tasks.upsertSubtask(sub('p1', { status: 'in_review' }), unattributedContext())
    await tasks.patchTask('t1', { status: 'done' }, { guard: unattributedContext() })
    expect((await tasks.read()).subtasks.find(s => s.id === 'p1')!.status).toBe('in_review')
    for (const f of ['guards.json', 'guarantees.json', 'guard-integrity.key']) expect(existsSync(join(root, f)), f).toBe(false)
  })
  test('a delivery phase raise with no context is also untouched while the rule is off', async () => {
    const { world, deliveries } = await setup({ rule: 'off' })
    await world.svc.ensure('p1')
    await deliveries.update(doc => { doc.deliveries.p1!.phase = 'revisao_lider' }, { guard: unattributedContext() })
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
    await tasks.removeSubtask('p1', { guard: unattributedContext() }); await tasks.removeSubtask('p2', { guard: unattributedContext() })
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
    await tasks.upsertSubtask(sub('g', { isGroup: true } as never), unattributedContext())
    await tasks.upsertSubtask(sub('m', { parentGroupId: 'g' } as never), unattributedContext())
    await tasks.upsertSubtask(sub('m', { parentGroupId: 'g', status: 'in_review' } as never), ctx) // a member inherits its group's rules
    await tasks.upsertSubtask(sub('p2', { status: 'blocked' }), ctx)
    await tasks.upsertSubtask(sub('p2', { status: 'todo', title: 'renamed' }), ctx)
    await tasks.addComment({ id: 'c1', taskId: 't1', author: 'x', body: 'hi', createdAt: ISO } as never)
    expect((await tasks.read()).subtasks.find(s => s.id === 'm')!.status).toBe('in_review')
  })
})

describe('fail closed: a door that forgot to say who is asking (S2c: the compiler refuses the omission; a cast around it still fails closed at runtime)', () => {
  test('even WITH full evidence, a raising write carrying no context is refused guard_context_required', async () => {
    const { world, tasks } = await setup()
    await attachAll(world.svc)
    const before = bytes()
    const e = await refusal(() => tasks.upsertSubtask(sub('p1', { status: 'in_review' }), undefined as never))
    expect(e).toMatchObject({ code: 'guard_context_required', status: 422 })
    expect(bytes()).toEqual(before)
  })
  test('the delivery store fails closed the same way', async () => {
    const { world, deliveries } = await setup()
    await attachAll(world.svc)
    const before = bytes()
    const e = await refusal(() => deliveries.update(doc => { doc.deliveries.p1!.phase = 'revisao_lider' }, { guard: undefined as never }))
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
    await tasks.upsertSubtask(sub('p3'), unattributedContext())
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
    await expect(deliveries.update(doc => { doc.deliveries.p1!.phase = 'publicado' }, { guard: unattributedContext(), evidence: true, guardsPath: join(root, 'other-guards.json') })).rejects.toBeInstanceOf(GuardLockOrderError)
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
      await Promise.all([deliveries.update(async doc => { await Bun.sleep(15); doc.deliveries.p1!.branch = 'branch' }, { guard: unattributedContext() }), otherDeliveries.update(doc => { doc.deliveries.p1!.qaModel = 'QA' }, { guard: unattributedContext() })])
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
    expect((await refusal(() => deliveries.update(doc => { doc.deliveries.p1!.phase = 'publicado' }, { guard: undefined as never, evidence: true }))).code).toBe('guard_context_required')
    expect(bytes()).toEqual(before)
  })
  test('F4: advanced adoption and same-rank relinking require authorization', async () => {
    const { world, deliveries } = await setup()
    await world.svc.ensure('p1')
    const before = bytes()
    await refusal(() => deliveries.update(doc => { doc.deliveries.p2 = { ...doc.deliveries.p1!, subtaskId: 'p2', phase: 'publicado' } }, { guard: unattributedContext() }))
    expect(bytes()).toEqual(before)
    await attachAll(world.svc)
    await deliveries.update(doc => { doc.deliveries.p1!.phase = 'revisao_lider' }, { guard: ctx })
    const reviewed = bytes()
    await refusal(() => deliveries.update(doc => { doc.deliveries.p1!.taskId = 'another-task' }, { guard: unattributedContext() }))
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
    expect(await tasks.patchTask('t1', { status: 'in_review' }, { guard: unattributedContext(), allowOpenSubtasks: true })).toBe(true)
    await tasks.removeSubtask('p1', { guard: unattributedContext() })
    const before = bytes()
    await refusal(() => tasks.removeSubtask('p2', { guard: unattributedContext() }))
    expect(bytes()).toEqual(before)
  })
  test('F7: adjustment invalidates old evidence even at the same HEAD', async () => {
    const { world, tasks, deliveries } = await setup()
    await attachAll(world.svc)
    await deliveries.update(doc => { const r = doc.deliveries.p1!; r.revision += 2; r.phase = 'qa'; r.history.push({ from: 'qa', to: 'ajuste', at: ISO, actor: 'worker', detail: 'recapture', revision: r.revision - 1 }) }, { guard: unattributedContext() })
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
    await tasks.upsertSubtask(sub('g', { isGroup: true } as never), unattributedContext())
    await tasks.upsertSubtask(sub('m', { parentGroupId: 'g', status: 'in_review' } as never), unattributedContext())
    const before = bytes()
    await refusal(() => tasks.removeSubtask('g', { guard: unattributedContext() }))
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
    await deliveries.update(doc => { doc.deliveries.p1!.phase = 'qa' }, { guard: unattributedContext() })
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

// ── S2a r3 (QA r2 Opus) ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** WRITTEN, or the refusal code — the QA probes' shape. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try { await run(); return 'WRITTEN' } catch (e) { if (e instanceof GuardRefused || e instanceof GuardBusy) return e.code; throw e }
}
const rename = (title: string) => ({ id: 't1', title, status: 'in_progress', createdAt: ISO, updatedAt: ISO }) as never
/** Seal rule A to `state` directly (no lock), the way the F6 probe flips it mid-acquisition. */
async function sealRule(state: 'shadow' | 'on') {
  const g = createGuaranteesStore(join(root, 'guarantees.json'))
  const doc = (await g.read()).doc
  doc.rules.a = { state, build: 'test' }
  await writeSealed(g.path, 'guarantees', doc)
}

describe('r3 N2: rule OFF takes exactly the locks the base took', () => {
  test('OFF-1: another holder on deliveries.json does not delay or refuse a board write (base: tasks lock only)', async () => {
    const { tasks } = await setup({ rule: 'off' })
    const held = await lockFile(join(root, 'deliveries.json'))
    const t0 = Date.now()
    try { expect(await outcome(() => tasks.upsertTask(rename('renamed'), unattributedContext()))).toBe('WRITTEN') } finally { await held.release() }
    expect(Date.now() - t0).toBeLessThan(2000)
    expect((await tasks.read()).tasks[0]!.title).toBe('renamed')
  }, 20_000)
  test('OFF-2: a contended tasks.json lock waits and then WRITES, as withFileLock always did (never guard_busy)', async () => {
    const { tasks } = await setup({ rule: 'off' })
    const held = await lockFile(join(root, 'tasks.json'))
    try { expect(await outcome(() => tasks.upsertTask(rename('renamed'), unattributedContext()))).toBe('WRITTEN') } finally { await held.release() }
    expect((await tasks.read()).tasks[0]!.title).toBe('renamed')
  }, 30_000)
  test('OFF-3: another holder on guards.json delays neither a board write nor a delivery write', async () => {
    const { tasks, deliveries, world } = await setup({ rule: 'off' })
    await world.svc.ensure('p1')
    const held = await lockFile(join(root, 'guards.json'))
    const t0 = Date.now()
    try {
      expect(await outcome(() => tasks.upsertSubtask(sub('p1', { status: 'done' }), unattributedContext()))).toBe('WRITTEN')
      expect(await outcome(() => deliveries.update(doc => { doc.deliveries.p1!.phase = 'publicado' }, { guard: unattributedContext() }))).toBe('WRITTEN')
    } finally { await held.release() }
    expect(Date.now() - t0).toBeLessThan(2000)
  }, 20_000)
  test('OFF-4: a delivery write with tasks.json held elsewhere is not delayed; contended deliveries.json still writes (base)', async () => {
    const { deliveries, world } = await setup({ rule: 'off' })
    await world.svc.ensure('p1')
    const heldTasks = await lockFile(join(root, 'tasks.json'))
    try { expect(await outcome(() => deliveries.update(doc => { doc.deliveries.p1!.branch = 'b1' }, { guard: unattributedContext() }))).toBe('WRITTEN') } finally { await heldTasks.release() }
    const heldDeliveries = await lockFile(join(root, 'deliveries.json'))
    try { expect(await outcome(() => deliveries.update(doc => { doc.deliveries.p1!.branch = 'b2' }, { guard: unattributedContext() }))).toBe('WRITTEN') } finally { await heldDeliveries.release() }
    expect((await deliveries.get('p1'))!.branch).toBe('b2')
  }, 30_000)
  test('ON control: the same holders still fail closed (the envelope is kept under the rule)', async () => {
    const { tasks } = await setup()
    const held = await lockFile(join(root, 'deliveries.json'))
    try { expect(await outcome(() => tasks.upsertTask(rename('renamed'), unattributedContext()))).toBe('guard_busy') } finally { await held.release() }
  }, 20_000)
  test('the activation takes the full envelope: a writer holding the tasks lock makes it fail closed, nothing moves', async () => {
    await setup({ rule: 'off' })
    const held = await lockFile(join(root, 'tasks.json'))
    const g = createGuaranteesStore(join(root, 'guarantees.json'))
    const facts = { now: new Date(T).toISOString(), build: 'test', capabilities: ['S0', 'S1', 'S2', 'S3'], migrated: ['a'] as const, unexplainedWouldRefuse: 0 }
    try {
      await expect(g.setState('a', 'shadow', { check: async () => ({ ok: true, via: 'legacy-browser' }), facts: facts as never })).rejects.toBeInstanceOf(GuardBusy)
    } finally { await held.release() }
    expect(await ruleAState(root)).toBe('off')
  }, 20_000)
  test('a board writer that read OFF and finds the rule moved under its tasks lock retakes the envelope and is judged', async () => {
    const { tasks } = await setup({ rule: 'off' })
    const held = await lockFile(join(root, 'tasks.json'))
    const before = bytes()
    const moving = outcome(() => tasks.upsertSubtask(sub('p1', { status: 'in_review' }), ctx))
    try { await Bun.sleep(150); await sealRule('on') } finally { await held.release() }
    expect(await moving).toBe('evidence_required')
    expect(bytes()).toEqual(before)
  }, 20_000)
  test('a delivery writer that read OFF and finds the rule moved under its lock fails closed (guard_busy), nothing written', async () => {
    const { deliveries, world } = await setup({ rule: 'off' })
    await world.svc.ensure('p1')
    const held = await lockFile(join(root, 'deliveries.json'))
    const before = bytes()
    const moving = outcome(() => deliveries.update(doc => { doc.deliveries.p1!.phase = 'publicado' }, { guard: unattributedContext() }))
    try { await Bun.sleep(150); await sealRule('on') } finally { await held.release() }
    expect(await moving).toBe('guard_busy')
    expect(bytes()).toEqual(before)
  }, 20_000)
})

/** The F7 scenario: valid round-1 evidence, then a reproval → ajuste → back to qa at the SAME HEAD. */
async function afterAdjustment(rule: 'on' | 'off' = 'on') {
  const s = await setup({ rule: rule === 'on' ? 'on' : 'off' })
  await attachAll(s.world.svc)
  await s.deliveries.update(doc => { const r = doc.deliveries.p1!; r.revision += 2; r.phase = 'qa'; r.history.push({ from: 'qa', to: 'ajuste', at: ISO, actor: 'worker', detail: 'recapture', revision: r.revision - 1 }) }, { guard: unattributedContext() })
  return s
}
describe('r3 N1: the capture round cannot be erased by a write without context', () => {
  test('CONTROL: after the adjustment, review with the old round is refused', async () => {
    const { tasks } = await afterAdjustment()
    expect(await outcome(() => tasks.upsertSubtask(sub('p1', { status: 'in_review' }), ctx))).toBe('evidence_required')
  })
  test('GAP-1: stripping the ajuste entry (rank 0, no context) is refused; review stays refused', async () => {
    const { tasks, deliveries } = await afterAdjustment()
    const before = bytes()
    expect(await outcome(() => deliveries.update(doc => { const r = doc.deliveries.p1!; r.history = r.history.filter(h => h.to !== 'ajuste') }, { guard: unattributedContext() }))).toBe('evidence_binding_protected')
    expect(await outcome(() => deliveries.update(doc => { for (const h of doc.deliveries.p1!.history) if (h.to === 'ajuste') h.to = 'qa' }, { guard: unattributedContext() }))).toBe('evidence_binding_protected')
    expect(bytes()).toEqual(before)
    expect(await outcome(() => tasks.upsertSubtask(sub('p1', { status: 'in_review' }), ctx))).toBe('evidence_required')
  })
  test('GAP-2: relabelling old items to the current revision is refused even WITH a context; review stays refused', async () => {
    const { tasks, deliveries } = await afterAdjustment()
    const before = bytes()
    for (const guard of [undefined, ctx]) expect(await outcome(() => deliveries.update(doc => { const r = doc.deliveries.p1!; for (const i of r.evidence ?? []) i.revision = r.revision }, { guard: unattributedContext(), ...(guard ? { guard } : undefined) }))).toBe('evidence_binding_protected')
    expect(bytes()).toEqual(before)
    expect(await outcome(() => tasks.upsertSubtask(sub('p1', { status: 'in_review' }), ctx))).toBe('evidence_required')
  })
  test('GAP-3: copying old captures in as NEW items without a context is refused', async () => {
    const { deliveries } = await afterAdjustment()
    expect(await outcome(() => deliveries.update(doc => { const r = doc.deliveries.p1!; r.evidence = [...(r.evidence ?? []), ...(r.evidence ?? []).map(i => ({ ...i, id: i.id + '-copy', revision: r.revision }))] }, { guard: unattributedContext() }))).toBe('evidence_binding_protected')
  })
  test('OFF control: the same edits are written exactly as the base wrote them', async () => {
    const { deliveries } = await afterAdjustment('off')
    expect(await outcome(() => deliveries.update(doc => { const r = doc.deliveries.p1!; r.history = r.history.filter(h => h.to !== 'ajuste') }, { guard: unattributedContext() }))).toBe('WRITTEN')
  })
  test('the service doors still add and remove evidence (they carry a context)', async () => {
    const { world } = await setup()
    await attachAll(world.svc)
    const id = (await world.svc.get('p1'))!.evidence![0]!.id
    const removed = await world.svc.evidenceRemove('p1', id, 'worker')
    expect(removed.ok, JSON.stringify(removed)).toBe(true)
  })
})

describe('r3 N4: discriminating probes for the surviving mutants', () => {
  test('M6: captures stamped with a revision AFTER the record’s own are not this round’s evidence', async () => {
    const { tasks, deliveries } = await afterAdjustment()
    // Fresh bytes isolate the upper revision bound: reusing the old captures is independently refused by Q1.
    expect(await outcome(() => deliveries.update(doc => {
      const r = doc.deliveries.p1!
      const future = [
        { kind: 'screenshot' as const, bytes: png(1280, 800, 31) },
        { kind: 'screenshot' as const, bytes: png(390, 800, 32) },
        { kind: 'probe' as const, probe: { kind: 'bundle' as const, literal: 'fresh-future-literal-of-12+' } },
      ].map(input => {
        const built = buildEvidenceItem(input, { revision: r.revision + 5, headSha: r.evidence![0]!.headSha, treeClean: true, by: 'worker', at: ISO, items: [] })
        if (!built.ok) throw new Error(built.message)
        return built.item
      })
      r.evidence = [...(r.evidence ?? []), ...future]
    }, { guard: ctx }))).toBe('WRITTEN')
    expect(await outcome(() => tasks.upsertSubtask(sub('p1', { status: 'in_review' }), ctx))).toBe('evidence_required')
  })
  test('M4 (§3.5 downgrade): stages an older writer dropped come back from the mirror without being read as progress', async () => {
    const { tasks } = await setup({ rule: 'off' })
    await tasks.upsertSubtask(sub('p2', { status: 'pr_merge' }), unattributedContext())
    await createGuaranteesStore(join(root, 'guarantees.json')).writeStatusStages((await tasks.read()).statuses)
    const g = createGuaranteesStore(join(root, 'guarantees.json'))
    const check = async () => ({ ok: true as const, via: 'legacy-browser' as const })
    const facts = (now: string): ActivationFacts => ({ now, build: 'test', capabilities: ['S0', 'S1', 'S2', 'S3'], migrated: ['a'], unexplainedWouldRefuse: 0 })
    expect(await g.setState('a', 'shadow', { check, facts: facts(new Date(T - 25 * 3600_000).toISOString()) })).toEqual({ ok: true })
    expect(await g.setState('a', 'on', { check, facts: facts(new Date(T).toISOString()) })).toEqual({ ok: true })
    // The v2.210.1 writer: every status loses its stored stage.
    const raw = JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8'))
    for (const s of raw.statuses) delete s.stage
    writeFileSync(join(root, 'tasks.json'), JSON.stringify(raw, null, 2))
    const stages = Object.fromEntries(DEFS.map(d => [(d as unknown as { id: string }).id, (d as unknown as { stage: string }).stage]))
    expect(await outcome(() => tasks.setStatusStages(stages))).toBe('WRITTEN')
    expect((await tasks.read()).statuses.find(s => s.id === 'pr_merge')!.stage).toBe('merge')
  })
})
