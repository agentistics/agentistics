import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeliveryStore } from './store'
import { newDelivery } from './machine'
import { oldWriterRoundTrip, parseV2210 } from './store-v2210.fixture'
import { loadV2210, oldBoardRoundTrip } from '../sessions/task-store-v2210.fixture'
import { createTaskStore } from '../sessions/task-store'
import { createGuaranteesStore, restoreStatusStages, type OwnerCheck } from './activation'
import { beginIntent, commitIntent, createGuardsStore, emptyGuards, type PieceCheckpoint } from './guards-store'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'downgrade-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const owner: OwnerCheck = async () => ({ ok: true, via: 'vault-credential' })
const T = '2026-11-13T00:00:00.000Z'

describe('deliveries.json: new code → v2.210.1 writer → intact (§2.7)', () => {
  test('record-level evidence / custody / verification survive an old writer; so does the unrelated record', async () => {
    const file = join(dir, 'deliveries.json')
    const store = createDeliveryStore(file)
    await store.update(doc => {
      const a = newDelivery({ subtaskId: 's-a', taskId: 't1', at: T }) as unknown as Record<string, unknown>
      a.evidence = [{ id: 'ev-0123456789ab', kind: 'screenshot', sha256: 'f'.repeat(64), revision: 1, headSha: 'abc', treeClean: true }]
      a.custody = { custodian: 'sess-1', since: T }
      a.verification = { jobId: 'vj-1', strength: 'strong' }
      doc.deliveries['s-a'] = a as never
      doc.deliveries['s-b'] = newDelivery({ subtaskId: 's-b', taskId: 't1', at: T })
    })
    const written = readFileSync(file, 'utf8')
    const after = await oldWriterRoundTrip(file, written, doc => { doc.deliveries['s-b']!.touchedByOld = true })
    const a = JSON.parse(after).deliveries['s-a']
    expect(a.evidence[0].sha256).toBe('f'.repeat(64))
    expect(a.custody).toEqual({ custodian: 'sess-1', since: T })
    expect(a.verification).toEqual({ jobId: 'vj-1', strength: 'strong' })
    // and the NEW store reads the old writer's output without losing them
    const back = await createDeliveryStore(file).get('s-a') as unknown as Record<string, unknown>
    expect((back.evidence as unknown[]).length).toBe(1)
    expect(Object.keys(JSON.parse(after).deliveries).sort()).toEqual(['s-a', 's-b'])
  })

  test('WHY activation is a separate file: a top-level field in deliveries.json is dropped by the old writer', async () => {
    const file = join(dir, 'deliveries.json')
    const store = createDeliveryStore(file)
    await store.update(doc => { doc.deliveries['s-a'] = newDelivery({ subtaskId: 's-a', taskId: 't1', at: T }) })
    const withTop = JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), guaranteedSince: T })
    const after = await oldWriterRoundTrip(file, withTop)
    expect(JSON.parse(after).guaranteedSince).toBeUndefined()
  })

  test('the old writer never opens guarantees.json / guards.json: both survive byte-identical', async () => {
    const g = createGuaranteesStore(join(dir, 'guarantees.json'))
    await g.setState('a', 'shadow', { check: owner, facts: { now: T, build: 'v2.211.0', capabilities: [], migrated: [], unexplainedWouldRefuse: 0 } })
    const guards = createGuardsStore(join(dir, 'guards.json'))
    const cp = { key: 'p', rank: 1, boardStatus: 'in_review', boardStage: 'leader', phase: null, revision: 1, headSha: null, auth: [], by: {}, at: T, transitionId: 'tr' } as unknown as PieceCheckpoint
    await guards.write(commitIntent(beginIntent(emptyGuards(), cp, T), 'p', 'tr'))
    const before = ['guarantees.json', 'guards.json'].map(f => readFileSync(join(dir, f), 'utf8'))
    const file = join(dir, 'deliveries.json')
    await createDeliveryStore(file).update(doc => { doc.deliveries.x = newDelivery({ subtaskId: 'x', taskId: 't', at: T }) })
    await oldWriterRoundTrip(file, readFileSync(file, 'utf8'))
    expect(['guarantees.json', 'guards.json'].map(f => readFileSync(join(dir, f), 'utf8'))).toEqual(before)
    expect(readdirSync(dir).filter(n => n.includes('guards') && n.includes('tmp'))).toEqual([])
  })

  test('the captured fixture agrees with the REAL parser on today\'s documents (a drifted fixture would test nothing)', async () => {
    const file = join(dir, 'deliveries.json')
    const store = createDeliveryStore(file)
    await store.update(doc => { for (const i of [1, 2, 3]) doc.deliveries[`s${i}`] = newDelivery({ subtaskId: `s${i}`, taskId: 't', at: T }) })
    const old = parseV2210(readFileSync(file, 'utf8'))
    expect(Object.keys(old.deliveries).sort()).toEqual(Object.keys((await store.read()).deliveries).sort())
  })
})

