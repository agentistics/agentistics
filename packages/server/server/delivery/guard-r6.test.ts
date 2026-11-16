import { expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGuaranteesStore, type ActivationFacts } from './activation'
import { createDeliveryStore } from './store'
import { createGuardsStore } from './guards-store'
import { createTaskStore } from '../sessions/task-store'
import { makeWorld, T } from './evidence-world.testing'
import { execGit, forgetClassifyCache } from './classify-host'
import { forbiddenCapabilities, localImports, moduleCapabilities, rawWriters, testOnlyImports } from './guard-ast.testing'
import { helperInventory } from './guard-inventory.testing'

const at = new Date(T).toISOString()
const ctx = { principal: { kind: 'unattributed' as const } }
const check = async () => ({ ok: true as const, via: 'legacy-browser' as const })
const facts = (now = T): ActivationFacts => ({ now: new Date(now).toISOString(), build: 'test', capabilities: ['S0', 'S1', 'S2', 'S3'], migrated: ['a'], unexplainedWouldRefuse: 0 })
async function result(fn: () => Promise<unknown>) { try { await fn(); return 'WRITTEN' } catch (e: any) { return e.code ?? e.message } }
async function world(run: (s: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'guard-r6-'))
  try { await run(await setup(root)) } finally { rmSync(root, { recursive: true, force: true }) }
}
async function setup(root: string) {
  forgetClassifyCache()
  const w = makeWorld(root)
  const deps = { sessions: async () => w.sessions, git: execGit }
  const tasks = createTaskStore(join(root, 'tasks.json'), { guard: { deps, now: () => T } })
  const statuses = ['in_progress', 'shipped'].map((id, i) => ({ id, label: id, color: '#112233', order: i, protected: false, stage: i ? 'published' : 'running' }))
  await tasks.seedStatuses(statuses as never)
  await tasks.upsertTask({ id: 't1', title: 't1', status: 'in_progress', createdAt: at, updatedAt: at } as never)
  await tasks.upsertSubtask({ id: 'p1', taskId: 't1', title: 'p1', status: 'in_progress', done: false, createdAt: at, updatedAt: at })
  const g = createGuaranteesStore(join(root, 'guarantees.json'))
  const move = (to: 'off' | 'shadow' | 'on', now = T) => g.setState('a', to, { check, facts: facts(now) })
  expect(await move('shadow', T - 25 * 3600_000)).toEqual({ ok: true })
  expect(await move('on')).toEqual({ ok: true })
  await g.writeStatusStages(statuses)
  const path = join(root, 'deliveries.json')
  const deliveries = createDeliveryStore(path)
  const faulty = createDeliveryStore(path, { afterFloorSeal: () => { throw new Error('crash') } })
  const guards = createGuardsStore(join(root, 'guards.json'))
  const disk = () => JSON.parse(readFileSync(path, 'utf8')).deliveries
  return { root, w, tasks, g, move, path, deliveries, faulty, guards, disk }
}

for (const state of ['on', 'shadow'] as const) test(`R5-1 J1/J2 journal from ${state} survives OFF edits and reactivation`, () => world(async s => {
  if (state === 'shadow') expect(await s.move('shadow')).toEqual({ ok: true })
  await s.w.svc.ensure('p1'); await s.w.svc.ensure('p2')
  expect(await result(() => s.faulty.update(d => { d.deliveries.p2!.updatedAt = 'X1' }, { guard: ctx }))).toBe('crash')
  expect((await s.guards.read()).pendingDelivery).toBeDefined()
  expect(await s.move('off')).toEqual({ ok: true })
  expect((await s.guards.read()).pendingDelivery).toBeUndefined()
  expect(s.disk().p2.updatedAt).toBe('X1')
  expect((await s.deliveries.get('p2'))!.updatedAt).toBe('X1')
  expect(await s.w.svc.ensure('p3')).toMatchObject({ subtaskId: 'p3' })
  await s.deliveries.update(d => { d.deliveries.p2!.updatedAt = 'X2' })
  expect(await s.move('shadow')).toEqual({ ok: true })
  expect(await s.deliveries.get('p3')).not.toBeNull()
  await s.deliveries.update(() => undefined, { guard: ctx })
  expect(s.disk().p3).toBeDefined()
  expect(s.disk().p2.updatedAt).toBe('X2')
}))

