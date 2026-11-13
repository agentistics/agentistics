import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyGuardedWrite, commitIntent, beginIntent, createGuardsStore, emptyGuards, planRecovery, parseGuards,
  type PieceCheckpoint,
} from './guards-store'

let dir: string
let file: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'guards-')); file = join(dir, 'guards.json') })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const cp = (key: string, rank: number, extra: Partial<PieceCheckpoint> = {}): PieceCheckpoint => ({
  key, rank, boardStatus: rank ? 'in_review' : 'in_progress', boardStage: rank ? 'leader' : 'running', phase: null,
  revision: 1, headSha: null, auth: [{ kind: 'grandfathered', at: '2026-11-13T00:00:00Z' }],
  by: { kind: 'flow' } as never, at: '2026-11-13T00:00:00Z', transitionId: `tr-${key}-${rank}`, ...extra,
})

describe('pure two-phase steps', () => {
  test('beginIntent records the target under the piece key; commitIntent moves it to checkpoints and clears the intent', () => {
    let doc = emptyGuards()
    doc = beginIntent(doc, cp('p1', 1), '2026-11-13T00:00:01Z')
    expect(doc.intents.p1!.transitionId).toBe('tr-p1-1')
    expect(doc.checkpoints.p1).toBeUndefined()
    doc = commitIntent(doc, 'p1', 'tr-p1-1')
    expect(doc.checkpoints.p1!.rank).toBe(1)
    expect(doc.intents.p1).toBeUndefined()
  })
  test('commit with a different transitionId is a no-op (a stale committer cannot land another move)', () => {
    const doc = beginIntent(emptyGuards(), cp('p1', 1), 't')
    expect(commitIntent(doc, 'p1', 'tr-other')).toEqual(doc)
  })
  test('planRecovery: documents already show the target → commit; do not → drop', () => {
    let doc = beginIntent(emptyGuards(), cp('shown', 1), 't')
    doc = beginIntent(doc, cp('unshown', 1), 't')
    const plan = planRecovery(doc, t => t.key === 'shown')
    expect(plan.commit.map(i => i.target.key)).toEqual(['shown'])
    expect(plan.drop).toEqual(['unshown'])
  })
  test('parseGuards: wrong version / junk entries are rejected as unreadable, valid doc round-trips', () => {
    expect(() => parseGuards('{"version":2}')).toThrow()
    expect(() => parseGuards('[]')).toThrow()
    const doc = commitIntent(beginIntent(emptyGuards(), cp('p', 2), 't'), 'p', 'tr-p-2')
    expect(parseGuards(JSON.stringify(doc))).toEqual(doc)
  })
})

describe('the file', () => {
  test('absent file reads as empty; read creates nothing; write is atomic and 0600', async () => {
    const store = createGuardsStore(file)
    expect(await store.read()).toEqual(emptyGuards())
    expect(existsSync(file)).toBe(false)
    await store.write(beginIntent(emptyGuards(), cp('p', 1), 't'))
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })
  test('an unreadable file is never overwritten by an empty one: write refuses and keeps the bytes', async () => {
    writeFileSync(file, '{ torn')
    const store = createGuardsStore(file)
    await expect(store.write(emptyGuards())).rejects.toMatchObject({ code: 'guards_unreadable' })
    expect(readFileSync(file, 'utf8')).toBe('{ torn')
    await expect(store.read()).rejects.toMatchObject({ code: 'guards_unreadable' })
  })
  test('checkpoints are per piece and are NOT capped like the activity feed (2001 pieces survive)', async () => {
    const store = createGuardsStore(file)
    let doc = emptyGuards()
    for (let i = 0; i < 2001; i++) doc = commitIntent(beginIntent(doc, cp(`p${i}`, 1), 't'), `p${i}`, `tr-p${i}-1`)
    await store.write(doc)
    const back = await store.read()
    expect(Object.keys(back.checkpoints).length).toBe(2001)
    expect(back.checkpoints.p0!.rank).toBe(1)
  })
})

describe('applyGuardedWrite: intent → documents → commit, under withGuardLocks', () => {
  const paths = () => ({ tasks: join(dir, 'tasks.json'), deliveries: join(dir, 'deliveries.json'), guards: file })
  const run = (over: Partial<Parameters<typeof applyGuardedWrite>[0]> = {}) =>
    applyGuardedWrite({ locks: ['tasks', 'deliveries', 'guards'], paths: paths(), piece: 'p1', target: cp('p1', 1), now: 't',
      writeDocuments: async () => { writeFileSync(join(dir, 'tasks.json'), 'WRITTEN') }, documentsShow: () => true, ...over })

  test('happy path: documents written, checkpoint committed, intent gone', async () => {
    await run()
    expect(readFileSync(join(dir, 'tasks.json'), 'utf8')).toBe('WRITTEN')
    const doc = await createGuardsStore(file).read()
    expect(doc.checkpoints.p1!.rank).toBe(1)
    expect(doc.intents).toEqual({})
  })
  test('the intent is on disk BEFORE the documents are written', async () => {
    let intentSeen: string | undefined
    await run({ writeDocuments: async () => { intentSeen = (await createGuardsStore(file).read()).intents.p1?.transitionId } })
    expect(intentSeen).toBe('tr-p1-1')
  })
  test('crash AFTER the intent and AFTER the documents: the checkpoint is not committed, the intent survives; recovery commits it', async () => {
    await expect(run({ afterDocuments: () => { throw new Error('boom') } })).rejects.toThrow('boom')
    let doc = await createGuardsStore(file).read()
    expect(doc.checkpoints.p1).toBeUndefined()
    expect(doc.intents.p1).toBeDefined()
    const plan = planRecovery(doc, () => true)
    expect(plan.commit.length).toBe(1)
    doc = commitIntent(doc, 'p1', plan.commit[0]!.transitionId)
    expect(doc.checkpoints.p1!.rank).toBe(1)
  })
  test('crash AFTER the intent only (documents never written): recovery drops it, no checkpoint ever lands', async () => {
    await expect(run({ writeDocuments: async () => { throw new Error('disk full') } })).rejects.toThrow('disk full')
    const doc = await createGuardsStore(file).read()
    expect(doc.intents.p1).toBeDefined()
    expect(planRecovery(doc, () => false).drop).toEqual(['p1'])
    expect(doc.checkpoints.p1).toBeUndefined()
  })
  test('locks are released after a failure (a crash never wedges the board)', async () => {
    await expect(run({ writeDocuments: async () => { throw new Error('x') } })).rejects.toThrow('x')
    await run({ piece: 'p2', target: cp('p2', 1) })
    expect((await createGuardsStore(file).read()).checkpoints.p2).toBeDefined()
  })
  test('a lock timeout writes NOTHING — no intent, no documents (fail closed)', async () => {
    const { lockFile } = await import('../sessions/file-lock')
    const held = await lockFile(paths().guards)
    await expect(run({ waitMs: 80 })).rejects.toMatchObject({ code: 'guard_busy', status: 409 })
    await held.release()
    expect(existsSync(file)).toBe(false)
    expect(existsSync(join(dir, 'tasks.json'))).toBe(false)
  })
})
