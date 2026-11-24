/**
 * S2c — `GuardContext` is a REQUIRED parameter at every guarded write door, so the compiler is the inventory.
 *
 * Three things are pinned here:
 *   1. TYPE LEVEL — each `@ts-expect-error` is a door that must keep refusing to compile without a context. If a parameter
 *      is made optional again, the directive becomes "unused" and `tsc` (the pre-commit hook, CI) fails. The function is
 *      never called: this is a compile-time assertion.
 *   2. RUNTIME, rule ON — an omitted context (a cast around the compiler) and a FORGED one (a principal the caller minted
 *      for itself, carrying no evidence) are both refused by the store before a byte lands.
 *   3. RUNTIME, rule OFF (no guarantees.json) — the explicit contexts change nothing: the same writes land as before.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGuaranteesStore, type ActivationFacts } from './activation'
import { execGit, forgetClassifyCache } from './classify-host'
import { GuardRefused, unattributedContext, type GuardContext } from './guard'
import { createDeliveryStore } from './store'
import { T, makeWorld } from './evidence-world.testing'
import { createTaskStore, type TaskStore } from '../sessions/task-store'
import type { Subtask, Task } from '../sessions/task-model'
import { deleteTask, markTask, patchSubtask, removeSubtask, setSubtaskCi, setSubtaskDone } from '../sessions/task-web'

/** Never called. Every line below must FAIL to compile; `@ts-expect-error` turns "it compiles" into the failure. */
export async function requiredAtEveryDoor(tasks: TaskStore, deliveries: ReturnType<typeof createDeliveryStore>, task: Task, sub: Subtask) {
  // @ts-expect-error upsertTask needs a GuardContext
  await tasks.upsertTask(task)
  // @ts-expect-error upsertSubtask needs a GuardContext
  await tasks.upsertSubtask(sub)
  // @ts-expect-error registerComposerSubtask needs a GuardContext
  await tasks.registerComposerSubtask(sub)
  // @ts-expect-error patchTask needs the options object carrying a guard
  await tasks.patchTask('t1', { status: 'done' })
  // @ts-expect-error patchTask's options must carry the guard
  await tasks.patchTask('t1', { status: 'done' }, { allowOpenSubtasks: true })
  // @ts-expect-error the delivery store's update needs its options (and the guard in them)
  await deliveries.update(() => 1)
  // @ts-expect-error the delivery store's options must carry the guard
  await deliveries.update(() => 1, { evidence: true })
  // @ts-expect-error patchSubtask needs a GuardContext
  await patchSubtask('s1', { status: 'done' })
  // @ts-expect-error setSubtaskDone needs a GuardContext
  await setSubtaskDone('s1', true)
  // @ts-expect-error setSubtaskCi needs a GuardContext
  await setSubtaskCi('s1', null)
  // @ts-expect-error markTask needs its options (and the guard in them)
  await markTask('t1', 'done', 'me')
  // @ts-expect-error markTask's options must carry the guard
  await markTask('t1', 'done', 'me', {})
  // @ts-expect-error removeSubtask needs the options object carrying a guard
  await tasks.removeSubtask('s1')
  // @ts-expect-error removeSubtask's options must carry the guard
  await tasks.removeSubtask('s1', {})
  // @ts-expect-error removeTask needs the options object carrying a guard
  await tasks.removeTask('t1')
  // @ts-expect-error removeTask's options must carry the guard
  await tasks.removeTask('t1', undefined, {})
  // @ts-expect-error deleteTask needs a GuardContext
  await deleteTask('t1')
  // @ts-expect-error the web removeSubtask needs a GuardContext
  await removeSubtask('s1')
}

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'guard-required-')); forgetClassifyCache() })
afterEach(() => rmSync(root, { recursive: true, force: true }))

