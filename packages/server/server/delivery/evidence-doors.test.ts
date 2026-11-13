/**
 * S1c — attaching evidence: the service behind the REST / MCP / CLI doors (spec §3.1, §3.3, §3.4, §3.5 items 9, 11, 16).
 * Real git (throwaway, via the GIT_*-free helper), real deliveries.json / guards.json in a temp dir, an in-memory TaskFile store.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeliveryStore } from './store'
import { createGuardsStore, emptyGuards, beginIntent, commitIntent, type PieceCheckpoint } from './guards-store'
import { forgetClassifyCache } from './classify-host'
import { sha256Hex } from './evidence'
import { evidenceRequest } from './evidence-web'
import { gitSync, put } from './git-fixture.testing'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'evidence-doors-')); forgetClassifyCache() })
afterEach(() => rmSync(root, { recursive: true, force: true }))

import { T, b64, enc, makeWorld, png, shot } from './evidence-world.testing'
const world = () => makeWorld(root)

describe('add — everything the server computes, nothing the caller says', () => {
  test('an upload becomes a TaskFile and an item bound to the verified HEAD, with the SERVER\'s sha256 / revision / time', async () => {
    const { svc, repo, files } = world()
    const bytes = png(1280, 800, 1)
    const r = await svc.evidenceAdd('p1', { kind: 'screenshot', bytesBase64: b64(bytes), name: 'desk.png', sha256: 'forged', at: '1999-01-01', headSha: 'f'.repeat(40), revision: 99, width: 1, treeClean: false }, 'worker')
    expect(r.ok).toBe(true); if (!r.ok) return
    const item = r.evidence
    expect(item).toMatchObject({ kind: 'screenshot', sha256: sha256Hex(bytes), revision: 1, headSha: gitSync(repo, 'rev-parse', 'HEAD'), treeClean: true, width: 1280, height: 800, by: 'worker' })
    expect(item.at).toBe(new Date(T).toISOString()); expect(item.fileId).toBe('f-1')
    expect(files.get('f-1')).toMatchObject({ taskId: 't1', name: 'desk.png', kind: 'evidence' })
    const rec = (await svc.get('p1'))!
    expect(rec.evidence).toHaveLength(1); expect(rec.evidenceHistory).toEqual([{ sha256: sha256Hex(bytes), pieceKey: 'p1', revision: 1 }])
  })

  test('an existing TaskFile of the SAME task can be named by fileId; one of another task, or a missing one, is refused', async () => {
    const { svc, files } = world()
    files.set('own', { taskId: 't1', name: 'a.png', bytes: png(1280, 800, 2) }); files.set('alien', { taskId: 't9', name: 'a.png', bytes: png(1280, 800, 3) })
    expect((await svc.evidenceAdd('p1', { kind: 'screenshot', fileId: 'own' }, 'worker')).ok).toBe(true)
    expect(await svc.evidenceAdd('p1', { kind: 'screenshot', fileId: 'alien' }, 'worker')).toMatchObject({ ok: false, status: 422, code: 'evidence_invalid' })
    expect(await svc.evidenceAdd('p1', { kind: 'screenshot', fileId: 'ghost' }, 'worker')).toMatchObject({ ok: false, status: 422, code: 'evidence_invalid' })
  })

  test('§3.5.9 forged evidence: a 1×1 PNG, a renamed text file, a 3-fail log, a verdict-less report → evidence_invalid naming the rule, NO file left behind', async () => {
    const { svc, files } = world()
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ kind: 'screenshot', bytesBase64: b64(png(1, 1)) }, 'screenshot-too-small-dimensions'],
      [{ kind: 'screenshot', bytesBase64: b64(enc('hello '.repeat(2000))) }, 'screenshot-not-an-image'],
      [{ kind: 'test-log', bytesBase64: b64(enc(' 9 pass\n 3 fail\n')) }, 'test-log-has-failures'],
      [{ kind: 'report', bytesBase64: b64(enc('no verdict here. '.repeat(40))) }, 'report-no-verdict'],
    ]
    for (const [input, rule] of cases) {
      const r = await svc.evidenceAdd('p1', input, 'worker')
      expect(r, rule).toMatchObject({ ok: false, status: 422, code: 'evidence_invalid' })
      if (!r.ok) expect(r.sentence).toContain(rule)
    }
    expect(files.size).toBe(0); expect((await svc.get('p1'))?.evidence ?? []).toEqual([])
  })

  test('an oversize upload (> 8 MB) is refused 413 before anything is decoded or stored', async () => {
    const { svc, files } = world()
    const big = Buffer.alloc(8 * 1024 * 1024 + 1, 1).toString('base64')
    expect(await svc.evidenceAdd('p1', { kind: 'screenshot', bytesBase64: big }, 'worker')).toMatchObject({ ok: false, status: 413, code: 'evidence_too_large' })
    expect(files.size).toBe(0)
  })

  test('a probe and a repoRef report are accepted through the same door (and a bad probe is refused)', async () => {
    const { svc, repo } = world()
    expect((await svc.evidenceAdd('p1', { kind: 'probe', probe: { kind: 'bundle', literal: 'a-literal-of-12+' } }, 'worker')).ok).toBe(true)
    expect(await svc.evidenceAdd('p1', { kind: 'probe', probe: { kind: 'bundle', literal: 'short' } }, 'worker')).toMatchObject({ ok: false, code: 'evidence_invalid' })
    expect(await svc.evidenceAdd('p1', { kind: 'probe', probe: { kind: 'bundle', literal: 'a-literal-of-12+', extra: 1 } }, 'worker')).toMatchObject({ ok: false, code: 'evidence_invalid' })
    // a report by repoRef: the file exists at a commit that is on a remote branch
    put(repo, 'docs/r.md', '# r'); gitSync(repo, 'add', '-A'); gitSync(repo, 'commit', '-m', 'doc'); gitSync(repo, 'push', '-u', 'origin', 'feat/x')
    const sha = gitSync(repo, 'rev-parse', 'HEAD')
    const ok = await svc.evidenceAdd('p1', { kind: 'report', repoRef: { repo, sha, path: 'docs/r.md' } }, 'worker')
    expect(ok.ok).toBe(true)
    put(repo, 'docs/local.md', '# l'); gitSync(repo, 'add', '-A'); gitSync(repo, 'commit', '-m', 'local')
    const local = gitSync(repo, 'rev-parse', 'HEAD')
    expect(await svc.evidenceAdd('p1', { kind: 'report', repoRef: { repo, sha: local, path: 'docs/local.md' } }, 'worker')).toMatchObject({ ok: false, code: 'evidence_invalid' })
    expect(await svc.evidenceAdd('p1', { kind: 'report', repoRef: { repo, sha, path: 'docs/missing.md' } }, 'worker')).toMatchObject({ ok: false, code: 'evidence_invalid' })
  })

  test('a dirty checkout binds the item with treeClean false (it will be stale at the move)', async () => {
    const { svc, repo } = world(); put(repo, 'packages/web/dirty.tsx', 'x')
    const r = await svc.evidenceAdd('p1', shot(1280, 5), 'worker')
    expect(r.ok && r.evidence.treeClean).toBe(false)
  })

  test('a piece with no resolvable checkout binds headSha null (the item can never satisfy a move until recaptured)', async () => {
    const { svc, sessions } = world()
    sessions[2]!.cwd = '/nowhere'     // worker2 (piece p2) loses its checkout
    const r = await svc.evidenceAdd('p2', shot(1280, 6), 'worker2')
    expect(r.ok).toBe(true); if (r.ok) expect(r.evidence).toMatchObject({ headSha: null, treeClean: false })
  })
})

describe('§3.5.11 uniqueness is persisted', () => {
  test('the same bytes on a SECOND piece → 409 evidence_reused naming the other piece and revision', async () => {
    const { svc } = world()
    expect((await svc.evidenceAdd('p1', shot(1280, 7), 'worker')).ok).toBe(true)
    const r = await svc.evidenceAdd('p2', shot(1280, 7), 'worker2')
    expect(r).toMatchObject({ ok: false, status: 409, code: 'evidence_reused' }); if (!r.ok) expect(r.sentence).toMatch(/p1.*revision 1/)
  })
  test('the same bytes re-attached to the SAME piece at a later revision → evidence_reused; a fresh capture is fine', async () => {
    const { svc } = world()
    await svc.evidenceAdd('p1', shot(1280, 8), 'worker')
    await createDeliveryStore(join(root, 'deliveries.json')).update(doc => { doc.deliveries.p1!.revision = 2 })
    expect(await svc.evidenceAdd('p1', shot(1280, 8), 'worker')).toMatchObject({ ok: false, status: 409, code: 'evidence_reused' })
    expect((await svc.evidenceAdd('p1', shot(1280, 9), 'worker')).ok).toBe(true)
  })
  test('re-adding the identical bytes in the same revision is idempotent (one item, no second file)', async () => {
    const { svc, files } = world()
    const a = await svc.evidenceAdd('p1', shot(1280, 10), 'worker'); const b = await svc.evidenceAdd('p1', shot(1280, 10), 'worker')
    expect(a.ok && b.ok).toBe(true); if (a.ok && b.ok) expect(b.evidence.id).toBe(a.evidence.id)
    expect((await svc.get('p1'))!.evidence).toHaveLength(1); expect(files.size).toBe(1)
  })
  test('a REMOVED item frees nothing: another piece still cannot reuse its bytes', async () => {
    const { svc } = world()
    const a = await svc.evidenceAdd('p1', shot(1280, 11), 'worker'); if (!a.ok) throw new Error('setup')
    expect((await svc.evidenceRemove('p1', a.evidence.id, 'worker')).ok).toBe(true)
    expect(await svc.evidenceAdd('p2', shot(1280, 11), 'worker2')).toMatchObject({ ok: false, code: 'evidence_reused' })
  })
})

describe('authority', () => {
  test('the piece\'s own filed session, the task leader and the owner may attach; a stranger and an unfiled session may not', async () => {
    const { svc } = world()
    expect((await svc.evidenceAdd('p1', shot(1280, 20), 'worker')).ok).toBe(true)
    expect((await svc.evidenceAdd('p1', shot(1280, 21), 'leader')).ok).toBe(true)
    expect((await svc.evidenceAdd('p1', shot(1280, 22), 'owner')).ok).toBe(true)
    expect(await svc.evidenceAdd('p1', shot(1280, 23), 'stranger')).toMatchObject({ ok: false, status: 403, code: 'evidence_forbidden' })
    expect(await svc.evidenceAdd('p1', shot(1280, 24), 'worker2')).toMatchObject({ ok: false, status: 403, code: 'evidence_forbidden' }) // another piece's worker
    expect((await svc.get('p1'))!.evidence).toHaveLength(3)
  })
  test('remove: the item\'s author, the leader or the owner; another worker may not', async () => {
    const { svc } = world()
    const a = await svc.evidenceAdd('p1', shot(1280, 30), 'worker'); if (!a.ok) throw new Error('setup')
    expect(await svc.evidenceRemove('p1', a.evidence.id, 'worker2')).toMatchObject({ ok: false, status: 403 })
    expect((await svc.evidenceRemove('p1', a.evidence.id, 'leader')).ok).toBe(true)
    expect(await svc.evidenceRemove('p1', a.evidence.id, 'leader')).toMatchObject({ ok: false, status: 404, code: 'no_such_evidence' })
  })
})

describe('list', () => {
  test('returns the items and the binding they will be judged against', async () => {
    const { svc, repo } = world()
    await svc.evidenceAdd('p1', shot(1280, 40), 'worker')
    const r = await svc.evidenceList('p1')
    expect(r.ok && r.evidence).toHaveLength(1)
    expect(r.ok && r.binding).toEqual({ headSha: gitSync(repo, 'rev-parse', 'HEAD'), treeClean: true })
    expect(await svc.evidenceList('nope')).toMatchObject({ ok: false, status: 404 })
  })
})

describe('§3.5.16 evidence_in_use — a TaskFile (or an item) that backs a checkpoint cannot be deleted', () => {
  async function authorize(guardsPath: string, ids: string[]) {
    const cp = { key: 'p1', rank: 1, boardStatus: 'in_review', boardStage: 'leader', phase: 'revisao_lider', revision: 1, headSha: 'a'.repeat(40), auth: [{ kind: 'evidence', ids, sha256: ids }], by: { kind: 'session' }, at: 't', transitionId: 'tr-1' } as PieceCheckpoint
    await createGuardsStore(guardsPath).write(commitIntent(beginIntent(emptyGuards(), cp, 't'), 'p1', 'tr-1'))
  }
  test('deleting the file behind a checkpoint\'s evidence → in use; an unrelated file is free; removing the item itself → 409 evidence_in_use', async () => {
    const { svc, guardsPath, files } = world()
    const a = await svc.evidenceAdd('p1', shot(1280, 50), 'worker'); const b = await svc.evidenceAdd('p1', shot(1280, 51), 'worker')
    if (!a.ok || !b.ok) throw new Error('setup')
    expect(await svc.evidenceFileInUse(a.evidence.fileId!)).toBe(false)                 // nothing authorized yet
    await authorize(guardsPath, [a.evidence.id])
    expect(await svc.evidenceFileInUse(a.evidence.fileId!)).toBe(true)
    expect(await svc.evidenceFileInUse(b.evidence.fileId!)).toBe(false)
    expect(await svc.evidenceFileInUse('not-evidence')).toBe(false)
    expect(await svc.evidenceRemove('p1', a.evidence.id, 'worker')).toMatchObject({ ok: false, status: 409, code: 'evidence_in_use' })
    expect(files.has(a.evidence.fileId!)).toBe(true)
    expect((await svc.evidenceRemove('p1', b.evidence.id, 'worker')).ok).toBe(true)         // not backing a checkpoint
  })
  test('an unreadable guards.json fails CLOSED: nothing may be deleted', async () => {
    const { svc, guardsPath } = world()
    const a = await svc.evidenceAdd('p1', shot(1280, 52), 'worker'); if (!a.ok) throw new Error('setup')
    await Bun.write(guardsPath, '{ not json')
    expect(await svc.evidenceFileInUse(a.evidence.fileId!)).toBe(true)
    expect(await svc.evidenceRemove('p1', a.evidence.id, 'worker')).toMatchObject({ ok: false, status: 409, code: 'evidence_in_use' })
  })
})

describe('the REST adapter (POST/GET/DELETE /api/tasks/<ref>/evidence)', () => {
  const verify = async (id: unknown, token: unknown) => (id === 'worker' && token === 'ok' ? 'worker' : id === 'leader' && token === 'ok' ? 'leader' : null)
  test('POST with a verified session adds; a claimed-but-unverifiable session is 403 unverified_sender; no session = the owner', async () => {
    const { svc } = world(); const d = { service: svc, verify }
    const added = await evidenceRequest('POST', 't1', {}, { subtaskId: 'p1', ...shot(1280, 60), session: { id: 'worker', token: 'ok' } }, d)
    expect(added.status).toBe(200); expect(added.body).toMatchObject({ ok: true, evidence: { by: 'worker', kind: 'screenshot' } })
    const forged = await evidenceRequest('POST', 't1', {}, { subtaskId: 'p1', ...shot(1280, 61), session: { id: 'worker', token: 'bad' } }, d)
    expect(forged.status).toBe(403); expect(forged.body).toMatchObject({ error: 'unverified_sender' })
    const owner = await evidenceRequest('POST', 't1', {}, { subtaskId: 'p1', ...shot(1280, 62) }, d)
    expect(owner.status).toBe(200); expect(owner.body).toMatchObject({ evidence: { by: 'owner' } })
  })
  test('refusals keep the service\'s status and code: 422 invalid, 409 reused, 413 too large, 403 forbidden, 404 unknown piece', async () => {
    const { svc } = world(); const d = { service: svc, verify }; const s = { id: 'leader', token: 'ok' }
    expect((await evidenceRequest('POST', 't1', {}, { subtaskId: 'p1', kind: 'screenshot', bytesBase64: b64(png(1, 1)), session: s }, d)).status).toBe(422)
    await evidenceRequest('POST', 't1', {}, { subtaskId: 'p1', ...shot(1280, 63), session: s }, d)
    const reused = await evidenceRequest('POST', 't1', {}, { subtaskId: 'p2', ...shot(1280, 63), session: s }, d)
    expect(reused.status).toBe(409); expect(reused.body).toMatchObject({ ok: false, error: 'evidence_reused' })
    expect((await evidenceRequest('POST', 't1', {}, { subtaskId: 'p1', kind: 'screenshot', bytesBase64: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64'), session: s }, d)).status).toBe(413)
    expect((await evidenceRequest('POST', 't1', {}, { subtaskId: 'nope', ...shot(1280, 64), session: s }, d)).status).toBe(404)
    expect((await evidenceRequest('POST', 't9', {}, { subtaskId: 'p1', ...shot(1280, 65), session: s }, d)).status).toBe(422) // the piece is not of that task
  })
  test('GET lists; DELETE removes by evidenceId (query or body); 405 for other methods', async () => {
    const { svc } = world(); const d = { service: svc, verify }; const s = { id: 'leader', token: 'ok' }
    const a = await evidenceRequest('POST', 't1', {}, { subtaskId: 'p1', ...shot(1280, 66), session: s }, d)
    const id = (a.body as { evidence: { id: string } }).evidence.id
    const list = await evidenceRequest('GET', 't1', { subtaskId: 'p1' }, {}, d)
    expect(list.status).toBe(200); expect((list.body as { evidence: unknown[] }).evidence).toHaveLength(1)
    const del = await evidenceRequest('DELETE', 't1', { subtaskId: 'p1', evidenceId: id }, { session: s }, d)
    expect(del.status).toBe(200)
    expect((await evidenceRequest('PUT', 't1', {}, {}, d)).status).toBe(405)
  })
})

describe('the real doors are wired (structural: index.ts routes, host composition)', () => {
  const src = (f: string) => readFileSync(join(import.meta.dir, f), 'utf8')
  test('POST|GET|DELETE /api/tasks/<ref>/evidence is matched BEFORE the generic /api/tasks/<ref> routes', () => {
    const idx = src('../index.ts')
    const evidence = idx.indexOf('const evidenceRoute = /^\\/api\\/tasks\\/([^/]+)\\/evidence$/')
    const generic = idx.indexOf("if (url.pathname.startsWith('/api/tasks/') && req.method === 'GET')")
    expect(evidence).toBeGreaterThan(-1); expect(generic).toBeGreaterThan(evidence)
    expect(idx).toMatch(/evidenceRoute && \(req\.method === 'POST' \|\| req\.method === 'GET' \|\| req\.method === 'DELETE'\)/)
    expect(idx).toMatch(/evidenceRequest\(req\.method, decodeURIComponent\(evidenceRoute\[1\]!\)/)
  })
  test('deleting a TaskFile asks the evidence book first (409 evidence_in_use) before removeFile', () => {
    const idx = src('../index.ts')
    const guard = idx.indexOf('evidenceFileInUse(fileId)')
    const remove = idx.indexOf('mod.removeFile(fileId)')
    expect(guard).toBeGreaterThan(-1); expect(remove).toBeGreaterThan(guard)
    expect(idx).toMatch(/error: 'evidence_in_use'[^}]*\}, 409\)/)
  })
  test('the host composition carries the evidence files (uploads become TaskFiles of the piece\'s task; fileId reads the task-aware reader)', () => {
    const host = src('host.ts')
    expect(host).toMatch(/evidenceFiles: \{[\s\S]*fetchFileWithTask[\s\S]*attachFile\(o\.taskId[\s\S]*removeFile/)
  })
})
