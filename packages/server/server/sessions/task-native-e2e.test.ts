import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Native sessions filed on the board, END TO END through the host's real write path (what
 * `EngineHostServices.tasks` calls — `fileNativeSession`, `reportNativeSessionUsage`, `detachSession`)
 * and the real read path (`showTask` / `listTasks`), against a real file-backed board. Out of process,
 * one per scenario, because `config.ts` resolves `AGENTISTICS_DIR` once at load.
 */
const SESSIONS_DIR = import.meta.dir
const SID = 'ses_' + 'a'.repeat(32)

async function run(body: string): Promise<any> {
  const dir = await mkdtemp(join(tmpdir(), 'agentop-native-'))
  const script = `
    const cfg = await import(${JSON.stringify(join(SESSIONS_DIR, '..', 'config.ts'))})
    const { createTaskStore } = await import(${JSON.stringify(join(SESSIONS_DIR, 'task-store.ts'))})
    const web = await import(${JSON.stringify(join(SESSIONS_DIR, 'task-web.ts'))})
    const store = createTaskStore(cfg.TASKS_FILE)
    const at = '2026-10-03T10:00:00.000Z'
    await store.upsertTask({ id: 't-1', title: 'Delivery', status: 'todo', createdAt: at, updatedAt: at })
    await store.upsertSubtask({ id: 's-1', taskId: 't-1', title: 'Sub', status: 'todo', done: false, createdAt: at, updatedAt: at })
    await store.upsertSubtask({ id: 's-2', taskId: 't-1', title: 'Blocked', status: 'todo', done: false, createdAt: at, updatedAt: at, blockedBy: ['s-1'] })
    const usage = (cost, when) => ({ responses: 2, rounds: 1, tokens: 900, costUSD: cost, costMeasured: true, model: 'm', updatedAt: when })
    ${body}
  `
  const proc = Bun.spawn([process.execPath, '-e', script], { env: { ...process.env, AGENTISTICS_DIR: dir }, stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  if ((await proc.exited) !== 0) throw new Error(`script failed: ${err.trim().split('\n').slice(-8).join(' | ')}`)
  return JSON.parse(out.trim().split('\n').filter(Boolean).at(-1) ?? '{}')
}

test('filed under a subtask, reported, it rolls up into the subtask, the task and the list', async () => {
  const out = await run(`
    const filed = await web.fileNativeSession({ sessionId: '${SID}', taskId: 't-1', subtaskId: 's-1', label: 'Native one', cwd: '/w' })
    const reported = await web.reportNativeSessionUsage('${SID}', usage(0.75, '2026-10-03T11:00:00.000Z'))
    const detail = (await web.showTask('t-1')).task
    const list = await web.listTasks()
    console.log(JSON.stringify({
      filed, reported,
      status: detail.task.status,
      rollup: detail.rollup,
      sub: detail.subtaskRollups.find(v => v.id === 's-1').rollup.costUSD,
      session: detail.sessions[0],
      listCost: list.tasks.find(t => t.task.id === 't-1').rollup.costUSD,
      events: (await store.read()).events.filter(e => e.kind === 'session').map(e => e.detail),
      where: await web.nativeFilingOf('${SID}'),
      nowhere: await web.nativeFilingOf('ses_' + 'c'.repeat(32)),
      all: await web.nativeFilingsAll(),
    }))
  `)
  expect(out.filed).toEqual({ ok: true, id: `native:${SID}` })
  expect(out.reported).toBe(true)
  expect(out.status).not.toBe('todo')
  expect(out.rollup).toMatchObject({ sessionsUsed: 1, costUSD: 0.75, tokens: 900, rounds: 1, costMeasuredSessions: 1 })
  expect(out.sub).toBe(0.75)
  expect(out.session).toMatchObject({ native: true, harness: 'agentistics', conversationId: SID, label: 'Native one', costUSD: 0.75 })
  expect(out.listCost).toBe(0.75)
  expect(out.events).toEqual(['agentistics · native'])
  expect(out.where).toEqual({ taskId: 't-1', taskTitle: 'Delivery', subtaskId: 's-1' })
  expect(out.nowhere).toBeNull()
  // UI.UNIFY: the whole board at once, for the fleet list's native rows — with the engine's cost.
  expect(out.all).toEqual({ [SID]: { taskId: 't-1', taskTitle: 'Delivery', subtaskId: 's-1', costUSD: 0.75, tokens: 900 } })
}, 60000)

test('refused like a fleet filing: no task, foreign subtask, blocked subtask, a forged id', async () => {
  const out = await run(`
    console.log(JSON.stringify([
      await web.fileNativeSession({ sessionId: '${SID}', taskId: 'nope' }),
      await web.fileNativeSession({ sessionId: '${SID}', taskId: 't-1', subtaskId: 'nope' }),
      await web.fileNativeSession({ sessionId: '${SID}', taskId: 't-1', subtaskId: 's-2' }),
      await web.fileNativeSession({ sessionId: '../etc', taskId: 't-1' }),
      (await store.read()).nativeSessions.length,
    ]))
  `)
  expect(out[0]).toEqual({ ok: false, reason: 'no_such_task' })
  expect(out[1].ok).toBe(false)
  expect(out[2]).toMatchObject({ ok: false, reason: 'blocked', blockedBy: ['s-1'] })
  expect(out[3]).toEqual({ ok: false, reason: 'bad_session' })
  expect(out[4]).toBe(0)
}, 60000)

test('a usage report never files; detach by the link id unfiles it', async () => {
  const out = await run(`
    const before = await web.reportNativeSessionUsage('${SID}', usage(1, '2026-10-03T11:00:00.000Z'))
    await web.fileNativeSession({ sessionId: '${SID}', taskId: 't-1' })
    const detached = await web.detachSession('${SID}')
    console.log(JSON.stringify({ before, detached, left: (await store.read()).nativeSessions.length }))
  `)
  expect(out).toEqual({ before: false, detached: true, left: 0 })
}, 60000)