const ISO = '2026-11-13T09:00:00.000Z'
const def = (id: string, label: string, stage: string, order: number, prot = false) => ({ id, label, color: '#112233', protected: prot, order, stage }) as never
const DEFS = [
  def('todo', 'To do', 'queue', 0, true), def('in_progress', 'In progress', 'running', 1, true), def('blocked', 'Blocked', 'blocked', 2, true), def('done', 'Done', 'published', 3, true),
  def('in_review', 'In review', 'leader', 4),
]
const sub = (id: string, over: Partial<Subtask> = {}): Subtask => ({ id, taskId: 't1', title: id, done: false, status: 'in_progress', createdAt: ISO, updatedAt: ISO, ...over }) as Subtask

async function setup(rule: 'off' | 'on') {
  const world = makeWorld(root)
  const deps = { sessions: async () => world.sessions, git: execGit }
  const tasks = createTaskStore(join(root, 'tasks.json'), { guard: { deps, now: () => T } })
  await tasks.seedStatuses(DEFS)
  await tasks.upsertTask({ id: 't1', title: 't1', status: 'in_progress', createdAt: ISO, updatedAt: ISO } as never, unattributedContext())
  await tasks.upsertSubtask(sub('p1'), unattributedContext())
  if (rule === 'on') {
    const g = createGuaranteesStore(join(root, 'guarantees.json'))
    const check = async () => ({ ok: true as const, via: 'legacy-browser' as const })
    const facts = (now: string): ActivationFacts => ({ now, build: 'test', capabilities: ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'], migrated: ['a'], unexplainedWouldRefuse: 0 })
    expect(await g.setState('a', 'shadow', { check, facts: facts(new Date(T - 25 * 3600_000).toISOString()) })).toEqual({ ok: true })
    expect(await g.setState('a', 'on', { check, facts: facts(new Date(T).toISOString()) })).toEqual({ ok: true })
  }
  const deliveries = createDeliveryStore(join(root, 'deliveries.json'), { guard: { deps, now: () => T } })
  return { world, tasks, deliveries }
}
const tasksBytes = () => readFileSync(join(root, 'tasks.json'), 'utf8')
async function refusal(run: () => Promise<unknown>): Promise<GuardRefused> {
  try { await run() } catch (e) { if (e instanceof GuardRefused) return e; throw e }
  throw new Error('expected a GuardRefused, the write went through')
}

describe('rule ON: an omitted or forged context cannot raise a piece', () => {
  test('a cast around the compiler (no context at all) is refused guard_context_required, nothing written', async () => {
    const { tasks } = await setup('on')
    const before = tasksBytes()
    const e = await refusal(() => tasks.upsertSubtask(sub('p1', { status: 'in_review' }), undefined as unknown as GuardContext))
    expect(e.code).toBe('guard_context_required')
    expect(tasksBytes()).toBe(before)
  })
  test('a forged owner principal carrying no evidence is refused evidence_required, nothing written', async () => {
    const { tasks } = await setup('on')
    const before = tasksBytes()
    for (const principal of [{ kind: 'owner', via: 'legacy-browser' }, { kind: 'session', id: 'forged', via: 'token' }, { kind: 'flow', engine: 'entrega' }] as const) {
      const e = await refusal(() => tasks.upsertSubtask(sub('p1', { status: 'in_review' }), { principal } as GuardContext))
      expect(e.code, JSON.stringify(principal)).toBe('evidence_required')
    }
    expect(tasksBytes()).toBe(before)
  })
})

describe('rule OFF (no guarantees.json): the explicit context changes nothing', () => {
  test('both stores write exactly as before and create no guard file', async () => {
    const { world, tasks, deliveries } = await setup('off')
    await tasks.upsertSubtask(sub('p1', { status: 'in_review' }), unattributedContext())
    await tasks.patchTask('t1', { status: 'done' }, { guard: unattributedContext() })
    expect((await tasks.read()).subtasks.find(s => s.id === 'p1')!.status).toBe('in_review')
    await world.svc.ensure('p1')
    await deliveries.update(doc => { doc.deliveries.p1!.phase = 'revisao_lider' }, { guard: unattributedContext() })
    expect((await deliveries.get('p1'))!.phase).toBe('revisao_lider')
    for (const f of ['guards.json', 'guarantees.json', 'guard-integrity.key']) expect(existsSync(join(root, f)), f).toBe(false)
  })
})
