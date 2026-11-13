import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeliveryStore } from './store'
import { createDeliveryService } from './service'
import { newDelivery } from './machine'
import { withGuardLocks } from './guard-locks'
import { createGuardsStore } from './guards-store'

async function world(run: (w: any) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'evidence-races-'))
  try {
    const store = createDeliveryStore(join(root, 'deliveries.json'))
    await store.update(doc => { doc.deliveries.p1 = newDelivery({ taskId: 't1', subtaskId: 'p1', phase: 'fila', at: 't' }) })
    const files = new Map(); let n = 0
    const hooks: { create?: () => Promise<void> } = {}
    const svc = createDeliveryService({ store, facts: { sessions: async () => [] }, now: () => 0, guardsPath: join(root, 'guards.json'),
      evidenceFiles: {
        create: async (o: any) => { const id = `f-${++n}`; files.set(id, o); await hooks.create?.(); return id },
        remove: async (id: string) => files.delete(id), read: async () => null,
      },
    } as any)
    await run({ root, store, files, hooks, svc })
  } finally { rmSync(root, { recursive: true, force: true }) }
}
const upload = { kind: 'test-log', bytesBase64: Buffer.from('1 pass\n0 fail\n').toString('base64') }

test('F6 persist exception rolls back the uploaded TaskFile', async () => world(async ({ store, files, hooks, svc }) => {
  hooks.create = async () => { store.update = async () => { throw new Error('injected persist failure') } }
  await expect(svc.evidenceAdd('p1', upload, 'owner')).rejects.toThrow('injected persist failure')
  expect(files.size).toBe(0)
}))

test('F4 revision changing during upload refuses the stale item and rolls it back', async () => world(async ({ store, files, hooks, svc }) => {
  hooks.create = async () => { await store.update((doc: any) => { doc.deliveries.p1.revision = 2 }) }
  expect(await svc.evidenceAdd('p1', upload, 'owner')).toMatchObject({ ok: false, status: 409 })
  expect((await svc.get('p1')).evidence ?? []).toHaveLength(0)
  expect(files.size).toBe(0)
}))

test('F7 simultaneous identical attaches return one evidence id and retain one file/history entry', async () => world(async ({ files, hooks, svc }) => {
  let count = 0; let release!: () => void
  const bothCreated = new Promise<void>(r => { release = r })
  hooks.create = async () => { if (++count === 2) release(); await bothCreated }
  const results = await Promise.all([svc.evidenceAdd('p1', upload, 'owner'), svc.evidenceAdd('p1', upload, 'owner')])
  expect(results.every(r => r.ok)).toBe(true)
  expect(results[0].evidence.id).toBe(results[1].evidence.id)
  expect((await svc.get('p1')).evidence).toHaveLength(1)
  expect((await svc.get('p1')).evidenceHistory).toHaveLength(1)
  expect(files.size).toBe(1)
}))

test('F4 the same hash cannot be committed at two revisions by an upload race', async () => world(async ({ store, hooks, svc }) => {
  hooks.create = async () => {
    hooks.create = undefined
    await store.update((doc: any) => { doc.deliveries.p1.revision = 2 })
    expect((await svc.evidenceAdd('p1', upload, 'owner')).ok).toBe(true)
  }
  expect((await svc.evidenceAdd('p1', upload, 'owner')).ok).toBe(false)
  expect((await svc.get('p1')).evidenceHistory.map((x: any) => x.revision)).toEqual([2])
}))

for (const corrupt of ['invalid JSON', 'I/O error']) test(`F2 ${corrupt} deliveries refuses backing file deletion`, async () => world(async ({ root, svc }) => {
  const added = await svc.evidenceAdd('p1', upload, 'owner')
  const path = join(root, 'deliveries.json')
  if (corrupt === 'invalid JSON') writeFileSync(path, '{invalid')
  else { rmSync(path); mkdirSync(path) }
  expect(await svc.evidenceFileInUse(added.evidence.fileId)).toBe(true)
}))

test('F3 a pending intent protects its evidence before checkpoint commit', async () => world(async ({ root, svc, files }) => {
  const added = await svc.evidenceAdd('p1', upload, 'owner')
  writeFileSync(join(root, 'guards.json'), JSON.stringify({ version: 1, checkpoints: {}, intents: {
    p1: { transitionId: 'tr-1', target: { key: 'p1', auth: [{ kind: 'evidence', ids: [added.evidence.id] }] } },
  } }))
  expect(await svc.evidenceFileInUse(added.evidence.fileId)).toBe(true)
  expect(await svc.evidenceRemove('p1', added.evidence.id, 'owner')).toMatchObject({ ok: false, code: 'evidence_in_use' })
  expect(files.size).toBe(1)
}))

test.todo('F5 S0a dependency: MCP add/remove without a session proof must refuse before transport', () => {})

test('F3 evidence removal rechecks after a checkpoint writer holding the shared locks', async () => world(async ({ root, svc, store, files }) => {
  const added = await svc.evidenceAdd('p1', upload, 'owner')
  let acquired!: () => void, release!: () => void, updateStarted!: () => void
  const held = new Promise<void>(r => { acquired = r })
  const continueWriter = new Promise<void>(r => { release = r })
  const updating = new Promise<void>(r => { updateStarted = r })
  const writer = withGuardLocks(['deliveries', 'guards'], async () => {
    acquired(); await continueWriter
    await createGuardsStore(join(root, 'guards.json')).write({ version: 1, checkpoints: {
      p1: { key: 'p1', rank: 1, transitionId: 'tr', auth: [{ kind: 'evidence', ids: [added.evidence.id], sha256: [added.evidence.sha256] }] } as any,
    }, intents: {} })
  }, { paths: { tasks: join(root, 'tasks.json'), deliveries: store.path, guards: join(root, 'guards.json') } })
  await held
  const update = store.update.bind(store)
  store.update = (fn: any, options: any) => { updateStarted(); return update(fn, options) }
  const removal = svc.evidenceRemove('p1', added.evidence.id, 'owner')
  await updating
  release(); await writer
  expect(await removal).toMatchObject({ ok: false, code: 'evidence_in_use' })
  expect(files.size).toBe(1)
  expect((await svc.get('p1')).evidence).toHaveLength(1)
}))
