import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Native runtime sessions filed under a task (`attachNativeSession` / `nativeSessionTask`, harness
 * TUI D-TUI-6). Each scenario runs in its OWN process pointed at its own `AGENTISTICS_DIR`, the shape
 * `task-done-needs-session.test.ts` documents: `TASKS_FILE` is fixed at `config.ts` import time.
 */
const SESSIONS_DIR = import.meta.dir

async function run(body: string): Promise<any> {
  const dir = await mkdtemp(join(tmpdir(), 'agentop-native-link-'))
  const script = `
    const cfg = await import(${JSON.stringify(join(SESSIONS_DIR, '..', 'config.ts'))})
    const { createTaskStore } = await import(${JSON.stringify(join(SESSIONS_DIR, 'task-store.ts'))})
    const web = await import(${JSON.stringify(join(SESSIONS_DIR, 'task-web.ts'))})
    const store = createTaskStore(cfg.TASKS_FILE)
    const mk = (id, status = 'todo') => store.upsertTask({
      id, title: id, status, createdAt: '2026-09-28T10:00:00.000Z', updatedAt: '2026-09-28T10:00:00.000Z',
    })
    ${body}
  `
  const proc = Bun.spawn([process.execPath, '-e', script], {
    env: { ...process.env, AGENTISTICS_DIR: dir }, stdout: 'pipe', stderr: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  if ((await proc.exited) !== 0) throw new Error(`script failed: ${err.trim().split('\n').slice(-8).join(' | ')}`)
  return JSON.parse(out.trim().split('\n').filter(Boolean).at(-1) ?? '{}')
}

test('files a native session, names the task back, and survives a re-read of the book', async () => {
  const r = await run(`
    await mk('t-a')
    const filed = await web.attachNativeSession('t-a', 'ses_1', { title: 'first' })
    const again = await createTaskStore(cfg.TASKS_FILE).read()
    const back = await web.nativeSessionTask('ses_1')
    console.log(JSON.stringify({ filed, links: again.nativeSessions, back, status: again.tasks[0].status }))
  `)
  expect(r.filed.ok).toBe(true)
  expect(r.links).toHaveLength(1)
  expect(r.links[0]).toMatchObject({ id: 'native:ses_1', sessionId: 'ses_1', taskId: 't-a', title: 'first' })
  expect(r.back).toMatchObject({ taskId: 't-a', title: 't-a' })
  // Filing is the evidence work began — same one-directional advance attachConversation makes.
  expect(r.status).toBe('in_progress')
})

test('a second filing MOVES the link and says where it came from', async () => {
  const r = await run(`
    await mk('t-a'); await mk('t-b')
    await web.attachNativeSession('t-a', 'ses_1')
    const moved = await web.attachNativeSession('t-b', 'ses_1')
    const book = await store.read()
    console.log(JSON.stringify({ moved, links: book.nativeSessions }))
  `)
  expect(r.moved.ok).toBe(true)
  expect(r.moved.movedFrom).toEqual({ taskId: 't-a' })
  expect(r.links).toHaveLength(1)
  expect(r.links[0].taskId).toBe('t-b')
})

test('refuses a done task and an unknown task, and writes nothing', async () => {
  const r = await run(`
    await mk('t-done', 'done')
    const done = await web.attachNativeSession('t-done', 'ses_1')
    const unknown = await web.attachNativeSession('t-nope', 'ses_1')
    const book = await store.read()
    console.log(JSON.stringify({ done, unknown, links: book.nativeSessions, none: await web.nativeSessionTask('ses_1') }))
  `)
  expect(r.done).toEqual({ ok: false, reason: 'task_done' })
  expect(r.unknown).toEqual({ ok: false, reason: 'no_such_task' })
  expect(r.links).toEqual([])
  expect(r.none).toBeNull()
})

test('a book written before native links existed reads as an empty list and keeps its other keys', async () => {
  const r = await run(`
    const { writeFile, mkdir } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    await mkdir(dirname(cfg.TASKS_FILE), { recursive: true })
    await writeFile(cfg.TASKS_FILE, JSON.stringify({ tasks: [{ id: 't-old', title: 'old', status: 'todo', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }], historicalSessions: [{ conversationId: 'c1', taskId: 't-old', harness: 'claude', linkedAt: '2026-01-01T00:00:00.000Z' }] }))
    const before = await store.read()
    await web.attachNativeSession('t-old', 'ses_9')
    const after = await store.read()
    console.log(JSON.stringify({ before: before.nativeSessions, hist: after.historicalSessions.length, after: after.nativeSessions.length }))
  `)
  expect(r.before).toEqual([])
  expect(r.hist).toBe(1)
  expect(r.after).toBe(1)
})
