/**
 * Test-only: a delivery service wired like production for the evidence doors — real git in a throwaway directory (GIT_*-free
 * helper), a real deliveries.json / guards.json in the caller's temp root, an in-memory TaskFile store, and a fixed clock.
 * Shared by the service, REST, CLI and MCP tests so every door is exercised against the SAME composition.
 */
import { join } from 'node:path'
import { createDeliveryService, type DeliveryService } from './service'
import { createDeliveryStore } from './store'
import { withEvidenceDeletion } from './evidence-delete'
import { execGit } from './classify-host'
import { gitSync, originWithClone, put } from './git-fixture.testing'

export const T = Date.parse('2026-11-13T10:00:00Z')
export const enc = (s: string) => new TextEncoder().encode(s)
export const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
export function png(w: number, h: number, salt = 0, total = 6000): Uint8Array {
  const b = new Uint8Array(total)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); const dv = new DataView(b.buffer)
  dv.setUint32(8, 13); b.set(enc('IHDR'), 12); dv.setUint32(16, w); dv.setUint32(20, h); b[100] = salt & 255; b[101] = (salt >> 8) & 255
  return b
}
export const shot = (w: number, salt = 0) => ({ kind: 'screenshot', bytesBase64: b64(png(w, 800, salt)), name: `s${salt}.png` })

export interface FileRec { taskId: string; name: string; bytes: Uint8Array; kind?: string }

/**
 * QA R8: the ONE rule for "may this TaskFile be deleted" is `withEvidenceDeletion` (the dead `svc.evidenceFileInUse` was a
 * second, lock-free copy). true = the gate refuses with `evidence_in_use`. Run as if the caller holds tasks.
 */
export async function fileInUse(root: string, fileId: string): Promise<boolean> {
  const paths = { tasks: join(root, 'tasks.json'), deliveries: join(root, 'deliveries.json'), guards: join(root, 'guards.json') }
  try { await withEvidenceDeletion({ fileId }, async () => true, { tasks: true }, paths); return false }
  catch (e) { if ((e as { code?: string }).code === 'evidence_in_use') return true; throw e }
}

export function makeWorld(root: string) {
  const files = new Map<string, FileRec>(); let n = 0
  const { repo } = originWithClone(root, 'r'); gitSync(repo, 'checkout', '-b', 'feat/x'); put(repo, 'packages/web/src/a.tsx'); gitSync(repo, 'add', '-A'); gitSync(repo, 'commit', '-m', 'web')
  const sessions = [
    { id: 'leader', role: 'leader', taskId: 't1', alive: true, cwd: repo, harness: 'claude', worktree: false },
    { id: 'worker', role: 'worker', taskId: 't1', subtaskId: 'p1', alive: true, cwd: repo, harness: 'claude', worktree: true, createdAt: '2026-11-13T09:00:00Z' },
    { id: 'worker2', role: 'worker', taskId: 't1', subtaskId: 'p2', alive: true, cwd: repo, harness: 'claude', worktree: true, createdAt: '2026-11-13T09:00:00Z' },
    { id: 'stranger', role: 'worker', taskId: 't9', subtaskId: 'zz', alive: true, cwd: '/nowhere', harness: 'claude', worktree: true },
  ]
  const guardsPath = join(root, 'guards.json')
  const svc = createDeliveryService({
    store: createDeliveryStore(join(root, 'deliveries.json')),
    facts: { subtask: async (id: string) => (['p1', 'p2'].includes(id) ? { id, taskId: 't1', title: id, status: 'in_progress', groupMember: false, blockedBy: [] } : null), sessions: async () => sessions } as never,
    board: { comment: async () => undefined } as never,
    notify: { session: async () => true, owner: async () => undefined } as never,
    autonomous: async () => true, emit: async () => undefined, now: () => T,
    classify: { sessions: async () => sessions, git: execGit },
    evidenceFiles: {
      read: async (id: string) => files.get(id) ?? null,
      create: async (o: { taskId: string; name: string; bytes: Uint8Array; kind?: string }) => { const id = `f-${++n}`; files.set(id, { taskId: o.taskId, name: o.name, bytes: o.bytes, kind: o.kind }); return id },
      remove: async (id: string) => files.delete(id),
    },
    guardsPath,
  } as never) as DeliveryService & Record<string, any>
  return { svc, repo, files, guardsPath, sessions }
}
