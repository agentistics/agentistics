import { expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Historical conversations, END TO END through the real write path (`attachConversation`) and the
 * real read path (`showTask` / `listTasks`), against a real file-backed board, registry and
 * consolidate store — no mocks.
 *
 * Out-of-process for the reason `task-done-needs-session.test.ts` states: `config.ts` resolves its
 * paths once at module load from `AGENTISTICS_DIR`, so each scenario runs in its OWN process.
 */

const SESSIONS_DIR = import.meta.dir

async function run(body: string): Promise<{ out: any; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'agentop-historical-'))
  const script = `
    const cfg = await import(${JSON.stringify(join(SESSIONS_DIR, '..', 'config.ts'))})
    const { createTaskStore } = await import(${JSON.stringify(join(SESSIONS_DIR, 'task-store.ts'))})
    const { createSessionRegistry } = await import(${JSON.stringify(join(SESSIONS_DIR, 'registry.ts'))})
    const { writeConsolidated } = await import(${JSON.stringify(join(SESSIONS_DIR, '..', 'consolidate.ts'))})
    const web = await import(${JSON.stringify(join(SESSIONS_DIR, 'task-web.ts'))})
    const source = await import(${JSON.stringify(join(SESSIONS_DIR, 'task-source.ts'))})
    const report = await import(${JSON.stringify(join(SESSIONS_DIR, 'task-report.ts'))})
    const conv = await import(${JSON.stringify(join(SESSIONS_DIR, 'task-conversations.ts'))})
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
  return { out: JSON.parse(out.trim().split('\n').filter(Boolean).at(-1) ?? '{}'), dir }
}

const task = (id: string, over = '') => `
  await store.upsertTask({
    id: '${id}', title: '${id}', status: 'todo',
    createdAt: '2026-09-11T10:00:00.000Z', updatedAt: '2026-09-11T10:00:00.000Z',
    ${over}
  })
`
const subtask = (id: string, taskId: string, over = '') => `
  await store.upsertSubtask({
    id: '${id}', taskId: '${taskId}', title: '${id}', status: 'todo', done: false,
    createdAt: '2026-09-11T10:00:00.000Z', updatedAt: '2026-09-11T10:00:00.000Z',
    ${over}
  })
`
const session = (id: string, over = '') => `
  await registry.add({
    id: '${id}', harness: 'claude', cwd: '/tmp/x',
    createdAt: '2026-09-11T10:00:00.000Z',
    ${over}
  })
`
/** A conversation in the consolidate store — 100 in + 50 out on sonnet-5, so its cost is a constant. */
const meta = (id: string, over = '') => `
  await writeConsolidated([{
    session_id: '${id}', project_path: '/nonexistent/proj', start_time: '2026-09-10T09:00:00.000Z',
    end_time: '2026-09-10T09:30:00.000Z', duration_minutes: 30, harness: 'claude',
    model: 'claude-sonnet-5', input_tokens: 100, output_tokens: 50,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0, user_message_count: 4,
    first_prompt: 'prompt ${id}', git_remote: 'github.com/org/repo',
    ${over}
  }])
`

test('files a conversation with no registry row on a SUBTASK, and every rollup counts it', async () => {
  const { out } = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    ${meta('c1')}
    const before = await web.showTask('t1')
    const filed = await web.attachConversation('t1', 'c1', { subtaskId: 's1' })
    const after = await web.showTask('t1')
    const list = await web.listTasks()
    console.log(JSON.stringify({
      filed, beforeSessions: before.task.sessions.length,
      sessions: after.task.sessions, rollup: after.task.rollup,
      subtaskRollup: after.task.subtaskRollups.find(v => v.id === 's1').rollup,
      headline: { s: list.overview.totalSessions, t: list.overview.totalTokens, c: list.overview.totalCostUSD },
      rowRollup: list.tasks[0].rollup,
    }))
  `)
  expect(out.filed).toEqual({ ok: true, id: 'hist:c1', conversationId: 'c1', harness: 'claude' })
  expect(out.beforeSessions).toBe(0)
  expect(out.sessions).toHaveLength(1)
  expect(out.sessions[0]).toMatchObject({
    id: 'hist:c1', historical: true, subtaskId: 's1', conversationId: 'c1', tokens: 150, rounds: 4,
    harness: 'claude', cwd: '/nonexistent/proj', label: 'prompt c1',
  })
  expect(out.rollup.sessionsUsed).toBe(1)
  expect(out.subtaskRollup.sessionsUsed).toBe(1)
  expect(out.headline.s).toBe(1)
  expect(out.headline.t).toBe(150)
  // The headline is the same figure the delivery holds — nothing counted twice, nothing extra.
  expect(out.headline.c).toBe(out.rollup.costUSD)
  expect(out.rowRollup.costUSD).toBe(out.rollup.costUSD)
  expect(out.rollup.costUSD).toBeGreaterThan(0)
})

