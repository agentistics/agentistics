import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGuaranteesStore, type ActivationFacts } from './activation'
import { createDeliveryStore } from './store'
import { createGuardsStore } from './guards-store'
import { createTaskStore } from '../sessions/task-store'
import { effectiveSubtasks } from '../sessions/task-report'
import { boardRaises } from './guard'
import * as ast from './guard-ast.testing'
import { helperInventory, inventoryGrowth } from './guard-inventory.testing'
import { isBuildOutput, productionSources } from './lint-scan.testing'
import { scannedSources } from './guard-inventory.testing'
import { makeWorld, shot, T } from './evidence-world.testing'
import { execGit, forgetClassifyCache } from './classify-host'
import { newDelivery } from './machine'
import { unattributedContext } from './guard'

const at = new Date(T).toISOString()
const ctx = { principal: { kind: 'unattributed' as const } }
const sub = (id: string, extra = {}) => ({ id, taskId: 't1', title: id, status: 'in_progress', done: false, createdAt: at, updatedAt: at, ...extra }) as never
const def = (id: string, stage?: string) => ({ id, label: id, color: '#112233', order: 0, protected: false, ...(stage ? { stage } : {}) }) as never
async function world(run: (s: any) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'guard-r5-'))
  try {
    forgetClassifyCache()
    const w = makeWorld(root)
    const deps = { sessions: async () => w.sessions, git: execGit }
    const tasks = createTaskStore(join(root, 'tasks.json'), { guard: { deps, now: () => T } })
    await tasks.seedStatuses([def('in_progress', 'running'), def('done', 'published'), def('shipped', 'published')])
    await tasks.upsertTask({ id: 't1', title: 't1', status: 'in_progress', createdAt: at, updatedAt: at } as never, unattributedContext())
    await tasks.upsertSubtask(sub('p1'), unattributedContext())
    const g = createGuaranteesStore(join(root, 'guarantees.json'))
    const check = async () => ({ ok: true as const, via: 'legacy-browser' as const })
    const facts = (now: string): ActivationFacts => ({ now, build: 'test', capabilities: ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'], migrated: ['a'], unexplainedWouldRefuse: 0 })
    expect(await g.setState('a', 'shadow', { check, facts: facts(new Date(T - 25 * 3600000).toISOString()) })).toEqual({ ok: true })
    expect(await g.setState('a', 'on', { check, facts: facts(at) })).toEqual({ ok: true })
    await g.writeStatusStages([def('shipped', 'published')])
    const deliveries = createDeliveryStore(join(root, 'deliveries.json'))
    await run({ root, w, tasks, deliveries, g })
  } finally { rmSync(root, { recursive: true, force: true }) }
}
async function result(fn: () => Promise<unknown>) { try { await fn(); return 'WRITTEN' } catch (e: any) { return e.code ?? e.message } }

test('O1 derived group completion is judged under the group identity', () => world(async s => {
  await s.tasks.upsertSubtask(sub('g', { isGroup: true }))
  await s.tasks.upsertSubtask(sub('m1', { parentGroupId: 'g' }))
  await s.tasks.upsertSubtask(sub('m2', { parentGroupId: 'g' }))
  await s.tasks.upsertSubtask(sub('m1', { parentGroupId: 'g', status: 'done' }))
  const bytes = readFileSync(join(s.root, 'tasks.json'), 'utf8')
  expect(await result(() => s.tasks.upsertSubtask(sub('m2', { parentGroupId: 'g', status: 'done' })))) .toBe('guard_context_required')
  expect(readFileSync(join(s.root, 'tasks.json'), 'utf8')).toBe(bytes)
  expect(effectiveSubtasks((await s.tasks.read()).subtasks).find((s: any) => s.id === 'g')!.status).not.toBe('done')
}))

test('O1 valid group evidence authorizes the derived done state and records the group checkpoint', () => world(async s => {
  await s.tasks.upsertSubtask(sub('p1', { isGroup: true }))
  await s.tasks.upsertSubtask(sub('m1', { parentGroupId: 'p1' }))
  for (const input of [shot(1280, 1), shot(390, 2), { kind: 'probe', probe: { kind: 'bundle', literal: 'a-literal-of-12+' } }]) expect((await s.w.svc.evidenceAdd('p1', input, 'worker')).ok).toBe(true)
  expect(await result(() => s.tasks.upsertSubtask(sub('m1', { parentGroupId: 'p1', status: 'done' }), ctx))).toBe('WRITTEN')
  const cp = (await createGuardsStore(join(s.root, 'guards.json')).read()).checkpoints.p1!
  expect(cp).toMatchObject({ key: 'p1', rank: 4, boardStatus: 'done', boardStage: 'published' })
  expect(cp.auth[0]).toMatchObject({ kind: 'evidence' })
}))

test('O2 stage-less status resolves the mirror on BOTH sides before restoration', () => world(async s => {
  await s.tasks.upsertStatus(def('shipped'))
  const bytes = readFileSync(join(s.root, 'tasks.json'), 'utf8')
  expect(await result(() => s.tasks.upsertSubtask(sub('p1', { status: 'shipped' })))).toBe('guard_context_required')
  expect(readFileSync(join(s.root, 'tasks.json'), 'utf8')).toBe(bytes)
  await s.tasks.setStatusStages((await s.g.read()).doc.statusStages)
  expect((await s.tasks.read()).subtasks.find((p: any) => p.id === 'p1').status).toBe('in_progress')
}))

test('MU5 stage-less done still raises both a task and a subtask to published', () => {
  const before = { tasks: [{ id: 't1', status: 'todo' }], subtasks: [], statuses: [] }
  expect(boardRaises(before, { ...before, tasks: [{ id: 't1', status: 'done' }] })).toEqual([{ key: 't1', taskId: 't1', rank: 4 }])
  expect(boardRaises(before, { ...before, subtasks: [sub('p1', { status: 'done' })] })).toEqual([{ key: 'p1', taskId: 't1', subtaskId: 'p1', rank: 4 }])
})

test('O4 production mutable memo cannot become the persisted before image', () => world(async s => {
  const script = `
    const { createTaskStore } = await import(${JSON.stringify(join(import.meta.dir, '../sessions/task-store.ts'))});
    const tasks = createTaskStore(${JSON.stringify(join(s.root, 'tasks.json'))});
    const book = await tasks.read();
    try { book.subtasks.find(s => s.id === 'p1').status = 'done' } catch {}
    let code = 'WRITTEN';
    try { await tasks.addComment({ id: 'c1', taskId: 't1', author: 'x', body: 'hi', createdAt: ${JSON.stringify(at)} }) }
    catch (e) { code = e.code }
    console.log(code);
  `
  const p = Bun.spawn([process.execPath, '-e', script], { env: { ...process.env, NODE_ENV: 'production' }, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  expect(await p.exited, err).toBe(0)
  expect(out.trim()).toBe('guard_context_required')
  expect(JSON.parse(readFileSync(join(s.root, 'tasks.json'), 'utf8')).subtasks.find((p: any) => p.id === 'p1').status).toBe('in_progress')
}))

test('O3 killed between floor seal and rename rolls forward without lowering the floor', () => world(async s => {
  await s.w.svc.ensure('p1'); await s.w.svc.ensure('p2')
  const script = `
    const { createDeliveryStore } = await import(${JSON.stringify(join(import.meta.dir, 'store.ts'))});
    const store = createDeliveryStore(${JSON.stringify(s.deliveries.path)}, { afterFloorSeal: () => process.kill(process.pid, 'SIGKILL') });
    await store.update(d => { const r = d.deliveries.p1; r.revision = 7; r.phase = 'executando'; r.history.push({ from: 'qa', to: 'ajuste', at: ${JSON.stringify(at)}, revision: 6, actor: 'worker' }) }, { guard: ${JSON.stringify(ctx)} });
  `
  const p = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
  const err = new Response(p.stderr).text()
  expect(await p.exited, await err).not.toBe(0)
  // Advance only our dead child's directory lock ages past the stale interval; no real holder is displaced.
  for (const file of ['deliveries.json', 'guards.json']) utimesSync(join(s.root, file + '.lock'), new Date(0), new Date(0))
  const sealed = (await createGuardsStore(join(s.root, 'guards.json')).read()).deliveryFloors!.p1!
  expect(sealed.revision).toBe(7)
  // A new process/store opens the journal; all subsequent writes must remain available.
  const reopened = createDeliveryStore(s.deliveries.path)
  expect((await reopened.get('p1'))!.revision).toBe(7)
  await reopened.update(() => undefined, { guard: ctx })
  await reopened.update(d => { d.deliveries.p2!.updatedAt = at }, { guard: ctx })
  await reopened.update(d => { d.deliveries.p1!.phase = 'ajuste' }, { guard: ctx })
  expect(await s.w.svc.ensure('p3')).toMatchObject({ subtaskId: 'p3' })
  expect((await createGuardsStore(join(s.root, 'guards.json')).read()).deliveryFloors!.p1).toEqual(sealed)
  expect(await result(() => reopened.update(d => { d.deliveries.p1!.revision = 1 }, { guard: ctx }))).toBe('evidence_binding_protected')
}))

test('MU2 first guarded deletion seals the deleted record floor across reopen', () => world(async s => {
  // Simulate an older binary: no guarded write has yet sealed this record's floor.
  const r = newDelivery({ taskId: 't1', subtaskId: 'p1', at })
  r.revision = 7
  r.history.push({ from: 'qa', to: 'ajuste', at, revision: 6, actor: 'worker' } as never)
  writeFileSync(s.deliveries.path, JSON.stringify({ version: 1, deliveries: { p1: r } }))
  await s.deliveries.update((d: any) => { delete d.deliveries.p1 }, { guard: ctx })
  expect((await createGuardsStore(join(s.root, 'guards.json')).read()).deliveryFloors?.p1?.revision).toBe(7)
  const reopened = createDeliveryStore(s.deliveries.path)
  expect(await result(() => reopened.update(d => { d.deliveries.p1 = { ...r, revision: 1 } }, { guard: ctx }))).toBe('evidence_binding_protected')
}))

test('MU3 history-only record cannot be deleted without context', () => world(async s => {
  const r = newDelivery({ taskId: 't1', subtaskId: 'p1', at })
  r.history.push({ from: 'qa', to: 'ajuste', at, revision: 1, actor: 'worker' } as never)
  writeFileSync(s.deliveries.path, JSON.stringify({ version: 1, deliveries: { p1: r } }))
  const bytes = readFileSync(s.deliveries.path, 'utf8')
  expect(await result(() => s.deliveries.update((d: any) => { delete d.deliveries.p1 }))).toBe('evidence_binding_protected')
  expect(readFileSync(s.deliveries.path, 'utf8')).toBe(bytes)
}))

test('O5 dangerous runtime escape hatches are refused outright', () => {
  const forbidden = ast.forbiddenCapabilities
  for (const src of ["eval(code)", "new Function('p', code)", 'Function(code)', "process.binding('fs')", "globalThis['B' + 'un'].write(p, data)", 'Bun[method](p, data)', "(globalThis as any)['B' + 'un'].write(p, data)", "(process as any).binding('fs')", "await (globalThis as any)['B' + 'un'].write(p, data)"]) {
    expect(forbidden(src), src).not.toEqual([])
  }
  expect(forbidden('// eval(code)\nconst text = "Function(code)"')).toEqual([])
})

test('O5 existing raw-writer helper imports in a new module need a shrink-only pin', () => {
  for (const src of ["import { writeSnapshotFile as put } from './data-snapshot'; put(p, data)", "export { writeSnapshotFile } from './data-snapshot'", "const { writeSnapshotFile: put } = await import('./data-snapshot')"]) {
    for (const writer of ["import { writeFile } from 'node:fs/promises'; export const writeSnapshotFile = (p, data) => writeFile(p, data)", "import fs from 'node:fs'; export const writeSnapshotFile = (p, data) => fs.writeFileSync.call(fs, p, data)"]) {
      const sources = { 'data-snapshot.ts': writer, 'new.ts': src }
      expect(inventoryGrowth(helperInventory(sources), {}), src + writer).not.toEqual([])
    }
  }
})

test('O5 shipped target build dist and generated sources are scanned', () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-shipped-'))
  try {
    for (const d of ['target', 'build', 'dist']) {
      mkdirSync(join(root, d))
      writeFileSync(join(root, d, 'writer.generated.js'), "import fs from 'node:fs'; fs.writeFileSync(p, data)")
    }
    expect(productionSources(root, root)).toEqual(['build/writer.generated.js', 'dist/writer.generated.js', 'target/writer.generated.js'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('O5 existing helper imports via workspace or absolute paths also need a module pin', () => {
  for (const spec of ['@agentistics/server/server/data-snapshot', '/repo/packages/server/server/data-snapshot']) {
    const sources = {
      'server/server/data-snapshot.ts': "import fs from 'node:fs'; export const writeSnapshotFile = (p, data) => fs.writeFileSync.call(fs, p, data)",
      'server/server/new.ts': `import { writeSnapshotFile } from '${spec}'; writeSnapshotFile(p, data)`,
    }
    expect(helperInventory(sources, '/repo/packages')['server/server/new.ts'], spec).toEqual(['raw-writer-helper'])
  }
})

test('O5 the release job build outputs of this repo are not source, and only those exact paths', () => {
  for (const rel of ['web/dist/assets/index-abc.js', 'server/server/embedded-dist.generated.ts', 'server/server/engine-slot.generated.ts']) expect(isBuildOutput(rel), rel).toBe(true)
  for (const rel of ['server/server/other.generated.ts', 'server/dist/x.js', 'server/server/data.ts', 'web/src/dist/x.ts']) expect(isBuildOutput(rel), rel).toBe(false)
})

test('O5 the repo-wide scan skips the built web bundle and the generated stubs but keeps real sources and other dist dirs', () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-release-'))
  try {
    const raw = "import fs from 'node:fs'; fs.writeFileSync(p, data)"
    const pkgs = join(root, 'packages')
    mkdirSync(join(root, 'scripts'), { recursive: true })
    for (const f of ['web/dist/assets/y.js', 'server/server/embedded-dist.generated.ts', 'server/server/engine-slot.generated.ts', 'server/server/a.ts', 'mcp/dist/z.js']) {
      mkdirSync(join(pkgs, f, '..'), { recursive: true })
      writeFileSync(join(pkgs, f), raw)
    }
    expect(scannedSources(pkgs)).toEqual(['mcp/dist/z.js', 'server/server/a.ts'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
