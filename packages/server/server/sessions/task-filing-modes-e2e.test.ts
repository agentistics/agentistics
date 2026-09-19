import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * End-to-end coverage of the three filing shapes from docs/superpowers/specs/
 * 2026-09-10-task-session-hierarchy-design.md (§7): a session may be filed DIRECTLY on a task, under
 * a SUBTASK, or a mix of both ("hybrid") — and the task-wide total must equal the exact sum of every
 * session filed anywhere under it, with nothing counted twice and nothing dropped. Extends
 * `s-3750c3f14f` (already landed, per the task-attach.test.ts / task-report.test.ts unit coverage) by
 * driving the invariant through the REAL write path (`attachSession`) and the REAL read path
 * (`showTask` → `buildTaskDetail` → `subtaskViews`/`rowsOfTask`), in the code's PRESENT state —
 * including §F's subtask-group hierarchy (docs/superpowers/specs/2026-09-11-alm-session-linking-ux.md
 * §F), which landed on top of the original 2026-09-10 design and changes how a GROUP and its MEMBERS
 * bucket (a member gets no bucket of its own; see `task-report.ts`'s `subtaskViews`).
 *
 * Out-of-process for the same reason `task-done-needs-session.test.ts`/`subtask-group-hierarchy.test.ts`
 * are: `loadTaskWorld()` reads the module-level `TASKS_FILE`/`MANAGED_SESSIONS_FILE` computed once at
 * `config.ts` load, so each scenario needs its own `AGENTISTICS_DIR` in its own process.
 */

const SESSIONS_DIR = import.meta.dir

async function run(body: string): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), 'agentop-filing-modes-e2e-'))
  const script = `
    const cfg = await import(${JSON.stringify(join(SESSIONS_DIR, '..', 'config.ts'))})
    const { createTaskStore } = await import(${JSON.stringify(join(SESSIONS_DIR, 'task-store.ts'))})
    const { createSessionRegistry } = await import(${JSON.stringify(join(SESSIONS_DIR, 'registry.ts'))})
    const web = await import(${JSON.stringify(join(SESSIONS_DIR, 'task-web.ts'))})
    const store = createTaskStore(cfg.TASKS_FILE)
    const registry = createSessionRegistry(cfg.MANAGED_SESSIONS_FILE)
    ${body}
  `
  const proc = Bun.spawn([process.execPath, '-e', script], {
    env: { ...process.env, AGENTISTICS_DIR: dir },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`script failed (${code}): ${err.trim().split('\n').slice(-8).join(' | ')}`)
  }
  const line = out.trim().split('\n').filter(Boolean).at(-1) ?? '{}'
  return JSON.parse(line)
}

const task = (id: string, over = '') => `
  await store.upsertTask({
    id: '${id}', title: '${id}', status: 'todo',
    createdAt: '2026-09-18T10:00:00.000Z', updatedAt: '2026-09-18T10:00:00.000Z',
    ${over}
  })
`
const subtask = (id: string, taskId: string, over = '') => `
  await store.upsertSubtask({
    id: '${id}', taskId: '${taskId}', title: '${id}', status: 'todo', done: false,
    createdAt: '2026-09-18T10:00:00.000Z', updatedAt: '2026-09-18T10:00:00.000Z',
    ${over}
  })
`
const session = (id: string, over = '') => `
  await registry.add({
    id: '${id}', harness: 'claude', cwd: '/tmp/x',
    createdAt: '2026-09-18T10:00:00.000Z',
    ${over}
  })
`

/** The shape every scenario below reads back and asserts against. */
interface FilingSnapshot {
  rollupSessionsUsed: number
  subtaskRollups: Array<{ id: string | null; sessionsUsed: number; hasGroupProgress: boolean }>
  sessions: Array<{ id: string; subtaskId: string | null }>
}

