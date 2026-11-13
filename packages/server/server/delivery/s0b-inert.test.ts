/**
 * S0b changes NOTHING a user can see: with no guarantees.json the product behaves exactly as today.
 * The proof is two-fold — behaviour (the real stores read/write byte-for-byte as before and create no new file)
 * and structure (nothing on the product's write path imports the new modules yet; the hooks arrive in S2a).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeliveryStore } from './store'
import { newDelivery, type DeliveryRecord } from './machine'
import { createTaskStore } from '../sessions/task-store'
import { RULE_IDS, createGuaranteesStore, ruleState } from './activation'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 's0b-inert-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('no guarantees.json → today\'s behaviour', () => {
  test('every rule is off', async () => {
    const { doc } = await createGuaranteesStore(join(dir, 'guarantees.json')).read()
    for (const r of RULE_IDS) expect(ruleState(doc, r)).toBe('off')
  })

  test('a delivery write and a board write land exactly as before and create NO guards/guarantees file', async () => {
    const dFile = join(dir, 'deliveries.json'); const tFile = join(dir, 'tasks.json')
    const rec: DeliveryRecord = newDelivery({ subtaskId: 's1', taskId: 't1', at: '2026-11-13T00:00:00Z' })
    await createDeliveryStore(dFile).update(doc => { doc.deliveries.s1 = rec })
    expect(JSON.parse(readFileSync(dFile, 'utf8'))).toEqual({ version: 1, deliveries: { s1: rec } })
    // even a rank-raising move (a record to a later phase) is not refused or intercepted
    await createDeliveryStore(dFile).update(doc => { doc.deliveries.s1!.phase = 'publicado' as never })
    expect(JSON.parse(readFileSync(dFile, 'utf8')).deliveries.s1.phase).toBe('publicado')

    const ts = createTaskStore(tFile)
    await ts.upsertTask({ id: 't1', title: 'T', status: 'done', createdAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T00:00:00Z' } as never)
    expect((await ts.read()).tasks[0]!.status).toBe('done')

    expect(readdirSync(dir).sort()).toEqual(['deliveries.json', 'tasks.json'])
    expect(existsSync(join(dir, 'guards.json'))).toBe(false)
    expect(existsSync(join(dir, 'guarantees.json'))).toBe(false)
  })

  test('STRUCTURE: the two stores and the task/delivery doors do not import the new modules in this slice', () => {
    const SERVER = join(import.meta.dir, '..')
    for (const f of ['delivery/store.ts', 'sessions/task-store.ts', 'delivery/service.ts', 'delivery/web.ts', 'delivery/host.ts', 'index.ts']) {
      const src = readFileSync(join(SERVER, f), 'utf8')
      expect(src, f).not.toMatch(/guard-locks|guards-store|['"]\.\/activation['"]|delivery\/activation/)
    }
  })
})
