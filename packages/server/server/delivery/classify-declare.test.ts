/**
 * S1b — the leader's declaration (spec §3.2 "Leader declaration", review r2 N9). It names WHERE to look (a repository
 * and a commit), never the category: the server re-runs classify-host against it, the commit must exist and be reachable
 * from a remote branch, a worker cannot declare, and each declaration is logged on the piece, counted in health and
 * carried onto the checkpoint.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitSync, originWithClone, put } from './git-fixture.testing'
import { createDeliveryService } from './service'
import { createDeliveryStore } from './store'
import { execGit, forgetClassifyCache, type ClassifyDeps, type ClassifySession } from './classify-host'
import { classificationHealth, declareClassification } from './classify-declare'
import { guardedReviewEntry } from './classify-guard'
import { createGuardsStore } from './guards-store'
import type { EvidenceItem } from './evidence'
import { buildEvidenceItem } from './evidence'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'classify-declare-')); forgetClassifyCache() })
afterEach(() => rmSync(root, { recursive: true, force: true }))

// Every git spawn goes through the shared helper: no inherited GIT_* (a pre-commit hook exports the REAL repo's), temp cwd only.
const git = gitSync
const T = '2026-11-13T10:00:00Z'

/** origin (bare) + a clone whose branch `feat/x` carries a web commit; returns the pushed and an unpushed commit. */
function fixture() {
  const { origin, repo } = originWithClone(root, 'r')
  git(repo, 'checkout', '-b', 'feat/x'); put(repo, 'packages/web/src/a.tsx'); git(repo, 'add', '-A'); git(repo, 'commit', '-m', 'web')
  git(repo, 'push', '-u', 'origin', 'feat/x'); const pushed = git(repo, 'rev-parse', 'HEAD')
  put(repo, 'packages/server/server/b.ts'); git(repo, 'add', '-A'); git(repo, 'commit', '-m', 'local only')
  return { origin, repo, pushed, unpushed: git(repo, 'rev-parse', 'HEAD') }
}
const sessionsFor = (rows: ClassifySession[]): ClassifyDeps => ({ sessions: async () => rows, git: execGit })
const piece = { taskId: 't1', subtaskId: 'p1' }

describe('declareClassification — where to look, never the category', () => {
  test('a pushed commit in a named repository path classifies from the DIFF (the declaration carries no category)', async () => {
    const { repo, pushed } = fixture()
    const r = await declareClassification(sessionsFor([]), { piece, repo, head: pushed })
    expect(r).toMatchObject({ ok: true, classification: { ok: true, category: 'screen', headSha: pushed } })
    // the INPUT has no category field at all; the recorded one is what the server derived
    if (r.ok) expect(Object.keys(r.declaration).sort()).toEqual(['category', 'head', 'repo'])
  })
  test('a category smuggled into the input is ignored: the server derives it from the diff', async () => {
    const { repo, pushed } = fixture()
    const r = await declareClassification(sessionsFor([]), { piece, repo, head: pushed, category: 'docs' } as never)
    expect(r).toMatchObject({ ok: true, classification: { category: 'screen' }, declaration: { category: 'screen' } })
  })
  test('an abbreviated sha is resolved to the full commit', async () => {
    const { repo, pushed } = fixture()
    const r = await declareClassification(sessionsFor([]), { piece, repo, head: pushed.slice(0, 9) })
    expect(r).toMatchObject({ ok: true, classification: { headSha: pushed } })
  })
  test('the repository may be named by REMOTE (matched against the piece\'s known checkouts)', async () => {
    const { repo, pushed } = fixture()
    git(repo, 'remote', 'set-url', 'origin', 'https://github.com/acme/widget.git') // remote-tracking refs stay; the NAME is what is matched
    const r = await declareClassification(sessionsFor([{ id: 's1', cwd: repo, ...piece, createdAt: T }]), { piece, repo: 'github.com/acme/widget', head: pushed })
    expect(r.ok).toBe(true)
    // a remote none of the piece's checkouts uses cannot be found
    expect(await declareClassification(sessionsFor([{ id: 's1', cwd: repo, ...piece, createdAt: T }]), { piece, repo: 'github.com/acme/other', head: pushed })).toMatchObject({ ok: false, code: 'declaration_repo_unresolved' })
  })
  test('a commit that is not reachable from a remote branch is refused (declaration_unpushed)', async () => {
    const { repo, unpushed } = fixture()
    expect(await declareClassification(sessionsFor([]), { piece, repo, head: unpushed })).toMatchObject({ ok: false, code: 'declaration_unpushed' })
  })
  test('a commit that does not exist is refused (declaration_commit_missing)', async () => {
    const { repo } = fixture()
    expect(await declareClassification(sessionsFor([]), { piece, repo, head: 'deadbeefdeadbeef' })).toMatchObject({ ok: false, code: 'declaration_commit_missing' })
  })
  test('a repository that cannot be found is refused (declaration_repo_unresolved)', async () => {
    expect(await declareClassification(sessionsFor([]), { piece, repo: join(root, 'nowhere'), head: 'abcdef1' })).toMatchObject({ ok: false, code: 'declaration_repo_unresolved' })
    expect(await declareClassification(sessionsFor([]), { piece, repo: 'github.com/nobody/nothing', head: 'abcdef1' })).toMatchObject({ ok: false, code: 'declaration_repo_unresolved' })
  })
  test('missing repo or head is refused', async () => {
    expect(await declareClassification(sessionsFor([]), { piece, repo: '', head: 'abc1234' })).toMatchObject({ ok: false })
    expect(await declareClassification(sessionsFor([]), { piece, repo: root, head: '' })).toMatchObject({ ok: false })
  })
  test('an empty diff at the declared commit is none-verified (the server read the diff; the leader did not say so)', async () => {
    const { repo } = fixture(); const main = git(repo, 'rev-parse', 'origin/main')
    expect(await declareClassification(sessionsFor([]), { piece, repo, head: main })).toMatchObject({ ok: true, classification: { category: 'none-verified' } })
  })
})