const snapshotScript = `
  const detail = (await web.showTask('t1')).task
  console.log(JSON.stringify({
    rollupSessionsUsed: detail.rollup.sessionsUsed,
    subtaskRollups: detail.subtaskRollups.map(v => ({
      id: v.id, sessionsUsed: v.rollup.sessionsUsed, hasGroupProgress: v.groupProgress !== undefined,
    })),
    sessions: detail.sessions.map(s => ({ id: s.id, subtaskId: s.subtaskId })),
  }))
`

/** No bucket claims a session it does not hold, and no session is claimed by two buckets. */
function assertPartition(snap: FilingSnapshot) {
  const bucketSum = snap.subtaskRollups.reduce((a, v) => a + v.sessionsUsed, 0)
  expect(bucketSum).toBe(snap.rollupSessionsUsed)
  expect(snap.sessions.length).toBe(snap.rollupSessionsUsed)
  // Every session's own `subtaskId` names exactly one bucket, and that bucket's count agrees.
  for (const bucket of snap.subtaskRollups) {
    const claimedBySessions = snap.sessions.filter(s => s.subtaskId === bucket.id).length
    expect(claimedBySessions).toBe(bucket.sessionsUsed)
  }
  // No session id appears twice in the raw list — the same "one conversation is one row" guarantee
  // `distinctConversations`/`rollupSessionsFor` state, checked here at the id level.
  expect(new Set(snap.sessions.map(s => s.id)).size).toBe(snap.sessions.length)
}

test('mode #1 — direct only: total matches the sum of direct sessions, subtaskRollups is just the id:null bucket', async () => {
  const snap = await run(`
    ${task('t1')}
    ${session('sess1')}
    ${session('sess2')}
    await web.attachSession('t1', 'sess1', {})
    await web.attachSession('t1', 'sess2', {})
    ${snapshotScript}
  `) as FilingSnapshot

  assertPartition(snap)
  expect(snap.rollupSessionsUsed).toBe(2)
  expect(snap.subtaskRollups).toEqual([{ id: null, sessionsUsed: 2, hasGroupProgress: false }])
})

test('mode #2 — subtasks only: total matches the sum across subtask buckets, no id:null bucket appears', async () => {
  const snap = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    ${subtask('s2', 't1')}
    ${subtask('s3', 't1')}
    ${session('sessA')}
    ${session('sessB')}
    ${session('sessC')}
    ${session('sessD')}
    await web.attachSession('t1', 'sessA', { subtaskId: 's1' })
    await web.attachSession('t1', 'sessB', { subtaskId: 's2' })
    // A subtask holds ANY NUMBER of sessions — a second one filed on s2, same shape as a piece of
    // work picked up again the next morning.
    await web.attachSession('t1', 'sessC', { subtaskId: 's2' })
    await web.attachSession('t1', 'sessD', { subtaskId: 's3' })
    ${snapshotScript}
  `) as FilingSnapshot

  assertPartition(snap)
  expect(snap.rollupSessionsUsed).toBe(4)
  expect(snap.subtaskRollups.find(v => v.id === null)).toBeUndefined()
  const byId = Object.fromEntries(snap.subtaskRollups.map(v => [v.id, v.sessionsUsed]))
  expect(byId).toEqual({ s1: 1, s2: 2, s3: 1 })
})

test('hybrid (mode #3) — some sessions direct, some under subtasks: total is the sum of BOTH, neither double-counted', async () => {
  const snap = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    ${subtask('s2', 't1')}
    ${session('direct1')}
    ${session('direct2')}
    ${session('sessS1')}
    ${session('sessS2')}
    await web.attachSession('t1', 'direct1', {})
    await web.attachSession('t1', 'direct2', {})
    await web.attachSession('t1', 'sessS1', { subtaskId: 's1' })
    await web.attachSession('t1', 'sessS2', { subtaskId: 's2' })
    ${snapshotScript}
  `) as FilingSnapshot

  assertPartition(snap)
  expect(snap.rollupSessionsUsed).toBe(4)
  const byId = Object.fromEntries(snap.subtaskRollups.map(v => [v.id, v.sessionsUsed]))
  expect(byId).toEqual({ null: 2, s1: 1, s2: 1 })
})

