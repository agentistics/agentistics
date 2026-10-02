/**
 * engine-board.ts — `EngineHostServices.tasks.board` (engine-api 1.7, B6.5): the task board's own
 * operations for a native session's `board.*` tools, IN PROCESS. No HTTP loopback and no second auth
 * path: each operation calls the SAME `task-web` function its `/api/tasks` route calls, and answers
 * with that route's body, or with its refusal (`reason` + the route's HTTP status), never a throw.
 *
 * The engine's policy has already judged the call (reads free, writes under the session's grant).
 * The host still holds its own lines here:
 * - the operation set is CLOSED — no delete, no status-vocabulary edit, no session filing (that is
 *   `fileNative`);
 * - `attach` re-checks kind, count and size, and stores bytes through the chat's attachment store
 *   (`storeAttachment`), never a path;
 * - every write is recorded in the board's own activity log under its actor (`native:<session>`).
 *
 * The functions are injected (`BoardDeps`) so the mapping is tested without a board on disk.
 */
import type { EngineBoard, EngineBoardAnswer } from '@agentistics/engine-api'

export const BOARD_ATTACH_MAX_FILES = 10
export const BOARD_ATTACH_MAX_BYTES = 20 * 1024 * 1024
const ATTACH_KINDS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'mp4', 'm4v', 'mov', 'webm', 'ogv', 'pdf'])

type R<T> = Promise<T>
export interface BoardDeps {
  listTasks(): R<unknown>
  showTask(ref: string): R<unknown | null>
  nextTasks(o: { actor?: string; limit?: number }): R<unknown>
  taskActivity(o: { ref?: string; limit?: number }): R<unknown>
  createTask(o: { title: string; detail?: string }): R<unknown | null>
  addSubtask(ref: string, title: string, o: { isGroup?: boolean }): R<string | null>
  patchSubtask(id: string, patch: Record<string, unknown>): R<{ ok: boolean; message?: string }>
  setSubtaskDone(id: string, done: boolean): R<{ ok: boolean; message?: string }>
  addComment(ref: string, o: { author: string; body: string; subtaskId?: string; attachments?: unknown }): R<{ ok: true; id: string } | { ok: false; reason: string; message: string }>
  markTask(ref: string, to: string, actor: string | undefined, o: { reason?: string; blockedBy?: readonly string[] }): R<{ ok: boolean; message?: string }>
  claimTask(o: { ref: string; by: string; leaseMs?: number; sessionId?: string; note?: string; takeover?: boolean }): R<{ ok: boolean; reason?: string; heldBy?: string }>
  releaseTask(o: { ref: string; by: string }): R<{ ok: boolean; reason?: string; heldBy?: string }>
  storeAttachment(file: { name: string; bytes: Uint8Array }, sessionId: string): R<{ ok: boolean; path?: string; name?: string; message?: string }>
}

const ok = (body: unknown): EngineBoardAnswer => ({ ok: true, body })
const no = (status: number, reason: string, body?: unknown): EngineBoardAnswer => ({ ok: false, status, reason, ...(body !== undefined ? { body } : {}) })

/** The subtask columns an engine may edit — the `/subtasks` route's own list, minus the UI-only ones. */
const SUBTASK_COLUMNS = ['title', 'status', 'dueDate', 'startDate', 'parentGroupId'] as const

async function guarded(f: () => Promise<EngineBoardAnswer>): Promise<EngineBoardAnswer> {
  try { return await f() } catch { return no(500, 'internal') }
}