for (const mode of ['ordinary', 'evidence', 'evidence-with-guards'] as const) test(`R5-1 N1 OFF writer rolls forward a present journal before reading; N2 clears it after rename (${mode})`, () => world(async s => {
  await s.w.svc.ensure('p2')
  await s.faulty.update(d => { d.deliveries.p2!.updatedAt = 'X1' }, { guard: ctx }).catch(() => undefined)
  const journal = (await s.guards.read()).pendingDelivery!
  expect(await s.move('off')).toEqual({ ok: true })
  // A restored sealed journal can also be encountered by the OFF writer after a restart.
  const g = await s.guards.read()
  await s.guards.write({ ...g, pendingDelivery: journal })
  const stale = s.disk(); stale.p2.updatedAt = 'OLD'
  writeFileSync(s.path, JSON.stringify({ version: 1, deliveries: stale }))
  await s.deliveries.update(d => { expect(d.deliveries.p2!.updatedAt).toBe('X1'); d.deliveries.p2!.updatedAt = 'X2' }, mode === 'ordinary' ? undefined : { evidence: true, ...(mode === 'evidence-with-guards' ? { guardsPath: s.guards.path } : {}) })
  expect((await s.guards.read()).pendingDelivery).toBeUndefined()
  expect(s.disk().p2.updatedAt).toBe('X2')
  expect(await s.move('shadow')).toEqual({ ok: true })
  await s.deliveries.update(() => undefined, { guard: ctx })
  expect((await s.guards.read()).pendingDelivery).toBeUndefined()
}))

test('R5-2 R1 OFF restore re-seals floors with an audit and leaves a working ledger', () => world(async s => {
  await s.w.svc.ensure('p1'); await s.w.svc.ensure('p2')
  const backup = readFileSync(s.path, 'utf8')
  await s.deliveries.update(d => { const r = d.deliveries.p1!; r.history.push({ from: r.phase, to: 'ajuste', at, revision: r.revision } as never); r.phase = 'ajuste'; r.revision++ }, { guard: ctx })
  expect(await s.move('off')).toEqual({ ok: true })
  writeFileSync(s.path, backup)
  expect(await s.move('shadow', T + 1000)).toEqual({ ok: true })
  expect((await s.guards.read()).deliveryFloors!.p1!.revision).toBe(1)
  const log = (await s.g.read()).doc.log!
  expect(log.at(-1)!.reconciledFloors?.dropped).toEqual(['p1'])
  expect(log.at(-1)!.reconciledFloors?.reason).toContain('off-to-shadow')
  expect(await s.move('on', T + 1000 + 25 * 3600_000)).toEqual({ ok: true })
  expect(await result(() => s.deliveries.update(() => undefined, { guard: ctx }))).toBe('WRITTEN')
  expect(await result(() => s.deliveries.update(d => { d.deliveries.p2!.updatedAt = 'X2' }, { guard: ctx }))).toBe('WRITTEN')
  expect(await s.w.svc.ensure('p3')).toMatchObject({ subtaskId: 'p3' })
  expect(await result(() => s.deliveries.update(d => { d.deliveries.p1!.phase = 'revisao_lider' }))).toBe('guard_context_required')
}))

test('R5-2 floors judge only changed records; unchanged records and phase downgrades never freeze the book', () => world(async s => {
  await s.w.svc.ensure('p1'); await s.w.svc.ensure('p2')
  const backup = readFileSync(s.path, 'utf8')
  await s.deliveries.update(d => { d.deliveries.p1!.revision = 7 }, { guard: ctx })
  writeFileSync(s.path, backup)
  expect(await result(() => s.deliveries.update(() => undefined, { guard: ctx }))).toBe('WRITTEN')
  expect(await result(() => s.deliveries.update(d => { d.deliveries.p2!.updatedAt = 'X' }, { guard: ctx }))).toBe('WRITTEN')
  expect(await result(() => s.deliveries.update(d => {
    const r = d.deliveries.p1!
    r.phase = 'ajuste'; r.updatedAt = 'X'; r.revision++
    r.history.push({ from: 'executando', to: 'ajuste', revision: r.revision, at } as never)
  }, { guard: ctx }))).toBe('WRITTEN')
  expect(await result(() => s.deliveries.update(d => { d.deliveries.p1!.revision = 3 }, { guard: ctx }))).toBe('evidence_binding_protected')
}))

