/**
 * S2a — the STORE guard, rule A, at the two choke points (spec §2.5): `task-store.ts` `write()` and `delivery/store.ts`
 * `update()`. Real git (throwaway), real tasks.json / deliveries.json / guards.json / guarantees.json in a temp dir, the real
 * guarantee activation primitives. Covers spec §3.5 items 1–7 at the store (every door ends here) and the positive control 20.
 *
 * Every NEGATIVE asserts the exact code AND that tasks.json and deliveries.json are byte-identical after the attempt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGuaranteesStore, type ActivationFacts } from './activation'
import { forgetClassifyCache, execGit } from './classify-host'
import { GuardRefused, type GuardContext } from './guard'
import { createGuardsStore } from './guards-store'
import { createDeliveryStore } from './store'
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
  test('a piece grandfathered at rank 1 moves to pr_merge with no new evidence, but not to done (B is a later slice; A still needed)', async () => {
    const { world, tasks } = await setup()
    await world.svc.ensure('p1')
    const g = createGuardsStore(join(root, 'guards.json'))
    const doc = await g.read()
    await g.write({ ...doc, checkpoints: { p1: { key: 'p1', rank: 1, boardStatus: 'in_review', boardStage: 'leader', phase: null, revision: 1, headSha: null, auth: [{ kind: 'grandfathered', at: ISO }], by: { kind: 'flow' }, at: ISO, transitionId: 'tr-g' } } })
    await tasks.upsertSubtask(sub('p1', { status: 'pr_merge' }), ctx)
    expect((await checkpoints()).p1).toMatchObject({ rank: 2 })
    const e = await refusal(() => tasks.upsertSubtask(sub('p1', { status: 'done' }), ctx))
    expect(e.code).toBe('evidence_required')
  })
})
