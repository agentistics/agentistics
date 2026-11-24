/**
 * S2c.2 — under rule ON a DELETION needs a proven principal (QA S2c.1, ressalva 3).
 *
 * `unattributed` (no proof at all), a missing context and a forged session are refused at the store, and therefore at every
 * door that reaches it (REST, MCP, CLI). A person's request is resolved by the door (owner) and a verified session passes.
 * Rule OFF is untouched: the same deletions land as before.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGuaranteesStore, type ActivationFacts } from './activation'
import { execGit, forgetClassifyCache } from './classify-host'
import { GuardRefused, unattributedContext, type GuardContext } from './guard'
import { deleteTaskRequest, removeSubtaskRequest } from './web'
import { guardContextOfRequest } from './request-deps'
import { T, makeWorld } from './evidence-world.testing'
import { createTaskStore } from '../sessions/task-store'
import type { Subtask, Task } from '../sessions/task-model'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'guard-del-')); forgetClassifyCache() })
afterEach(() => rmSync(root, { recursive: true, force: true }))

const ISO = '2026-11-13T09:00:00.000Z'
const def = (id: string, label: string, stage: string, order: number, prot = false) => ({ id, label, color: '#112233', protected: prot, order, stage }) as never
const DEFS = [def('todo', 'To do', 'queue', 0, true), def('in_progress', 'In progress', 'running', 1, true), def('blocked', 'Blocked', 'blocked', 2, true), def('done', 'Done', 'published', 3, true)]
const task = (id: string): Task => ({ id, title: id, status: 'in_progress', createdAt: ISO, updatedAt: ISO }) as Task
const sub = (id: string, taskId: string): Subtask => ({ id, taskId, title: id, done: false, status: 'in_progress', createdAt: ISO, updatedAt: ISO }) as Subtask

async function setup(rule: 'off' | 'on') {
  const world = makeWorld(root)
  const tasks = createTaskStore(join(root, 'tasks.json'), { guard: { deps: { sessions: async () => world.sessions, git: execGit }, now: () => T } })
  await tasks.seedStatuses(DEFS)
  for (const id of ['t1', 't2', 't3']) await tasks.upsertTask(task(id), unattributedContext())
  for (const id of ['p1', 'p2', 'p3']) await tasks.upsertSubtask(sub(id, 't1'), unattributedContext())
  if (rule === 'on') {
    const g = createGuaranteesStore(join(root, 'guarantees.json'))
    const check = async () => ({ ok: true as const, via: 'legacy-browser' as const })
    const facts = (now: string): ActivationFacts => ({ now, build: 'test', capabilities: ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'], migrated: ['a'], unexplainedWouldRefuse: 0 })
    await g.setState('a', 'shadow', { check, facts: facts(new Date(T - 25 * 3600_000).toISOString()) })
    await g.setState('a', 'on', { check, facts: facts(new Date(T).toISOString()) })
  }
  return tasks
}
const refusedCode = async (run: () => Promise<unknown>): Promise<string> => {
  try { await run() } catch (e) { if (e instanceof GuardRefused) return e.code; throw e }
  return 'went-through'
}
const session = (id: string): GuardContext => ({ principal: { kind: 'session', id, via: 'token' } })
const owner: GuardContext = { principal: { kind: 'owner', via: 'legacy-browser' } }
const noCtx = undefined as unknown as GuardContext

describe('rule ON: the store refuses an unproven principal on both deletions', () => {
  test('unattributed and a missing context are refused guard_context_required; nothing is removed', async () => {
    const tasks = await setup('on')
    for (const ctx of [unattributedContext(), noCtx]) {
      expect(await refusedCode(() => tasks.removeSubtask('p1', { guard: ctx }))).toBe('guard_context_required')
      expect(await refusedCode(() => tasks.removeTask('t2', undefined, { guard: ctx }))).toBe('guard_context_required')
    }
    const book = await tasks.read()
    expect(book.subtasks.some(s => s.id === 'p1')).toBe(true)
    expect(book.tasks.some(t => t.id === 't2')).toBe(true)
  })
  test('a verified session and the owner may delete', async () => {
    const tasks = await setup('on')
    expect(await tasks.removeSubtask('p1', { guard: session('s-ok') })).toBe(true)
    expect(await tasks.removeTask('t2', undefined, { guard: session('s-ok') })).toBe(true)
    expect(await tasks.removeSubtask('p2', { guard: owner })).toBe(true)
    expect(await tasks.removeTask('t3', undefined, { guard: owner })).toBe(true)
  })
})

describe('rule ON: the REST doors', () => {
  const verify = async (id: unknown, token: unknown) => (id === 's-ok' && token === 'good' ? 's-ok' : null)
  const principalDeps = { verify, mode: async () => 'legacy' as const, browser: { loopbackPeer: true, originOwn: false, sameOriginFetch: false } } as never
  const ownerDeps = { verify, mode: async () => 'legacy' as const, browser: { loopbackPeer: true, originOwn: true, sameOriginFetch: true } } as never

  test('a forged session claim is refused 403 unverified_sender before any store call', async () => {
    const out = await guardContextOfRequest({ session: { id: 's-ok', token: 'forged' } }, { verify })
    expect(out.ok).toBe(false)
    if (!out.ok) { expect(out.reply.status).toBe(403); expect((out.reply.body as { error: string }).error).toBe('unverified_sender') }
  })
  test('unattributed (no browser proof) is refused on deleteTask and removeSubtask; the rows stay', async () => {
    const tasks = await setup('on')
    const del = await deleteTaskRequest('t2', {}, unattributedContext(), { del: async (r, c) => tasks.removeTask(r, undefined, { guard: c }), principalDeps })
    expect(del.status).toBe(422)
    expect((del.body as { reason: string }).reason).toBe('guard_context_required')
    const rm = await removeSubtaskRequest('p1', {}, unattributedContext(), { remove: (id, c) => tasks.removeSubtask(id, { guard: c }), principalDeps, legacyOwnerGate: async () => null })
    expect(rm.status).toBe(422)
    expect((rm.body as { reason: string }).reason).toBe('guard_context_required')
    const book = await tasks.read()
    expect(book.tasks.some(t => t.id === 't2') && book.subtasks.some(s => s.id === 'p1')).toBe(true)
  })
  test('the person (same-origin browser) is resolved to the owner and may delete', async () => {
    const tasks = await setup('on')
    const del = await deleteTaskRequest('t2', {}, unattributedContext(), { del: async (r, c) => tasks.removeTask(r, undefined, { guard: c }), principalDeps: ownerDeps })
    expect(del.status).toBe(200)
    const rm = await removeSubtaskRequest('p1', {}, unattributedContext(), { remove: (id, c) => tasks.removeSubtask(id, { guard: c }), principalDeps: ownerDeps, legacyOwnerGate: async () => null })
    expect(rm.status).toBe(200)
  })
  test('a verified session may delete through the doors', async () => {
    const tasks = await setup('on')
    const ctx = session('s-ok')
    expect((await deleteTaskRequest('t2', {}, ctx, { del: async (r, c) => tasks.removeTask(r, undefined, { guard: c }), principalDeps })).status).toBe(200)
    expect((await removeSubtaskRequest('p1', {}, ctx, { remove: (id, c) => tasks.removeSubtask(id, { guard: c }), principalDeps, legacyOwnerGate: async () => null })).status).toBe(200)
  })
})

describe('rule OFF: unchanged', () => {
  test('unattributed deletions land as before', async () => {
    const tasks = await setup('off')
    expect(await tasks.removeSubtask('p1', { guard: unattributedContext() })).toBe(true)
    expect(await tasks.removeTask('t2', undefined, { guard: noCtx })).toBe(true)
  })
})