test('R5-3 J3 unreadable guards warn and fall back for reads; writers refuse', () => world(async s => {
  await s.w.svc.ensure('p1')
  writeFileSync(join(s.root, 'guards.json'), '{not json')
  const bytes = readFileSync(s.path, 'utf8')
  expect((await s.deliveries.read()).deliveries.p1).toBeDefined()
  expect((await s.deliveries.readStrict()).deliveries.p1).toBeDefined()
  expect(await s.deliveries.get('p1')).not.toBeNull()
  expect(await result(() => s.deliveries.update(() => undefined))).toBe('guards_unreadable')
  expect(readFileSync(s.path, 'utf8')).toBe(bytes)
}))

test('OFF reads use the base file path after warmup and invalidate on a rule move', () => world(async s => {
  await s.w.svc.ensure('p1')
  expect(await s.move('off')).toEqual({ ok: true })
  const original = fs.readFile
  const reads: string[] = []
  const spy = spyOn(fs, 'readFile').mockImplementation(((path: any, ...args: any[]) => {
    reads.push(String(path)); return (original as any)(path, ...args)
  }) as typeof fs.readFile)
  try {
    await s.deliveries.read()
    expect(reads).toContain(s.path) // verifies instrumentation observes the real read
    reads.length = 0
    for (let i = 0; i < 5; i++) await s.deliveries.read()
    expect(reads).toEqual(Array(5).fill(s.path))
    expect(await s.move('shadow')).toEqual({ ok: true })
    await s.faulty.update(d => { d.deliveries.p1!.updatedAt = 'JOURNAL' }, { guard: ctx }).catch(() => undefined)
    expect((await s.deliveries.get('p1'))!.updatedAt).toBe('JOURNAL')
  } finally { spy.mockRestore() }
}))

test('R5-4 eval references, vm and computed global receivers are forbidden', () => {
  for (const src of ['(0, eval)(code)', 'const run = eval; run(code)', "import vm from 'vm'", "export * from 'node:vm'", "require('vm')", "import('node:vm')", 'global[k]', 'self[k]', '(globalThis!)[k]', '(Bun as any)[k]', '((self as any)!)[k]']) expect(forbiddenCapabilities(src), src).not.toEqual([])
  expect(forbiddenCapabilities('// eval(code)\nconst s = "eval"')).toEqual([])
})

test('R5-4 module loaders participate in capabilities, raw writers, imports and test-only edges', () => {
  for (const loader of ['import.meta.require', 'module.require', 'process.getBuiltinModule']) {
    const src = `const { writeFileSync: put } = ${loader}('node:fs'); put(p, data)`
    expect(moduleCapabilities(src), src).toContain('module:fs')
    expect(rawWriters(src), src).not.toEqual([])
    expect(localImports(`${loader}('./a')`)).toEqual(['./a'])
    expect(testOnlyImports(`${loader}('./a.testing')`)).toEqual(['./a.testing'])
    expect(moduleCapabilities(`${loader}(spec)`)).not.toEqual([])
  }
})

test('R5-5 N3 two-step re-export closure works in either source order', () => {
  const rows: Array<[string, string]> = [['c.ts', "import { put } from './b'; put(p, data)"], ['b.ts', "export * from './a'"], ['a.ts', "export * from './data-snapshot'"], ['data-snapshot.ts', "import fs from 'node:fs'; export const put = (p, d) => fs.writeFileSync(p, d)"]]
  for (const order of [rows, [...rows].reverse()]) expect(helperInventory(Object.fromEntries(order))['c.ts']).toEqual(['raw-writer-helper'])
})

test('R5-5 N4 stripping stage and moving in one write still judges the mirrored stage', () => world(async s => {
  const bytes = readFileSync(join(s.root, 'tasks.json'), 'utf8')
  const script = `
    const { createTaskStore } = await import(${JSON.stringify(join(import.meta.dir, '../sessions/task-store.ts'))});
    const tasks = createTaskStore(${JSON.stringify(join(s.root, 'tasks.json'))});
    const b = await tasks.read();
    for (const status of b.statuses) delete status.stage;
    try { await tasks.upsertSubtask({ ...b.subtasks[0], status: 'shipped' }); console.log('WRITTEN') }
    catch (e) { console.log(e.code) }
  `
  const child = Bun.spawn([process.execPath, '-e', script], { env: { ...process.env, NODE_ENV: 'production' }, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(await child.exited, err).toBe(0)
  expect(out.trim()).toBe('guard_context_required')
  expect(readFileSync(join(s.root, 'tasks.json'), 'utf8')).toBe(bytes)
}))