export function createEngineBoard(d: BoardDeps): EngineBoard {
  return {
    list: () => guarded(async () => ok(await d.listTasks())),
    get: ref => guarded(async () => { const t = await d.showTask(ref); return t === null ? no(404, 'no_such_task') : ok(t) }),
    next: q => guarded(async () => ok(await d.nextTasks(q))),
    activity: q => guarded(async () => ok({ events: await d.taskActivity(q) })),
    create: t => guarded(async () => {
      const made = await d.createTask({ title: t.title, ...(t.detail !== undefined ? { detail: t.detail } : {}) })
      return made === null ? no(400, 'title_required') : ok({ task: made })
    }),
    subtask: (ref, p) => guarded(async () => {
      if (typeof p.id !== 'string') {
        const id = await d.addSubtask(ref, String(p.title ?? ''), p.isGroup === true ? { isGroup: true } : {})
        return id === null ? no(400, 'title_required_or_no_such_task') : ok({ ok: true, id })
      }
      const cols = Object.fromEntries(SUBTASK_COLUMNS.filter(c => typeof p[c] === 'string').map(c => [c, p[c]]))
      const blocked = Array.isArray(p.blockedBy) ? { blockedBy: p.blockedBy.filter((x): x is string => typeof x === 'string') } : {}
      const r = Object.keys(cols).length === 0 && !('blockedBy' in blocked) && typeof p.done === 'boolean'
        ? await d.setSubtaskDone(p.id, p.done)
        : await d.patchSubtask(p.id, { ...cols, ...blocked })
      if (r.ok) return ok(r)
      const m = r.message ?? 'refused'
      return no(m === 'unknown_status' ? 400 : m === 'no_such_subtask' ? 404 : 422, m, r)
    }),
    comment: (ref, c) => guarded(async () => {
      const r = await d.addComment(ref, { author: c.author, body: c.body, ...(c.subtaskId ? { subtaskId: c.subtaskId } : {}) })
      return r.ok ? ok(r) : no(r.reason === 'no_such_task' ? 404 : r.reason === 'empty' ? 400 : 422, r.reason, r)
    }),
    status: (ref, s) => guarded(async () => {
      if (!s.status.trim()) return no(400, 'bad_status')
      const r = await d.markTask(ref, s.status, s.actor, { ...(s.reason ? { reason: s.reason } : {}), ...(s.blockedBy ? { blockedBy: s.blockedBy } : {}) })
      if (r.ok) return ok(r)
      const m = r.message ?? 'refused'
      return no(m === 'unknown_status' ? 400 : m === 'blocked_needs_reason' || m === 'done_needs_session' ? 422 : 404, m, r)
    }),
    claim: (ref, c) => guarded(async () => {
      const r = c.release
        ? await d.releaseTask({ ref, by: c.by })
        : await d.claimTask({ ref, by: c.by, sessionId: c.sessionId, ...(c.leaseMs !== undefined ? { leaseMs: c.leaseMs } : {}), ...(c.note ? { note: c.note } : {}), ...(c.takeover ? { takeover: true } : {}) })
      return r.ok ? ok(r) : no(r.reason === 'no_such_task' ? 404 : 409, r.reason ?? 'refused', r)
    }),
    attach: (ref, a) => guarded(async () => {
      if (a.files.length === 0) return no(400, 'no_files')
      if (a.files.length > BOARD_ATTACH_MAX_FILES) return no(400, 'too_many_files')
      for (const f of a.files) {
        const ext = f.name.includes('.') ? f.name.slice(f.name.lastIndexOf('.') + 1).toLowerCase() : ''
        if (!ATTACH_KINDS.has(ext)) return no(400, 'unsupported_kind', { name: f.name })
        if (f.bytes.byteLength === 0) return no(400, 'empty_file', { name: f.name })
        if (f.bytes.byteLength > BOARD_ATTACH_MAX_BYTES) return no(413, 'too_large', { name: f.name })
      }
      const stored: Array<{ name: string; path: string }> = []
      for (const f of a.files) {
        const s = await d.storeAttachment(f, a.sessionId)
        if (!s.ok || !s.path) return no(422, s.message ?? 'upload_failed', { name: f.name })
        stored.push({ name: s.name ?? f.name, path: s.path })
      }
      const r = await d.addComment(ref, { author: a.author, body: a.note ?? '', attachments: stored, ...(a.subtaskId ? { subtaskId: a.subtaskId } : {}) })
      return r.ok ? ok({ ...r, attached: stored.length }) : no(r.reason === 'no_such_task' ? 404 : 422, r.reason, r)
    }),
  }
}

/** The real board: `task-web` and the chat's attachment store, loaded on first use. */
export function hostEngineBoard(lang: () => 'en' | 'pt'): EngineBoard {
  const tw = () => import('../sessions/task-web')
  const aw = () => import('../sessions/attachment-web')
  return createEngineBoard({
    listTasks: async () => (await tw()).listTasks(),
    showTask: async ref => (await tw()).showTask(ref),
    nextTasks: async o => (await tw()).nextTasks(o),
    taskActivity: async o => (await tw()).taskActivity(o),
    createTask: async o => (await tw()).createTask(o),
    addSubtask: async (ref, title, o) => (await tw()).addSubtask(ref, title, o),
    patchSubtask: async (id, patch) => (await tw()).patchSubtask(id, patch as never),
    setSubtaskDone: async (id, done) => (await tw()).setSubtaskDone(id, done) as Promise<{ ok: boolean; message?: string }>,
    addComment: async (ref, o) => (await tw()).addComment(ref, o),
    markTask: async (ref, to, actor, o) => (await tw()).markTask(ref, to as never, actor, o),
    claimTask: async o => (await tw()).claimTask(o),
    releaseTask: async o => (await tw()).releaseTask(o),
    storeAttachment: async (f, sessionId) => (await aw()).storeAttachment(lang(), f, sessionId),
  })
}
