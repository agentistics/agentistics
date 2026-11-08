import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeliveryStoreUnreadable, createDeliveryStore, parseDeliveryDocStrict } from './store'
import { newDelivery } from './machine'
import { createDeliveryService } from './service'

let dir: string
let file: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'delivery-store-')); file = join(dir, 'deliveries.json') })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const rec = (id: string) => newDelivery({ subtaskId: id, taskId: 't1', at: '2026-11-07T00:00:00Z' })

describe('M4 — an unreadable store is never zeroed', () => {
  test('a corrupt file keeps its bytes, writes are refused, a copy is kept', async () => {
    const store = createDeliveryStore(file)
    await store.update(doc => { doc.deliveries.s1 = rec('s1') })
    const good = readFileSync(file, 'utf8')
    writeFileSync(file, good.slice(0, good.length - 40)) // torn
    const torn = readFileSync(file, 'utf8')
    let thrown: unknown
    await store.update(doc => { doc.deliveries.s2 = rec('s2') }).catch(e => { thrown = e })
    expect(thrown).toBeInstanceOf(DeliveryStoreUnreadable)
    expect(readFileSync(file, 'utf8')).toBe(torn)
    expect(readFileSync(`${file}.unreadable.bak`, 'utf8')).toBe(torn)
    // Reads stay available (and empty): a read never destroys anything.
    expect(await store.get('s1')).toBeNull()
  })

  test('an empty file is unreadable too, a missing file is simply a new book', async () => {
    const store = createDeliveryStore(file)
    await store.update(doc => { doc.deliveries.s1 = rec('s1') })
    expect(existsSync(file)).toBe(true)
    writeFileSync(file, '')
    await expect(store.update(() => 1)).rejects.toBeInstanceOf(DeliveryStoreUnreadable)
    rmSync(file); rmSync(`${file}.unreadable.bak`, { force: true })
    await store.update(doc => { doc.deliveries.s9 = rec('s9') })
    expect((await store.get('s9'))!.subtaskId).toBe('s9')
  })

  test('a record this build cannot read (a newer phase) survives a write verbatim', async () => {
    const store = createDeliveryStore(file)
    await store.update(doc => { doc.deliveries.s1 = rec('s1') })
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    doc.deliveries.future = { ...rec('future'), phase: 'auditoria' }
    writeFileSync(file, JSON.stringify(doc))
    expect(parseDeliveryDocStrict(readFileSync(file, 'utf8')).deliveries.future).toBeUndefined()
    await store.update(d => { d.deliveries.s2 = rec('s2') })
    const after = JSON.parse(readFileSync(file, 'utf8'))
    expect(after.deliveries.future.phase).toBe('auditoria')
    expect(Object.keys(after.deliveries).sort()).toEqual(['future', 's1', 's2'])
  })

  test('the service answers 503 store_ilegivel instead of throwing or resetting', async () => {
    const store = createDeliveryStore(file)
    writeFileSync(file, '{ not json')
    const svc = createDeliveryService({
      store, now: () => 0, autonomous: async () => true, emit: async () => {},
      facts: { subtask: async id => ({ id, taskId: 't1', title: id, status: 'todo', groupMember: false, blockedBy: [] }), sessions: async () => [], budgets: async () => [], memoryBytes: async () => 1, topCap: async () => 1, git: async () => '', gh: async () => '{}' },
      board: { setPhaseStatus: async () => ({ ok: true }), setCi: async () => {}, logStep: async () => {}, comment: async () => {}, subtaskFinished: async () => false, stage: async () => ({ ok: true }) },
      notify: { session: async () => true, owner: async () => {} },
    })
    const r = await svc.transition('s1', 'executando', {}, 'owner')
    expect(!r.ok && r.status).toBe(503)
    expect(!r.ok && r.code).toBe('store_ilegivel')
    expect((await svc.tick()).actions).toEqual([]) // nothing readable, nothing written
    expect(readFileSync(file, 'utf8')).toBe('{ not json')
  })
})
