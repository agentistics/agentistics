/**
 * QA r2 F1 — the classification host is WIRED in the real composition. `deliveryService()` (the one the CLI, the HTTP
 * route and therefore the MCP use) used to omit `classify`, so every real door answered 501. These tests build the service
 * through the host's own factory — overriding only the board/registry facts, never `classify` — and drive the real doors.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deliveryService } from './host'
import { createDeliveryStore } from './store'
import { deliveryRequest } from './web'
import { runDeliveryCli } from './cli'
import { forgetClassifyCache } from './classify-host'
import { gitSync, originWithClone, put } from './git-fixture.testing'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'host-classify-')); forgetClassifyCache() })
afterEach(() => rmSync(root, { recursive: true, force: true }))

function hostService() {
  const { repo } = originWithClone(root, 'r')
  gitSync(repo, 'checkout', '-b', 'feat/x'); put(repo, 'packages/web/src/a.tsx'); gitSync(repo, 'add', '-A'); gitSync(repo, 'commit', '-m', 'web'); gitSync(repo, 'push', '-u', 'origin', 'feat/x')
  const head = gitSync(repo, 'rev-parse', 'HEAD')
  const sessions = [
    { id: 'leader', role: 'leader', taskId: 't1', alive: true, cwd: repo, harness: 'claude', worktree: false },
    { id: 'worker', role: 'worker', taskId: 't1', subtaskId: 'p1', alive: true, cwd: '/nowhere', harness: 'claude', worktree: true },
  ]
  const comments: string[] = []
  // NOTE: no `classify` here. Everything else is a fake so nothing touches the real registry or board.
  const svc = deliveryService({
    store: createDeliveryStore(join(root, 'deliveries.json')),
    facts: { subtask: async (id: string) => (id === 'p1' ? { id, taskId: 't1', title: 'p', status: 'in_progress', groupMember: false, blockedBy: [] } : null), sessions: async () => sessions } as never,
    board: { comment: async (_t: string, _s: string, b: string) => { comments.push(b) } } as never,
    notify: { session: async () => true, owner: async () => undefined } as never,
    autonomous: async () => true, emit: async () => undefined, now: () => Date.parse('2026-11-13T10:00:00Z'),
  })
  return { svc, repo, head, comments }
}
const io = () => { const out: string[] = []; const err: string[] = []; return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } } }

describe('the composition the real doors use carries the classification host', () => {
  test('the service: a leader\'s declaration is NOT classify_unavailable (501)', async () => {
    const { svc, repo, head } = hostService()
    const r = await svc.classify('p1', { repo, head }, 'leader')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.classification).toMatchObject({ category: 'screen', headSha: head })
  })
  test('REST: POST /api/deliveries/<piece> action classify → 200 with the derived category; a worker → 403', async () => {
    const { svc, repo, head } = hostService()
    const verify = async (id: unknown) => (id === 'leader' || id === 'worker' ? String(id) : null)
    const ok = await deliveryRequest('POST', '/api/deliveries/p1', { action: 'classify', repo, head, session: { id: 'leader', token: 't' } }, { service: svc, verify } as never)
    expect(ok.status).toBe(200); expect(ok.body).toMatchObject({ ok: true, classification: { category: 'screen', headSha: head } })
    const denied = await deliveryRequest('POST', '/api/deliveries/p1', { action: 'classify', repo, head, session: { id: 'worker', token: 't' } }, { service: svc, verify } as never)
    expect(denied.status).toBe(403); expect(denied.body).toMatchObject({ error: 'classify_leader_only' })
  })
  test('CLI: `agentop flow classify <piece> --repo --head` prints the classification and exits 0', async () => {
    const { svc, repo, head } = hostService(); const { out, io: i } = io()
    const code = await runDeliveryCli(['classify', 'p1', '--repo', repo, '--head', head], i, { AGENTOP_MANAGED_ID: 'leader' }, svc)
    expect(code).toBe(0); expect(JSON.parse(out.join('\n'))).toMatchObject({ ok: true, classification: { category: 'screen', headSha: head } })
  })
  test('the production entry points obtain the service from the host factory with no override (so the wiring above is what runs)', () => {
    const src = (f: string) => readFileSync(join(import.meta.dir, f), 'utf8')
    expect(src('cli.ts')).toMatch(/\(await import\('\.\/host'\)\)\.deliveryService\(\)/)
    expect(src('../index.ts')).toMatch(/deliveryService\(\)/)
  })
})