describe('tasks.json: new code → v2.210.1 writer → mirror restore (§2.7, review r2 N1)', () => {
  const COLOR = '#22c55e'
  /** A book as the NEW code would write it: stored stages, the new `published` status, one piece published, one done. */
  const newBook = () => JSON.stringify({
    tasks: [{ id: 't-1', title: 'T', status: 'in_progress' }],
    subtasks: [{ id: 's-pub', taskId: 't-1', title: 'pub', status: 'published' }, { id: 's-done', taskId: 't-1', title: 'done', status: 'done' }, { id: 's-run', taskId: 't-1', title: 'run', status: 'in_progress' }],
    statuses: [
      { id: 'todo', label: 'To do', color: COLOR, protected: true, order: 0, stage: 'queue' },
      { id: 'in_progress', label: 'In progress', color: COLOR, protected: true, order: 1, stage: 'running' },
      { id: 'done', label: 'Done', color: COLOR, protected: true, order: 2, stage: 'completed' },
      { id: 'published', label: 'Published', color: COLOR, protected: false, order: 3, stage: 'published' },
    ],
    attempts: [], comments: [], threads: [], files: [], historicalSessions: [], nativeSessions: [], tombstones: [], events: [], types: [],
  }, null, 2)

  test('RECORDED: the old writer DROPS `stage` from every status and KEEPS the `published` status and the pieces\' statuses', () => {
    const out = JSON.parse(oldBoardRoundTrip(newBook()))
    expect(out.statuses.map((s: { id: string }) => s.id)).toEqual(['todo', 'in_progress', 'done', 'published'])
    for (const s of out.statuses) expect('stage' in s).toBe(false)
    expect(out.subtasks.map((s: { status: string }) => s.status)).toEqual(['published', 'done', 'in_progress'])
  })

  test('the new binary restores every stage from the guarantees.json mirror, keeps `published`, and the authorized pieces still match their checkpoints', async () => {
    const g = createGuaranteesStore(join(dir, 'guarantees.json'))
    const before = JSON.parse(newBook())
    await g.writeStatusStages(before.statuses)
    const guards = createGuardsStore(join(dir, 'guards.json'))
    let doc = emptyGuards()
    const mk = (key: string, rank: number, boardStatus: string) => ({ key, rank, boardStatus, boardStage: 'x', phase: null, revision: 1, headSha: null, auth: [{ kind: 'grandfathered', at: T }], by: {}, at: T, transitionId: `tr-${key}` }) as unknown as PieceCheckpoint
    for (const c of [mk('s-pub', 5, 'published'), mk('s-done', 6, 'done')]) doc = commitIntent(beginIntent(doc, c, T), c.key, c.transitionId)
    await guards.write(doc)

    const oldOut = oldBoardRoundTrip(newBook())
    const loaded = loadV2210(oldOut)
    const mirror = (await g.read()).doc.statusStages
    const { statuses, restored } = restoreStatusStages(loaded.statuses as Array<{ id: string; stage?: string }>, mirror)
    expect(restored.sort()).toEqual(['done', 'in_progress', 'published', 'todo'])
    expect(Object.fromEntries(statuses.map(s => [s.id, s.stage]))).toEqual({ todo: 'queue', in_progress: 'running', done: 'completed', published: 'published' })
    expect(statuses.some(s => s.id === 'published')).toBe(true)

    // The authorised pieces are untouched by the round trip: board statuses still equal their checkpoints.
    const cps = (await guards.read()).checkpoints
    for (const s of loaded.subtasks.filter(s => cps[s.id as string])) expect(s.status).toBe(cps[s.id as string]!.boardStatus)
    // and the checkpoints file was never opened by the old writer
    expect(Object.keys(cps).sort()).toEqual(['s-done', 's-pub'])
  })

  test('the REAL task store (this build) still loads the old writer\'s output and keeps `published` as a status string', async () => {
    const file = join(dir, 'tasks.json')
    writeFileSync(file, oldBoardRoundTrip(newBook()))
    const book = await createTaskStore(file).read()
    expect(book.subtasks.find(s => s.id === 's-pub')?.status).toBe('published')
    expect(book.statuses.map(s => s.id)).toContain('published')
  })

  test('fixture fidelity: the real store and the captured v2.210.1 whitelist keep exactly the same status fields', async () => {
    const file = join(dir, 'tasks.json')
    writeFileSync(file, newBook())
    const real = (await createTaskStore(file).read()).statuses
    const captured = loadV2210(newBook()).statuses
    // S0c: this build ADDS the stored `stage`; the old whitelist drops it. Every other field must still agree exactly.
    expect(real.every(s => typeof s.stage === 'string')).toBe(true)
    expect(real.map(({ stage: _s, ...rest }) => rest)).toEqual(captured.map(s => ({ ...s })))
  })
})

describe('nothing is created by merely reading (the downgrade leaves no residue)', () => {
  test('reading both stores creates no guards.json / guarantees.json', async () => {
    await createDeliveryStore(join(dir, 'deliveries.json')).read()
    await createTaskStore(join(dir, 'tasks.json')).read()
    expect(existsSync(join(dir, 'guards.json'))).toBe(false)
    expect(existsSync(join(dir, 'guarantees.json'))).toBe(false)
  })
})