describe('service.classify — authority, log, comment', () => {
  function service(dir: string, sessions: Array<Record<string, unknown>>, classifyDeps: ClassifyDeps) {
    const comments: string[] = []
    const svc = createDeliveryService({
      store: createDeliveryStore(join(dir, 'deliveries.json')),
      facts: { subtask: async (id: string) => (id === 'p1' ? { id, taskId: 't1', title: 'p', status: 'in_progress', groupMember: false, blockedBy: [] } : null), sessions: async () => sessions } as never,
      board: { comment: async (_t: string, _s: string, body: string) => { comments.push(body) } } as never,
      notify: { session: async () => true, owner: async () => undefined } as never,
      autonomous: async () => true, emit: async () => undefined, now: () => Date.parse(T),
      classify: classifyDeps,
    } as never)
    return { svc, comments }
  }
  const people = [
    { id: 'leader', role: 'leader', taskId: 't1', alive: true, cwd: '/x', harness: 'claude', worktree: false },
    { id: 'worker', role: 'worker', taskId: 't1', subtaskId: 'p1', alive: true, cwd: '/x', harness: 'claude', worktree: false },
  ]

  test('a WORKER cannot declare (403), nothing is logged', async () => {
    const { repo, pushed } = fixture(); const dir = mkdtempSync(join(root, 'svc-'))
    const { svc, comments } = service(dir, people, sessionsFor([]))
    const r = await (svc as never as { classify(id: string, i: unknown, a: string): Promise<{ ok: boolean; status?: number; code?: string }> }).classify('p1', { repo, head: pushed }, 'worker')
    expect(r).toMatchObject({ ok: false, status: 403, code: 'classify_leader_only' })
    expect((await svc.get('p1'))?.classificationDeclared ?? []).toEqual([]); expect(comments).toEqual([])
  })

  test('the task LEADER declares: logged on the piece with who/what/where, commented, and counted in health by leader', async () => {
    const { repo, pushed } = fixture(); const dir = mkdtempSync(join(root, 'svc-'))
    const { svc, comments } = service(dir, people, sessionsFor([]))
    const r = await (svc as never as { classify(id: string, i: unknown, a: string): Promise<{ ok: boolean; classification?: { category: string } }> }).classify('p1', { repo, head: pushed }, 'leader')
    expect(r).toMatchObject({ ok: true, classification: { category: 'screen' } })
    const rec = (await svc.get('p1'))!
    expect(rec.classificationDeclared).toHaveLength(1)
    expect(rec.classificationDeclared![0]).toMatchObject({ by: 'leader', repo, head: pushed, category: 'screen' })
    expect(comments.some(c => c.includes(pushed.slice(0, 7)) && c.includes('leader'))).toBe(true)
    expect(classificationHealth(await svc.list())).toEqual({ id: 'classification-declared', count: 1, byLeader: { leader: 1 } })
  })

  test('the REST door (`POST /api/deliveries/<piece>` action classify) reaches the service; a body category is never read', async () => {
    const { repo, pushed } = fixture(); const dir = mkdtempSync(join(root, 'svc-'))
    const { svc } = service(dir, people, sessionsFor([]))
    const { deliveryRequest } = await import('./web')
    const verify = async (id: unknown) => (id === 'leader' || id === 'worker' ? String(id) : null)
    const post = (session: string) => deliveryRequest('POST', '/api/deliveries/p1', { action: 'classify', repo, head: pushed, category: 'docs', session: { id: session, token: 't' } }, { service: svc, verify } as never)
    const denied = await post('worker')
    expect(denied.status).toBe(403); expect(denied.body).toMatchObject({ ok: false, error: 'classify_leader_only' })
    const ok = await post('leader')
    expect(ok.status).toBe(200); expect(ok.body).toMatchObject({ ok: true, classification: { category: 'screen', headSha: pushed } })
  })

  test('a refused declaration (unpushed commit) is not logged or counted', async () => {
    const { repo, unpushed } = fixture(); const dir = mkdtempSync(join(root, 'svc-'))
    const { svc } = service(dir, people, sessionsFor([]))
    const r = await (svc as never as { classify(id: string, i: unknown, a: string): Promise<{ ok: boolean; code?: string }> }).classify('p1', { repo, head: unpushed }, 'leader')
    expect(r).toMatchObject({ ok: false, code: 'declaration_unpushed' })
    expect(classificationHealth(await svc.list()).count).toBe(0)
  })
})

