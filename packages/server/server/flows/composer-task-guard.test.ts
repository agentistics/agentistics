/**
 * S2c.2b — under rule ON the composer's own rollback removal must succeed BECAUSE it passes `flowContext()`.
 * (QA S2c.2: the mutant "composer removes with an unattributed context" survived — nothing ran this path under the rule.)
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGuaranteesStore, type ActivationFacts } from '../delivery/activation'
import { execGit, forgetClassifyCache } from '../delivery/classify-host'
import { unattributedContext } from '../delivery/guard'
import { T, makeWorld } from '../delivery/evidence-world.testing'
import { createTaskStore } from '../sessions/task-store'
import type { Task } from '../sessions/task-model'
import { registerComposerTask, type ComposerTaskDeps } from './composer-task'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'composer-guard-')); forgetClassifyCache() })
afterEach(() => rmSync(root, { recursive: true, force: true }))

const ISO = '2026-11-13T09:00:00.000Z'
const def = (id: string, label: string, stage: string, order: number) => ({ id, label, color: '#112233', protected: true, order, stage }) as never
const DEFS = [def('todo', 'To do', 'queue', 0), def('in_progress', 'In progress', 'running', 1), def('blocked', 'Blocked', 'blocked', 2), def('done', 'Done', 'published', 3)]

async function ruleOnStore() {
  const world = makeWorld(root)
  const store = createTaskStore(join(root, 'tasks.json'), { guard: { deps: { sessions: async () => world.sessions, git: execGit }, now: () => T } })
  await store.seedStatuses(DEFS)
  await store.upsertTask({ id: 't1', title: 'Delivery', status: 'in_progress', createdAt: ISO, updatedAt: ISO } as Task, unattributedContext())
  const g = createGuaranteesStore(join(root, 'guarantees.json'))
  const check = async () => ({ ok: true as const, via: 'legacy-browser' as const })
  const facts = (now: string): ActivationFacts => ({ now, build: 'test', capabilities: ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'], migrated: ['a'], unexplainedWouldRefuse: 0 })
  await g.setState('a', 'shadow', { check, facts: facts(new Date(T - 25 * 3600_000).toISOString()) })
  await g.setState('a', 'on', { check, facts: facts(new Date(T).toISOString()) })
  return store
}

test('rule ON: a failed pedido link rolls the new subtask back through flowContext()', async () => {
  const store = await ruleOnStore()
  const d: ComposerTaskDeps = {
    now: () => Date.parse('2026-11-09T12:00:00Z'), target: async () => ({ taskId: 't1', conversationId: 'conv' }), store: async () => store,
    emit: async () => ({ status: 'success' }),
    run: async () => ({ status: 'failed' }), // every pedido-link attempt fails → the composer removes the subtask it just created
    sleep: async () => {},
  }
  const r = await registerComposerTask({ id: 'lead', action: 'prompt', text: 'Fix the calendar', messageId: 'msg-1', asTask: { priority: 'high' as const } }, 'en', d)
  expect(r.ok).toBe(false)
  // The removal must have actually happened (a refused removal is also caught and answers the same ok:false).
  expect((await store.read()).subtasks).toHaveLength(0)
})