test('writes NOTHING to the fleet registry — no stub row, ever', async () => {
  const { out, dir } = await run(`
    ${task('t1')}
    ${meta('c1')}
    await web.attachConversation('t1', 'c1')
    const reg = await registry.read()
    console.log(JSON.stringify({ registryRows: reg.length }))
  `)
  expect(out.registryRows).toBe(0)
  const raw = await readFile(join(dir, 'managed-sessions.json'), 'utf8').catch(() => '[]')
  expect(raw).not.toContain('hist:')
  expect(await readFile(join(dir, 'tasks.json'), 'utf8')).toContain('hist:c1')
})

test('every refusal is its own code and writes nothing', async () => {
  const { out } = await run(`
    ${task('t1')}
    ${task('t2')}
    ${subtask('g1', 't1', 'isGroup: true,')}
    ${subtask('m1', 't1', "parentGroupId: 'g1',")}
    ${subtask('s1', 't1', "blockedBy: ['sBlocker'],")}
    ${subtask('sBlocker', 't1')}
    ${subtask('sOther', 't2')}
    ${meta('c1')}
    ${meta('cLive')}
    ${session('live1', "conversationId: 'cLive', taskId: 't2',")}
    const r = {}
    r.noTask = await web.attachConversation('nope', 'c1')
    r.noConversation = await web.attachConversation('t1', 'ghost')
    r.inFleet = await web.attachConversation('t1', 'cLive')
    r.noSubtask = await web.attachConversation('t1', 'c1', { subtaskId: 'nope' })
    r.member = await web.attachConversation('t1', 'c1', { subtaskId: 'm1' })
    r.blocked = await web.attachConversation('t1', 'c1', { subtaskId: 's1' })
    r.wrongDelivery = await web.attachConversation('t1', 'c1', { subtaskId: 'sOther' })
    r.wrongHarness = await web.attachConversation('t1', 'c1', { harness: 'codex' })
    r.links = (await store.read()).historicalSessions.length
    console.log(JSON.stringify(r))
  `)
  expect(out.noTask).toEqual({ ok: false, reason: 'no_such_task' })
  expect(out.noConversation).toEqual({ ok: false, reason: 'no_such_conversation' })
  expect(out.wrongHarness).toEqual({ ok: false, reason: 'no_such_conversation' })
  // The answer names the row to file instead.
  expect(out.inFleet).toEqual({ ok: false, reason: 'conversation_in_fleet', sessionId: 'live1' })
  expect(out.noSubtask).toEqual({ ok: false, reason: 'no_such_subtask' })
  expect(out.member).toEqual({ ok: false, reason: 'subtask_in_group' })
  expect(out.blocked).toEqual({ ok: false, reason: 'blocked', blockedBy: ['sBlocker'] })
  expect(out.wrongDelivery).toEqual({ ok: false, reason: 'wrong_delivery' })
  expect(out.links).toBe(0)
})