/**
 * The same hybrid scenario, but with a §F GROUP in the subtask list beside an ordinary loose
 * subtask, plus a group MEMBER present with no session of its own. Per §F.1
 * (docs/superpowers/specs/2026-09-11-alm-session-linking-ux.md):
 *  - A session may be filed on the GROUP itself, exactly like any other subtask.
 *  - A session may NEVER be filed on a group MEMBER — `planAttach` refuses it (`subtask_in_group`)
 *    — and a member therefore contributes no bucket of its own (`task-report.ts`'s `subtaskViews`
 *    excludes it outright rather than publishing an always-empty view for it).
 * The task-wide total must still be the exact sum of every session that exists (direct + loose
 * subtask + group), with the member's mere presence in the subtask list changing nothing.
 */
test('hybrid + §F group hierarchy: a group buckets its own sessions, a member contributes NO bucket and NEVER loses a session from the total', async () => {
  const snap = await run(`
    ${task('t1')}
    ${subtask('g1', 't1', 'isGroup: true,')}
    ${subtask('m1', 't1', "parentGroupId: 'g1',")}
    ${subtask('s1', 't1')}
    ${session('direct1')}
    ${session('sessLoose')}
    ${session('sessGroup')}
    ${session('sessRefused')}
    await web.attachSession('t1', 'direct1', {})
    await web.attachSession('t1', 'sessLoose', { subtaskId: 's1' })
    // Filed directly on the GROUP's own id — allowed, exactly like any other subtask.
    await web.attachSession('t1', 'sessGroup', { subtaskId: 'g1' })
    // Filing on the MEMBER is refused outright — the session must never end up anywhere.
    const refused = await web.attachSession('t1', 'sessRefused', { subtaskId: 'm1' })
    const detail = (await web.showTask('t1')).task
    console.log(JSON.stringify({
      refused,
      rollupSessionsUsed: detail.rollup.sessionsUsed,
      subtaskRollups: detail.subtaskRollups.map(v => ({
        id: v.id, sessionsUsed: v.rollup.sessionsUsed, hasGroupProgress: v.groupProgress !== undefined,
      })),
      sessions: detail.sessions.map(s => ({ id: s.id, subtaskId: s.subtaskId })),
    }))
  `) as FilingSnapshot & { refused: { ok: boolean; reason?: string } }

  expect(snap.refused).toEqual({ ok: false, reason: 'subtask_in_group' })
  assertPartition(snap)
  // The refused session never attached to anything — the total is exactly the 3 sessions that
  // actually succeeded, never 4 and never fewer.
  expect(snap.rollupSessionsUsed).toBe(3)
  expect(snap.sessions.map(s => s.id).sort()).toEqual(['direct1', 'sessGroup', 'sessLoose'])
  // No bucket at all for the member 'm1' — it is excluded outright, not published empty.
  expect(snap.subtaskRollups.find(v => v.id === 'm1')).toBeUndefined()
  const byId = Object.fromEntries(snap.subtaskRollups.map(v => [v.id, v.sessionsUsed]))
  expect(byId).toEqual({ null: 1, s1: 1, g1: 1 })
  // The group's own bucket carries a `groupProgress` (computed from its members' `done` status);
  // the loose subtask and the direct bucket carry none — neither has members to compute one over.
  expect(snap.subtaskRollups.find(v => v.id === 'g1')?.hasGroupProgress).toBe(true)
  expect(snap.subtaskRollups.find(v => v.id === 's1')?.hasGroupProgress).toBe(false)
  expect(snap.subtaskRollups.find(v => v.id === null)?.hasGroupProgress).toBe(false)
})