describe('the declaration reaches the checkpoint', () => {
  test('a piece with no live checkout passes the guard through its declaration; the checkpoint records who declared and where', async () => {
    const { repo, pushed } = fixture()
    const decl = await declareClassification(sessionsFor([]), { piece, repo, head: pushed })
    if (!decl.ok) throw new Error('setup')
    const paths = { tasks: join(root, 'tasks.json'), deliveries: join(root, 'deliveries.json'), guards: join(root, 'guards.json') }
    const mk = (kind: EvidenceItem['kind'], bytes: Uint8Array) => { const r = buildEvidenceItem({ kind, bytes } as never, { revision: 1, headSha: pushed, treeClean: true, by: 'x', at: T, items: [] }); if (!r.ok) throw new Error(r.message); return r.item }
    const png = (w: number) => { const b = new Uint8Array(6000); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); const dv = new DataView(b.buffer); dv.setUint32(8, 13); b.set(new TextEncoder().encode('IHDR'), 12); dv.setUint32(16, w); dv.setUint32(20, 800); b[40] = w & 255; return b }
    const probe = buildEvidenceItem({ kind: 'probe', probe: { kind: 'bundle', literal: 'a-literal-of-12+' } }, { revision: 1, headSha: pushed, treeClean: true, by: 'x', at: T, items: [] })
    if (!probe.ok) throw new Error('setup')
    const items = [mk('screenshot', png(1280)), mk('screenshot', png(390)), probe.item]
    const declaration = { ...decl.declaration, by: 'leader', at: T }
    const without = await guardedReviewEntry({ deps: sessionsFor([]), piece, key: 'p1', revision: 1, items, now: T, paths, locks: ['guards'] as const, checkpoint: { boardStatus: 'in_review', boardStage: 'leader', phase: 'revisao_lider', by: { kind: 'session' }, transitionId: 'tr-0' }, writeDocuments: async () => undefined })
    expect(without).toMatchObject({ ok: false, code: 'classification_required' })
    const r = await guardedReviewEntry({ deps: sessionsFor([]), piece, key: 'p1', revision: 1, items, now: T, paths, locks: ['guards'] as const, declared: declaration, checkpoint: { boardStatus: 'in_review', boardStage: 'leader', phase: 'revisao_lider', by: { kind: 'session' }, transitionId: 'tr-1' }, writeDocuments: async () => undefined })
    expect(r.ok).toBe(true)
    const cp = (await createGuardsStore(paths.guards).read()).checkpoints.p1!
    expect(cp.classification).toMatchObject({ category: 'screen', headSha: pushed, declared: { by: 'leader', repo, head: pushed } })
  })

  test('a declaration NEVER overrides a checkout the server can read: the live classification wins and the checkpoint records no declaration', async () => {
    const { repo } = fixture(); const live = git(repo, 'rev-parse', 'HEAD')
    const paths = { tasks: join(root, 'tasks.json'), deliveries: join(root, 'deliveries.json'), guards: join(root, 'guards.json') }
    const mk = (kind: EvidenceItem['kind'], bytes: Uint8Array) => { const r = buildEvidenceItem({ kind, bytes } as never, { revision: 1, headSha: live, treeClean: true, by: 'x', at: T, items: [] }); if (!r.ok) throw new Error(r.message); return r.item }
    const probe = buildEvidenceItem({ kind: 'probe', probe: { kind: 'bundle', literal: 'a-literal-of-12+' } }, { revision: 1, headSha: live, treeClean: true, by: 'x', at: T, items: [] })
    if (!probe.ok) throw new Error('setup')
    const items = [mk('test-log', new TextEncoder().encode(' 5 pass\n 0 fail\n')), probe.item]
    const lie = { by: 'leader', at: T, repo, head: 'f'.repeat(40), category: 'docs' }
    const r = await guardedReviewEntry({ deps: sessionsFor([{ id: 's1', cwd: repo, ...piece, createdAt: T }]), piece, key: 'p1', revision: 1, items, now: T, paths, locks: ['guards'] as const, declared: lie, checkpoint: { boardStatus: 'in_review', boardStage: 'leader', phase: 'revisao_lider', by: { kind: 'session' }, transitionId: 'tr-9' }, writeDocuments: async () => undefined })
    // the live diff (pushed web commit + local server commit) is a SCREEN: the requirement is the live one, not the declared 'docs'
    expect(r).toMatchObject({ ok: false, code: 'evidence_required' })
    if (!r.ok) expect(r.missing).toContain('desktop screenshot (≥ 1000 px wide)')
    expect(existsSync(paths.guards)).toBe(false)
  })
})
