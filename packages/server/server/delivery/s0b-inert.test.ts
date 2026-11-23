/**
 * S0b changes NOTHING a user can see: with no guarantees.json the product behaves exactly as today.
 * The proof is two-fold — behaviour (the real stores read/write byte-for-byte as before and create no new file)
 * and structure (the S2a hooks mediate writes; stores never activate rules by themselves).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeliveryStore } from './store'
import { newDelivery, type DeliveryRecord } from './machine'
import { createTaskStore } from '../sessions/task-store'
import { RULE_IDS, createGuaranteesStore, ruleState } from './activation'
import { unattributedContext } from './guard'

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
    await createDeliveryStore(dFile).update(doc => { doc.deliveries.s1 = rec }, { guard: unattributedContext() })
    expect(JSON.parse(readFileSync(dFile, 'utf8'))).toEqual({ version: 1, deliveries: { s1: rec } })
    // even a rank-raising move (a record to a later phase) is not refused or intercepted
    await createDeliveryStore(dFile).update(doc => { doc.deliveries.s1!.phase = 'publicado' as never }, { guard: unattributedContext() })
    expect(JSON.parse(readFileSync(dFile, 'utf8')).deliveries.s1.phase).toBe('publicado')

    const ts = createTaskStore(tFile)
    await ts.upsertTask({ id: 't1', title: 'T', status: 'done', createdAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T00:00:00Z' } as never, unattributedContext())
    expect((await ts.read()).tasks[0]!.status).toBe('done')

    expect(readdirSync(dir).sort()).toEqual(['deliveries.json', 'tasks.json'])
    expect(existsSync(join(dir, 'guards.json'))).toBe(false)
    expect(existsSync(join(dir, 'guarantees.json'))).toBe(false)
  })

  test('STRUCTURE S2a: doors use guarded stores; stores do not activate rules or write intents directly', () => {
    const SERVER = join(import.meta.dir, '..')
    for (const f of ['delivery/web.ts', 'delivery/host.ts', 'index.ts']) {
      const src = readFileSync(join(SERVER, f), 'utf8')
      expect(src, f).not.toMatch(/guard-locks|guards-store|['"]\.\/activation['"]|delivery\/activation/)
    }
    // S2a: authenticated activation reads (including stage mirror restoration) are allowed; rule changes are not.
    for (const f of ['delivery/store.ts', 'sessions/task-store.ts']) {
      const src = readFileSync(join(SERVER, f), 'utf8')
      expect(src).not.toMatch(/applyGuardedWrite|beginIntent|commitIntent|\bsetState\s*\(/)
      expect(src).toMatch(/guardedWrite/)
      expect(src).toMatch(/guard-transaction/)
    }
    const svc = readFileSync(join(SERVER, 'delivery/service.ts'), 'utf8')
    expect(svc).not.toMatch(/applyGuardedWrite|withGuardLocks|['"]\.\/activation['"]|beginIntent|commitIntent/)
    expect(svc).toMatch(/import \{ createGuardsStore, defaultGuardsPath \} from '\.\/guards-store'/)
  })
})
