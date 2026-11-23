import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGuaranteesStore } from './activation'
import { createDeliveryStore } from './store'
import { createTaskStore } from '../sessions/task-store'
import { rawWriters, storeReach, testOnlyImports } from './guard-ast.testing'
import { forgetClassifyCache, execGit } from './classify-host'
import { makeWorld, T, shot } from './evidence-world.testing'
import { newDelivery } from './machine'
import { createDeliveryService } from './service'
import * as inventoryAst from './guard-ast.testing'
import { inventoryGrowth, moduleCeiling } from './guard-inventory.testing'
import { GuardRefused } from './guard'
import { withGuardEnvelope } from './guard-transaction'
import { defaultGuardLockPaths } from './guard-locks'
import { productionSources } from './lint-scan.testing'
import { unattributedContext } from './guard'

const ctx = { principal: { kind: 'unattributed' as const } }
const at = new Date(T).toISOString()
const sub = (status: string) => ({ id: 'p1', taskId: 't1', title: 'p1', status, done: false, createdAt: at, updatedAt: at }) as never
async function world(run: (s: any) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'qa-r3-codex-'))
  try {
    forgetClassifyCache()
    const w = makeWorld(root)
    const deps = { sessions: async () => w.sessions, git: execGit }
    const tasks = createTaskStore(join(root, 'tasks.json'), { guard: { deps, now: () => T } })
    await tasks.upsertTask({ id: 't1', title: 't1', status: 'in_progress', createdAt: at, updatedAt: at } as never, unattributedContext())
    await tasks.upsertSubtask(sub('in_progress'), unattributedContext())
    const g = createGuaranteesStore(join(root, 'guarantees.json'))
    const check = async () => ({ ok: true as const, via: 'legacy-browser' as const })
    const facts = (now: string) => ({ now, build: 'test', capabilities: ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'], migrated: ['a'], unexplainedWouldRefuse: 0 }) as never
    expect(await g.setState('a', 'shadow', { check, facts: facts(new Date(T - 25 * 3600000).toISOString()) })).toEqual({ ok: true })
    expect(await g.setState('a', 'on', { check, facts: facts(at) })).toEqual({ ok: true })
    const deliveries = createDeliveryStore(join(root, 'deliveries.json'), { guard: { deps, now: () => T } })
    await run({ root, w, tasks, deliveries })
  } finally { rmSync(root, { recursive: true, force: true }) }
}
async function result(fn: () => Promise<unknown>) { try { await fn(); return 'WRITTEN' } catch (e: any) { return e.code ?? e.message } }
async function adjustment(s: any) {
  for (const input of [shot(1280, 1), shot(390, 2), { kind: 'probe', probe: { kind: 'bundle', literal: 'a-literal-of-12+' } }]) expect((await s.w.svc.evidenceAdd('p1', input, 'worker')).ok).toBe(true)
  await s.deliveries.update((d: any) => { const r = d.deliveries.p1; r.revision += 2; r.phase = 'qa'; r.history.push({ from: 'qa', to: 'ajuste', at, actor: 'worker', detail: 'recapture', revision: r.revision - 1 }) })
}

// Independent r3 attacks, inverted: every attack must be refused before bytes land.
test('Q1 duplicate IDs hide forged current-round copies from append-only checking', async () => world(async s => {
  await adjustment(s)
  expect(await result(() => s.tasks.upsertSubtask(sub('in_review'), ctx))).toBe('evidence_required')
  const attack = await result(() => s.deliveries.update((d: any) => {
    const r = d.deliveries.p1
    r.evidence = [...r.evidence.map((i: any) => ({ ...i, revision: r.revision })), ...r.evidence]
  }))
  const review = await result(() => s.tasks.upsertSubtask(sub('in_review'), ctx))
  console.log('Q1', { attack, review })
  expect([attack, review]).toEqual(['evidence_binding_protected', 'evidence_required'])
}))

test('Q2 preserved records are serialized after the guard and bypass advanced creation', async () => world(async s => {
  const attack = await result(() => s.deliveries.update((d: any) => {
    d.preserved = { p1: newDelivery({ subtaskId: 'p1', taskId: 't1', phase: 'publicado', at }) }
  }))
  const phase = (await s.deliveries.get('p1'))?.phase
  console.log('Q2', { attack, phase })
  expect([attack, phase]).toEqual(['guard_context_required', undefined])
}))

test('Q3 context-bearing delete/recreate erases round history and lowers revision', async () => world(async s => {
  await adjustment(s)
  const original = (await s.deliveries.get('p1'))!
  expect(await result(() => s.tasks.upsertSubtask(sub('in_review'), ctx))).toBe('evidence_required')
  expect(await result(() => s.deliveries.update((d: any) => { delete d.deliveries.p1 }, { guard: ctx }))).toBe('WRITTEN')
  const bytes = readFileSync(s.deliveries.path, 'utf8')
  // Reopen the store: the tombstone is durable, not an in-memory cache.
  const reopened = createDeliveryStore(s.deliveries.path)
  expect(await result(() => reopened.update((d: any) => { d.deliveries.p1 = { ...original, revision: 1 } }, { guard: ctx }))).toBe('evidence_binding_protected')
  expect(await result(() => reopened.update((d: any) => { d.deliveries.p1 = { ...original, history: [] } }, { guard: ctx }))).toBe('evidence_binding_protected')
  expect(await result(() => reopened.update((d: any) => { d.deliveries.p1 = { ...original, revision: 1, history: [] } }, { guard: ctx }))).toBe('evidence_binding_protected')
  expect(readFileSync(s.deliveries.path, 'utf8')).toBe(bytes)
  const review = await result(() => s.tasks.upsertSubtask(sub('in_review'), ctx))
  console.log('Q3', { review })
  expect(review).toBe('evidence_required')
  expect(await result(() => s.deliveries.update((d: any) => { d.deliveries.p1 = original }, { guard: ctx }))).toBe('WRITTEN')
  expect(await result(() => s.tasks.upsertSubtask(sub('in_review'), ctx))).toBe('evidence_required')
}))

const mutants: Record<string, string> = {
  'Q4 Worker constructor executes arbitrary child file': "import { Worker } from 'node:worker_threads'; new Worker(new URL('./writer.testing.ts', import.meta.url))",
  'Q5 fs method call receiver with env-computed target': "import fs from 'node:fs'; fs.writeFileSync.call(fs, process.env['BOOK_PATH'], '{}')",
  'Q6 computed dynamic import invokes destructured callback': "const fs = await import(process.env['FS_MODULE']); const put = fs['writeFileSync']; put(process.env['BOOK_PATH'], '{}')",
  'Q7 createRequire hides module identity': "import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); const fs = load('node:fs'); const put = fs['writeFileSync']; put(process.env['BOOK_PATH'], '{}')",
}
for (const [name, src] of Object.entries(mutants)) test(name, () => {
  const got = { writers: rawWriters(src).length, reach: storeReach(src), imports: testOnlyImports(src) }
  console.log(name, got)
  const capabilities = inventoryAst.moduleCapabilities(src)
  expect(inventoryGrowth({ 'new-module.ts': capabilities }, {}), name).not.toEqual([])
})

test('Q8 service refusal loses the Portuguese sentence on evidenceRemove', async () => {
  const record = { ...newDelivery({ subtaskId: 'p1', taskId: 't1', at }), evidence: [{ id: 'e1', by: 'worker' }] }
  const svc = createDeliveryService({ store: { path: '/tmp/qa-unopened/deliveries.json', get: async () => record, update: async () => {
    throw new GuardRefused({ code: 'evidence_binding_protected', piece: 'p1', missing: [], message: 'English refusal', messagePt: 'Recusa em português' })
  } } } as never)
  const out = await svc.evidenceRemove('p1', 'e1', 'worker')
  console.log('Q8', out)
  expect(out).toMatchObject({ ok: false, status: 422, code: 'evidence_binding_protected', sentence: 'English refusal' })
  expect(out).toMatchObject({ sentencePt: 'Recusa em português' })
})

test('Q1 duplicate evidence IDs are refused even with context and no phase advance', async () => world(async s => {
  await adjustment(s)
  const bytes = readFileSync(s.deliveries.path, 'utf8')
  expect(await result(() => s.deliveries.update((d: any) => {
    const r = d.deliveries.p1
    r.evidence = [...r.evidence.map((i: any) => ({ ...i, revision: r.revision })), ...r.evidence]
  }, { guard: ctx }))).toBe('evidence_binding_protected')
  expect(readFileSync(s.deliveries.path, 'utf8')).toBe(bytes)
}))

test('Q1 a new id cannot rebind an old capture to a new revision, even with context', async () => world(async s => {
  await adjustment(s)
  expect(await result(() => s.deliveries.update((d: any) => {
    const r = d.deliveries.p1
    r.evidence = r.evidence.map((i: any) => ({ ...i, id: i.id + '-new', revision: r.revision }))
  }, { guard: ctx }))).toBe('evidence_binding_protected')
}))

test('Q4–Q7 modules: computed specifiers and read-only fs imports need a pinned module', () => {
  for (const src of [
    "import { readFile } from 'fs/promises'; export const f = readFile",
    "export * from 'node:fs'",
    "import loader = require('module')",
    "const x = require(name)",
    "const x = import(name)",
    "const B = globalThis.Bun; B['write'](path, data)",
    "const worker = new Worker(path)",
  ]) expect(inventoryGrowth({ 'unlisted.ts': inventoryAst.moduleCapabilities(src) }, moduleCeiling()), src).not.toEqual([])
  expect(inventoryAst.moduleCapabilities('// import(name)\nconst s = "Bun.write and require(name)"')).toEqual([])
})

test('OFF explicit envelope retains the base bytes and creates no floor book', async () => {
  const root = mkdtempSync(join(tmpdir(), 'r4-off-envelope-'))
  try {
    const store = createDeliveryStore(join(root, 'deliveries.json'))
    await withGuardEnvelope(defaultGuardLockPaths(root), () => store.update(doc => {
      doc.deliveries.p1 = newDelivery({ taskId: 't1', subtaskId: 'p1', at })
    }, { guard: unattributedContext() }))
    expect(existsSync(join(root, 'guards.json'))).toBe(false)
    expect(existsSync(join(root, 'guard-integrity.key'))).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Q4–Q7 generated production modules also need capability pins', () => {
  const root = mkdtempSync(join(tmpdir(), 'r4-generated-'))
  try {
    writeFileSync(join(root, 'writer.generated.ts'), "import fs from 'node:fs'; fs.writeFileSync.call(fs, path, data)")
    expect(productionSources(root, root)).toContain('writer.generated.ts')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