test('the done gate counts a historical link: the recovered subtask can now close', async () => {
  const { out } = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    ${meta('c1')}
    const refused = await web.setSubtaskDone('s1', true)
    await web.attachConversation('t1', 'c1', { subtaskId: 's1' })
    const allowed = await web.setSubtaskDone('s1', true)
    console.log(JSON.stringify({ refused, allowed, status: (await store.read()).subtasks[0].status }))
  `)
  expect(out.refused).toEqual({ ok: false, message: 'done_needs_session' })
  expect(out.allowed).toEqual({ ok: true })
  expect(out.status).toBe('done')
})

test('markTask done counts a conversation filed on a subtask or on the delivery itself', async () => {
  const { out } = await run(`
    ${task('t1')}
    ${task('t2')}
    ${subtask('s1', 't2')}
    ${meta('c1')}
    ${meta('c2')}
    const refused = await web.markTask('t1', 'done')
    await web.attachConversation('t1', 'c1')
    await web.attachConversation('t2', 'c2', { subtaskId: 's1' })
    const direct = await web.markTask('t1', 'done')
    const viaSubtask = await web.markTask('t2', 'done')
    console.log(JSON.stringify({ refused: refused.message, direct: direct.ok, viaSubtask: viaSubtask.ok }))
  `)
  expect(out).toEqual({ refused: 'done_needs_session', direct: true, viaSubtask: true })
})

test('the group-join rule sees a historical link on the subtask (subtask_has_sessions)', async () => {
  const { out } = await run(`
    ${task('t1')}
    ${subtask('g1', 't1', 'isGroup: true,')}
    ${subtask('s1', 't1')}
    ${meta('c1')}
    await web.attachConversation('t1', 'c1', { subtaskId: 's1' })
    console.log(JSON.stringify(await web.patchSubtask('s1', { parentGroupId: 'g1' })))
  `)
  expect(out).toEqual({ ok: false, message: 'subtask_has_sessions' })
})

test('filing is a MOVE and says what it replaced; filing where it already is is not a move', async () => {
  const { out } = await run(`
    ${task('t1')}
    ${task('t2')}
    ${subtask('s1', 't1')}
    ${subtask('s2', 't1')}
    ${meta('c1')}
    const first = await web.attachConversation('t1', 'c1', { subtaskId: 's1' })
    const same = await web.attachConversation('t1', 'c1', { subtaskId: 's1' })
    const between = await web.attachConversation('t1', 'c1', { subtaskId: 's2' })
    const across = await web.attachConversation('t2', 'c1')
    const links = (await store.read()).historicalSessions
    const t1 = await web.showTask('t1')
    const t2 = await web.showTask('t2')
    console.log(JSON.stringify({
      first, same, between, across, links: links.length,
      t1: t1.task.sessions.length, t2: t2.task.sessions.length,
    }))
  `)
  expect(out.first.movedFrom).toBeUndefined()
  expect(out.same.movedFrom).toBeUndefined()
  expect(out.between.movedFrom).toEqual({ taskId: 't1', subtaskId: 's1' })
  expect(out.across.movedFrom).toEqual({ taskId: 't1', subtaskId: 's2' })
  expect(out.links).toBe(1)
  expect(out.t1).toBe(0)
  expect(out.t2).toBe(1)
})

test('a historical link overrides an OLDER registry filing of the conversation on another task, but the fleet refuses to double up', async () => {
  // The live path first: the conversation has a registry row, so this door refuses and names it…
  const { out } = await run(`
    ${task('tA')}
    ${task('tB')}
    ${meta('c1')}
    ${session('old', "conversationId: 'c1', taskId: 'tA', createdAt: '2026-09-01T00:00:00.000Z',")}
    const refused = await web.attachConversation('tB', 'c1')
    // …and the READ side stays right when both DO exist (a row minted after the link was written):
    // build the world by hand with the link the store would hold.
    await store.fileHistorical({
      id: 'hist:c1', conversationId: 'c1', harness: 'claude', taskId: 'tB',
      linkedAt: '2026-09-05T00:00:00.000Z',
    })
    const w = await source.loadTaskWorld()
    const owners = conv.conversationOwners(w.rollupRows)
    console.log(JSON.stringify({ refused, owner: owners.get('c1') }))
  `)
  expect(out.refused).toEqual({ ok: false, reason: 'conversation_in_fleet', sessionId: 'old' })
  expect(out.owner).toBe('tB')
})

test('a registry row (real attachSession) written AFTER a link takes the conversation over', async () => {
  const { out } = await run(`
    ${task('tA')}
    ${task('tB')}
    ${meta('c1')}
    await web.attachConversation('tB', 'c1')
    await new Promise(r => setTimeout(r, 15))
    // The person reopened the conversation and filed the new row on A.
    ${session('reopen', "conversationId: 'c1', createdAt: new Date().toISOString(),")}
    await web.attachSession('tA', 'reopen')
    const w = await source.loadTaskWorld()
    console.log(JSON.stringify({ owner: conv.conversationOwners(w.rollupRows).get('c1') }))
  `)
  expect(out.owner).toBe('tA')
})

test('detach by conversation id (or hist: id) drops the link, and the conversation belongs to no task', async () => {
  const { out } = await run(`
    ${task('t1')}
    ${meta('c1')}
    ${meta('c2')}
    await web.attachConversation('t1', 'c1')
    await web.attachConversation('t1', 'c2')
    const byConv = await web.detachSession('c1')
    const byLink = await web.detachSession('hist:c2')
    const again = await web.detachSession('c1')
    const w = await source.loadTaskWorld()
    const t = await web.showTask('t1')
    console.log(JSON.stringify({
      byConv, byLink, again, sessions: t.task.sessions.length,
      owner: conv.conversationOwners(w.rollupRows).get('c1') ?? null,
    }))
  `)
  expect(out).toEqual({ byConv: true, byLink: true, again: false, sessions: 0, owner: null })
})

test('side effects mirror attachSession: status nudge, repo inherited, session event logged', async () => {
  const { out } = await run(`
    ${task('t1')}
    ${meta('c1')}
    await web.attachConversation('t1', 'c1')
    const book = await store.read()
    console.log(JSON.stringify({
      status: book.tasks[0].status, repo: book.tasks[0].repo,
      events: book.events.filter(e => e.kind === 'session').map(e => [e.to, e.detail]),
    }))
  `)
  expect(out.status).toBe('in_progress')
  expect(out.repo).toBe('org/repo')
  expect(out.events).toEqual([['c1', 'claude · historical']])
})

test('attachSession reports movedFrom when it displaces a filing (and stays {ok:true} otherwise)', async () => {
  const { out } = await run(`
    ${task('t1')}
    ${task('t2')}
    ${subtask('s1', 't1')}
    ${session('sess', "conversationId: 'c1',")}
    const first = await web.attachSession('t1', 'sess', { subtaskId: 's1' })
    const same = await web.attachSession('t1', 'sess', { subtaskId: 's1' })
    const moved = await web.attachSession('t2', 'sess')
    console.log(JSON.stringify({ first, same, moved }))
  `)
  expect(out.first).toEqual({ ok: true })
  expect(out.same).toEqual({ ok: true })
  expect(out.moved).toEqual({ ok: true, movedFrom: { taskId: 't1', subtaskId: 's1' } })
})

test('attachSession never resolves a historical id — the registry is the only thing it patches', async () => {
  const { out } = await run(`
    ${task('t1')}
    ${meta('c1')}
    await web.attachConversation('t1', 'c1')
    console.log(JSON.stringify(await web.attachSession('t1', 'hist:c1')))
  `)
  expect(out).toEqual({ ok: false, reason: 'no_such_session' })
})

test('the REGISTRY view of the world never contains a synthetic row', async () => {
  const { out } = await run(`
    ${task('t1')}
    ${meta('c1')}
    ${session('live', "conversationId: 'cLive', taskId: 't1',")}
    await web.attachConversation('t1', 'c1')
    const w = await source.loadTaskWorld()
    console.log(JSON.stringify({
      registry: w.registryRows.map(r => r.id), rollup: w.rollupRows.map(r => r.id),
    }))
  `)
  expect(out).toEqual({ registry: ['live'], rollup: ['live', 'hist:c1'] })
})
