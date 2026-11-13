/**
 * S1b — classification at the REAL guarded move: real git, real tasks.json / deliveries.json / guards.json in a temp
 * data dir, written through `applyGuardedWrite` (S0b). Classification runs at the move itself (§3.2), so a mutant that
 * skips it at the guard must fail here. Spec §3.5 items 10, 12, 13, 14, 20 (evidence-only positive control).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitSync, originWithClone, put } from './git-fixture.testing'
import { createDeliveryStore } from './store'
import { createGuardsStore } from './guards-store'
import { createTaskStore } from '../sessions/task-store'
import { newDelivery } from './machine'
import { buildEvidenceItem, type EvidenceItem } from './evidence'
import { execGit, forgetClassifyCache, type ClassifyDeps, type ClassifySession } from './classify-host'
import { guardedReviewEntry } from './classify-guard'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'classify-guard-')); forgetClassifyCache() })
afterEach(() => rmSync(root, { recursive: true, force: true }))

// Every git spawn goes through the shared helper: no inherited GIT_* (a pre-commit hook exports the REAL repo's), temp cwd only.
const git = gitSync
const commit = (repo: string, rel: string) => { put(repo, rel, 'v2'); git(repo, 'add', '-A'); git(repo, 'commit', '-m', rel) }
function repo(): string {
  const { repo: r } = originWithClone(root, 'r')
  git(r, 'checkout', '-b', 'feat/x')
  return r
}

const T = '2026-11-13T10:00:00Z'
const paths = () => ({ tasks: join(root, 'tasks.json'), deliveries: join(root, 'deliveries.json'), guards: join(root, 'guards.json') })
const piece = { taskId: 't1', subtaskId: 'p1' }
const sessions = (cwd: string | null): ClassifySession[] => (cwd ? [{ id: 's1', cwd, taskId: 't1', subtaskId: 'p1', createdAt: T }] : [])
const deps = (cwd: string | null): ClassifyDeps => ({ sessions: async () => sessions(cwd), git: execGit })

let seq = 0
function evid(kind: EvidenceItem['kind'], head: string | null, extra: Record<string, unknown> = {}): EvidenceItem {
  const bytes = kind === 'test-log' ? new TextEncoder().encode(' 5 pass\n 0 fail\n') : new TextEncoder().encode(`${'Result: ok\n'}${'x'.repeat(400)}${seq++}`)
  const r = buildEvidenceItem(kind === 'probe' ? { kind, probe: { kind: 'bundle', literal: 'a-literal-of-12+' } } : { kind, bytes }, { revision: 1, headSha: head, treeClean: true, by: 's1', at: T, items: [] })
  if (!r.ok) throw new Error(r.message)
  return { ...r.item, ...extra } as EvidenceItem
}

async function setup() {
  const p = paths()
  await createTaskStore(p.tasks).upsertTask({ id: 't1', title: 'T', status: 'in_progress', createdAt: T, updatedAt: T } as never)
  await createDeliveryStore(p.deliveries).update(doc => { doc.deliveries.p1 = newDelivery({ subtaskId: 'p1', taskId: 't1', at: T }) })
  const bytes = () => ({ t: readFileSync(p.tasks, 'utf8'), d: readFileSync(p.deliveries, 'utf8') })
  const move = (cwd: string | null, items: EvidenceItem[], over: Record<string, unknown> = {}) => guardedReviewEntry({
    deps: deps(cwd), piece, key: 'p1', revision: 1, items, now: T, paths: p, locks: ['guards'] as const, // the real stores below lock themselves; S2a's hook passes the full set
    checkpoint: { boardStatus: 'in_review', boardStage: 'leader', phase: 'revisao_lider', by: { kind: 'session', id: 's1' }, transitionId: 'tr-1' },
    writeDocuments: async () => {
      await createTaskStore(p.tasks).upsertTask({ id: 't1', title: 'T', status: 'in_review', createdAt: T, updatedAt: T } as never)
      await createDeliveryStore(p.deliveries).update(doc => { doc.deliveries.p1!.phase = 'revisao_lider' })
    },
    ...over,
  })
  return { p, bytes, move }
}

describe('refusals leave tasks.json and deliveries.json byte-identical and create no checkpoint', () => {
  test('§3.5.13 unresolvable checkout → classification_required', async () => {
    const { p, bytes, move } = await setup(); const before = bytes()
    const r = await move(null, [])
    expect(r).toMatchObject({ ok: false, code: 'classification_required' })
    expect(bytes()).toEqual(before); expect(existsSync(p.guards)).toBe(false)
  })
  test('§3.5.12 an uncommitted web edit + a report → uncommitted_changes (never research)', async () => {
    const r0 = repo(); put(r0, 'packages/web/x.tsx', 'export {}')
    const { p, bytes, move } = await setup(); const before = bytes()
    const r = await move(r0, [evid('report', null)])
    expect(r).toMatchObject({ ok: false, code: 'uncommitted_changes' })
    expect(bytes()).toEqual(before); expect(existsSync(p.guards)).toBe(false)
  })
  test('§3.5.14 category lie: the diff touches packages/web, only a report is attached → evidence_required naming the screenshots', async () => {
    const r0 = repo(); commit(r0, 'packages/web/src/a.tsx'); const head = git(r0, 'rev-parse', 'HEAD')
    const { p, bytes, move } = await setup(); const before = bytes()
    const r = await move(r0, [evid('report', head)])
    expect(r).toMatchObject({ ok: false, code: 'evidence_required' })
    if (!r.ok) expect(r.missing).toContain('mobile screenshot (≤ 500 px wide)')
    expect(bytes()).toEqual(before); expect(existsSync(p.guards)).toBe(false)
  })
  test('§3.5.10 stale: valid evidence, then a NEW commit → evidence_stale naming both shas', async () => {
    const r0 = repo(); commit(r0, 'packages/server/server/b.ts'); const old = git(r0, 'rev-parse', 'HEAD')
    const items = [evid('test-log', old), evid('probe', old)]
    commit(r0, 'packages/server/server/c.ts')
    const { bytes, move } = await setup(); const before = bytes()
    const r = await move(r0, items)
    expect(r).toMatchObject({ ok: false, code: 'evidence_stale' })
    if (!r.ok) { expect(r.message).toContain(old.slice(0, 7)); expect(r.message).toContain(git(r0, 'rev-parse', 'HEAD').slice(0, 7)) }
    expect(bytes()).toEqual(before)
  })
  test('§3.5.10 valid evidence, then an UNCOMMITTED edit to a .ts file → uncommitted_changes', async () => {
    const r0 = repo(); commit(r0, 'packages/server/server/b.ts'); const head = git(r0, 'rev-parse', 'HEAD')
    const items = [evid('test-log', head), evid('probe', head)]
    put(r0, 'packages/server/server/b.ts', 'dirty')
    const { bytes, move } = await setup(); const before = bytes()
    expect(await move(r0, items)).toMatchObject({ ok: false, code: 'uncommitted_changes' })
    expect(bytes()).toEqual(before)
  })
  test('classification is decided AT THE MOVE: a checkout that was clean when evidence was attached but is dirty now is refused', async () => {
    const r0 = repo(); commit(r0, 'packages/server/server/b.ts'); const head = git(r0, 'rev-parse', 'HEAD')
    const { move } = await setup(); const items = [evid('test-log', head), evid('probe', head)]
    expect((await move(r0, items)).ok).toBe(true)
    put(r0, 'packages/server/server/zz.ts', 'x')
    expect(await move(r0, items, { checkpoint: { boardStatus: 'in_review', boardStage: 'leader', phase: 'revisao_lider', by: { kind: 'session', id: 's1' }, transitionId: 'tr-2' } })).toMatchObject({ ok: false, code: 'uncommitted_changes' })
  })
})

describe('§3.5.20 positive control (evidence-only)', () => {
  test('valid evidence at HEAD → documents written, checkpoint carries auth evidence with those ids and the classification', async () => {
    const r0 = repo(); commit(r0, 'packages/server/server/b.ts'); const head = git(r0, 'rev-parse', 'HEAD')
    const { p, move } = await setup(); const items = [evid('test-log', head), evid('probe', head)]
    const r = await move(r0, items)
    expect(r.ok).toBe(true)
    expect(JSON.parse(readFileSync(p.deliveries, 'utf8')).deliveries.p1.phase).toBe('revisao_lider')
    const cp = (await createGuardsStore(p.guards).read()).checkpoints.p1!
    expect(cp.rank).toBe(1); expect(cp.headSha).toBe(head)
    expect(cp.auth).toEqual([{ kind: 'evidence', ids: items.map(i => i.id), sha256: items.map(i => i.sha256) }])
    expect(cp.classification).toMatchObject({ category: 'code', headSha: head })
  })
})
