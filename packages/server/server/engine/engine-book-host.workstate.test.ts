import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * LIVRO.SEAMS 3b (M3): the bookmark's live state is the host's `workState`, read off a REAL task board and a REAL
 * roles document. `loadTaskWorld` / `storedRoleFor` read files fixed by `config.ts` at module load, so the
 * scenario runs in its own process pointed at its own `AGENTISTICS_DIR` (the `task-leader-only.test.ts` shape).
 */
const DIR = import.meta.dir

test('workState: current subtask from the board, verified handbacks only, roles found by conversation id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentop-book-workstate-'))
  try {
    const script = `
      const cfg = await import(${JSON.stringify(join(DIR, '..', 'config.ts'))})
      const { createTaskStore } = await import(${JSON.stringify(join(DIR, '..', 'sessions', 'task-store.ts'))})
      const { createBookHost } = await import(${JSON.stringify(join(DIR, 'engine-book-host.ts'))})
      const { writeFile, mkdir } = await import('node:fs/promises')
      const store = createTaskStore(cfg.TASKS_FILE)
      const T = '2026-11-12T10:00:00.000Z'
      await store.upsertTask({ id: 't-1', title: 't-1', status: 'in_progress', createdAt: T, updatedAt: T })
      await store.upsertTask({ id: 't-2', title: 't-2', status: 'in_progress', createdAt: T, updatedAt: T })
      const sub = (id, taskId, status, updatedAt) => store.upsertSubtask({ id, taskId, title: id, status, done: status === 'done', createdAt: T, updatedAt })
      await sub('s-late', 't-1', 'in_progress', '2026-11-12T11:00:00.000Z')
      await sub('s-early', 't-1', 'in_progress', '2026-11-12T10:30:00.000Z')
      await sub('s-queued', 't-1', 'todo', '2026-11-12T10:10:00.000Z')
      await sub('s-done', 't-1', 'done', '2026-11-12T09:00:00.000Z')
      await sub('s-other', 't-2', 'in_progress', '2026-11-12T08:00:00.000Z')
      const c = (id, over) => store.addComment({ id, taskId: 't-1', author: 'x', body: 'b', createdAt: T, kind: 'handback', ...over })
      await c('c-verified', { role: 'session', sessionId: 'worker-1', createdAt: '2026-11-12T10:40:00.000Z' })
      await c('c-claimed', { author: 'worker-1' })
      await c('c-owner', { role: 'owner' })
      await store.addComment({ id: 'c-note', taskId: 't-1', author: 'x', body: 'b', createdAt: T, role: 'session', sessionId: 'worker-1' })
      await store.addComment({ id: 'c-elsewhere', taskId: 't-2', author: 'x', body: 'b', createdAt: T, kind: 'handback', role: 'session', sessionId: 'w9' })
      await mkdir(cfg.AGENTISTICS_DATA_DIR, { recursive: true })
      // Roles are stored under the CONVERSATION id only, as a session that was linked before being reopened has them.
      await writeFile(cfg.AGENTISTICS_DATA_DIR + '/session-roles.json', JSON.stringify({ version: 1, migrated: true, roles: { 'conv-lead': 'leader', 'conv-worker': 'worker' }, at: {}, origins: {}, lastDeliveredRole: {} }))
      const rows = [
        { id: 'lead-1', harness: 'claude', cwd: '/w', taskId: 't-1', conversationId: 'conv-lead' },
        { id: 'worker-1', harness: 'codex', cwd: '/w', taskId: 't-1', subtaskId: 's-early', conversationId: 'conv-worker' },
        { id: 'stray-1', harness: 'claude', cwd: '/w', taskId: 't-1', conversationId: 'conv-stray' },
        { id: 'lead-2', harness: 'claude', cwd: '/w', taskId: 't-2', conversationId: 'conv-lead' },
      ]
      const host = createBookHost({ registry: async () => rows, spawn: async () => ({ ok: false, message: '' }), kill: async () => ({ ok: true }), requestRetire: async () => false, verify: async () => null })
      console.log(JSON.stringify(await host.workState('t-1')))
    `
    const proc = Bun.spawn([process.execPath, '-e', script], { env: { ...process.env, AGENTISTICS_DIR: dir }, stdout: 'pipe', stderr: 'pipe' })
    const out = await new Response(proc.stdout).text()
    const err = await new Response(proc.stderr).text()
    expect({ code: await proc.exited, err: err.trim().split('\n').slice(-5).join(' | ') }).toMatchObject({ code: 0 })
    const state = JSON.parse(out.trim().split('\n').at(-1)!)
    expect(state.source).toBe('host')
    // The oldest-updated in_progress subtask of THIS task, from the board.
    expect(state.currentWork).toEqual({ source: 'board', subtaskId: 's-early', pageIds: [] })
    expect(state.nextStep).toEqual({ source: 'queue', id: 's-queued', pageIds: [] })
    // Only the handback a verified session posted; a claimed author, the owner and a plain note are not handbacks.
    expect(state.lastHandbacks).toEqual([{ sessionId: 'worker-1', pageId: 'c-verified', at: '2026-11-12T10:40:00.000Z' }])
    // Roles resolve by conversation id; a row with no role is not a book session.
    expect(state.open.sessions).toEqual([
      { id: 'lead-1', role: 'leader', state: 'running', harness: 'claude' },
      { id: 'worker-1', role: 'worker', state: 'running', harness: 'codex', subtaskId: 's-early' },
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
