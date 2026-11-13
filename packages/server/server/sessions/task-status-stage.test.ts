import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildLive, trailOf } from './task-live'
import type { TaskDetail } from './task-report'
import type { TaskEvent } from './task-model'
import { oldBoardRoundTrip } from './task-store-v2210.fixture'

/**
 * S0c — the stored status stage, end to end (spec §2.2, §3.5.8). Web-door scenarios run in their own process
 * pointed at their own AGENTISTICS_DIR (module-level file paths, as in task-status-crud.test.ts).
 */
const SESSIONS_DIR = import.meta.dir

async function run(dir: string, body: string): Promise<any> {
  const script = `
    const web = await import(${JSON.stringify(join(SESSIONS_DIR, 'task-web.ts'))})
    const cfg = await import(${JSON.stringify(join(SESSIONS_DIR, '..', 'config.ts'))})
    const { createTaskStore } = await import(${JSON.stringify(join(SESSIONS_DIR, 'task-store.ts'))})
    const store = createTaskStore(cfg.TASKS_FILE)
    ${body}
  `
  const proc = Bun.spawn([process.execPath, '-e', script], { env: { ...process.env, AGENTISTICS_DIR: dir }, stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text(); const err = await new Response(proc.stderr).text()
  if ((await proc.exited) !== 0) throw new Error(`script failed: ${err.trim().split('\n').slice(-8).join(' | ')}`)
  return JSON.parse(out.trim().split('\n').filter(Boolean).at(-1) ?? '{}')
}
const fresh = () => mkdtemp(join(tmpdir(), 'agentop-status-stage-'))
const stages = (rows: Array<{ id: string; stage?: string }>) => Object.fromEntries(rows.map(r => [r.id, r.stage])) as Record<string, string>
const mirrorOf = async (dir: string) => JSON.parse(await readFile(join(dir, 'guarantees.json'), 'utf8')).statusStages as Record<string, string>

describe('backfill + mirror', () => {
  test('a fresh board carries a stage on every status and mirrors them to guarantees.json', async () => {
    const dir = await fresh()
    const rows = await run(dir, `console.log(JSON.stringify(await web.listStatuses()))`)
    expect(stages(rows)).toEqual({ todo: 'queue', in_progress: 'running', blocked: 'blocked', in_review: 'leader', done: 'published' })
    expect(await mirrorOf(dir)).toEqual(stages(rows))
  })

  test('a book from before this feature (no stages) is backfilled ONCE by stageOfStatus; the second load changes nothing', async () => {
    const dir = await fresh()
    await run(dir, `await web.listStatuses()`)
    const file = join(dir, 'tasks.json')
    const book = JSON.parse(await readFile(file, 'utf8'))
    book.statuses = book.statuses.map(({ stage: _s, ...rest }: any) => rest)
    book.statuses.push({ id: 'review_ready', label: 'Review ready', color: '#22c55e', protected: false, order: 9 })
    await writeFile(file, JSON.stringify(book))
    await Bun.write(join(dir, 'guarantees.json'), '') // an empty file is unparseable → must not stop the backfill of the board
    const first = await run(dir, `console.log(JSON.stringify(await web.listStatuses()))`)
    expect(stages(first).review_ready).toBe('leader')
    const before = await readFile(file, 'utf8')
    const second = await run(dir, `console.log(JSON.stringify(await web.listStatuses()))`)
    expect(stages(second)).toEqual(stages(first))
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  test('reading a fully-staged board does not touch guarantees.json (no file is created by a plain read of an old-style board with no stage work)', async () => {
    const dir = await fresh()
    await run(dir, `await web.listStatuses()`)
    const g = await readFile(join(dir, 'guarantees.json'), 'utf8')
    await run(dir, `await web.listStatuses()`)
    expect(await readFile(join(dir, 'guarantees.json'), 'utf8')).toBe(g)
  })
})

describe('§3.5.8 relabel and stage edits', () => {
  test('createStatus stores the stage derived once; "Review ready" is a guarded leader status, "Shipped" is published', async () => {
    const dir = await fresh()
    const out = await run(dir, `
      const a = await web.createStatus({ label: 'Review ready', color: '#22c55e' })
      const b = await web.createStatus({ label: 'Shipped', color: '#22c55e' })
      const c = await web.createStatus({ label: 'Waiting on client', color: '#22c55e' })
      console.log(JSON.stringify({ a: a.status.stage, b: b.status.stage, c: c.status.stage }))`)
    expect([out.a, out.b, out.c]).toEqual(['leader', 'published', 'none'])
    const m = await mirrorOf(dir)
    expect(m.review_ready).toBe('leader'); expect(m.shipped).toBe('published'); expect(m.waiting_on_client).toBe('none')
  })

  test('RELABEL ATTACK: renaming a status (built-in and custom) to "In review" does not change its stored stage, in the book or the mirror', async () => {
    const dir = await fresh()
    const out = await run(dir, `
      const made = await web.createStatus({ label: 'Doing', color: '#22c55e' })
      const r1 = await web.editStatus('in_progress', { label: 'In review' })
      const r2 = await web.editStatus(made.status.id, { label: 'Review ready' })
      console.log(JSON.stringify({ id: made.status.id, r1, r2, rows: await web.listStatuses() }))`)
    expect(out.r1.ok && out.r2.ok).toBe(true)
    expect(stages(out.rows).in_progress).toBe('running')
    expect(stages(out.rows)[out.id]).toBe('running')
    const m = await mirrorOf(dir)
    expect(m.in_progress).toBe('running'); expect(m[out.id]).toBe('running')
  })

  test('changing the stage of a status IN USE → status_stage_in_use naming the count; nothing is written', async () => {
    const dir = await fresh()
    const out = await run(dir, `
      await web.listStatuses()
      await store.upsertTask({ id: 't1', title: 't', status: 'in_progress', createdAt: '2026-11-13T00:00:00.000Z', updatedAt: '2026-11-13T00:00:00.000Z' })
      await store.upsertTask({ id: 't2', title: 't', status: 'in_progress', createdAt: '2026-11-13T00:00:00.000Z', updatedAt: '2026-11-13T00:00:00.000Z' })
      const r = await web.editStatus('in_progress', { stage: 'leader' })
      console.log(JSON.stringify({ r, rows: await web.listStatuses() }))`)
    expect(out.r).toEqual({ ok: false, message: 'status_stage_in_use', usageCount: 2 })
    expect(stages(out.rows).in_progress).toBe('running')
    expect((await mirrorOf(dir)).in_progress).toBe('running')
  })

  test('an UNUSED status may change stage (book and mirror follow); an unknown stage is refused', async () => {
    const dir = await fresh()
    const out = await run(dir, `
      const made = await web.createStatus({ label: 'Waiting on client', color: '#22c55e' })
      const bad = await web.editStatus(made.status.id, { stage: 'nope' })
      const ok = await web.editStatus(made.status.id, { stage: 'qa' })
      console.log(JSON.stringify({ id: made.status.id, ok, bad }))`)
    expect(out.ok.ok).toBe(true); expect(out.bad).toEqual({ ok: false, message: 'bad_stage' })
    expect((await mirrorOf(dir))[out.id]).toBe('qa')   // read BEFORE any further load, so only the edit itself can have written it
    expect(stages(await run(dir, `console.log(JSON.stringify(await web.listStatuses()))`))[out.id]).toBe('qa')
  })

  test('the REST edit route passes `stage` through and maps status_stage_in_use to 422', async () => {
    const src = await readFile(join(SESSIONS_DIR, '..', 'index.ts'), 'utf8')
    const block = src.slice(src.indexOf("const { editStatus } = await import('./sessions/task-web')"))
    const route = block.slice(0, block.indexOf("req.method === 'DELETE'"))
    expect(route).toMatch(/stage/)
    expect(route).toMatch(/status_stage_in_use/)
    expect(route).toMatch(/422/)
  })
})

describe('§3.5.8 old-writer round trip: the mirror restores the stage, never the label', () => {
  test('relabel + v2.210.1 writer drops `stage` → the new binary restores it from the mirror (not from the new label); an old-binary-created status is classified once and mirrored', async () => {
    const dir = await fresh()
    await run(dir, `await web.createStatus({ label: 'Doing', color: '#22c55e' }); await web.editStatus('doing', { label: 'Review ready' }); await web.editStatus('in_progress', { label: 'In review' })`)
    const file = join(dir, 'tasks.json')
    const dropped = oldBoardRoundTrip(await readFile(file, 'utf8'), b => { b.statuses.push({ id: 'shipped', label: 'Shipped', color: '#22c55e', protected: false, order: 99 }) })
    for (const s of JSON.parse(dropped).statuses) expect('stage' in s).toBe(false)
    await writeFile(file, dropped)
    const rows = await run(dir, `console.log(JSON.stringify(await web.listStatuses()))`)
    expect(stages(rows)).toEqual({ todo: 'queue', in_progress: 'running', blocked: 'blocked', in_review: 'leader', done: 'published', doing: 'running', shipped: 'published' })
    expect((await mirrorOf(dir)).shipped).toBe('published')
    expect((await mirrorOf(dir)).in_progress).toBe('running')
    expect(existsSync(join(dir, 'guards.json'))).toBe(false)
  })
})

describe('the store never overwrites a stored stage on backfill', () => {
  test('setStatusStages fills only statuses with NO valid stage and ignores invalid values', async () => {
    const { createTaskStore } = await import('./task-store')
    const dir = await fresh(); const store = createTaskStore(join(dir, 'tasks.json'))
    await store.upsertStatus({ id: 'a', label: 'A', color: '#22c55e', protected: false, order: 0, stage: 'running' })
    await store.upsertStatus({ id: 'b', label: 'B', color: '#22c55e', protected: false, order: 1 })
    await store.setStatusStages({ a: 'qa', b: 'ci' })
    expect(Object.fromEntries((await store.read()).statuses.map(s => [s.id, s.stage]))).toEqual({ a: 'running', b: 'ci' })
    await store.upsertStatus({ id: 'c', label: 'C', color: '#22c55e', protected: false, order: 2 })
    await store.setStatusStages({ c: 'bogus' })
    expect((await store.read()).statuses.find(s => s.id === 'c')!.stage).toBeUndefined()
  })
  test('a stage written to tasks.json survives a read/sanitise round trip; an invalid one reads as absent', async () => {
    const { createTaskStore } = await import('./task-store')
    const dir = await fresh(); const file = join(dir, 'tasks.json')
    await writeFile(file, JSON.stringify({ tasks: [], subtasks: [], statuses: [
      { id: 'a', label: 'A', color: '#22c55e', protected: false, order: 0, stage: 'leader' },
      { id: 'b', label: 'B', color: '#22c55e', protected: false, order: 1, stage: 'nope' },
    ] }))
    const got = (await createTaskStore(file).read()).statuses
    expect(got.map(s => s.stage)).toEqual(['leader', undefined])
  })
})

describe('the doors are wired to the stored stage (structural)', () => {
  const read = (p: string) => readFile(join(SESSIONS_DIR, p), 'utf8')
  test('task-web hands the stored stage to BOTH the forecast history and the live build', async () => {
    const src = await read('task-web.ts')
    expect((src.match(/statusStage: id => stageById\.get\(id\)/g) ?? []).length).toBe(2)
  })
  test('the delivery host finds a phase\'s status by stored stage, not by re-classifying labels', async () => {
    const src = await read('../delivery/host.ts')
    expect(src).toMatch(/storedStageOf\(s\) === LIVE_STAGE\[phase\]\)\?\.id/)
    expect(src).not.toMatch(/stageOfStatus\(/)
  })
  test('the REST route maps status_stage_in_use to 422', async () => {
    const src = await read('../index.ts')
    expect(src).toMatch(/out\.message === 'status_stage_in_use' \? 422/)
  })
  test('the load path runs the stage pass', async () => {
    expect(await read('task-source.ts')).toMatch(/ensureStatusStages\(store, b, TASKS_FILE\)/)
  })
})

describe('consumers read the stored stage', () => {
  const NOW = Date.parse('2026-11-13T12:00:00Z'); const H = 3600_000
  const iso = (ms: number) => new Date(ms).toISOString()
  const ev = (id: string, at: number, to: string): TaskEvent => ({ id, taskId: 't1', actor: 'x', kind: 'status', at: iso(at), to } as TaskEvent)

  test('trailOf: a status relabelled to "In review" keeps its running stage when the stored stage is given', () => {
    const events = [ev('1', NOW - 5 * H, 'wip'), ev('2', NOW - 2 * H, 'in_review')]
    const derived = trailOf(events, NOW, id => (id === 'wip' ? 'In review' : undefined))
    expect(derived.map(v => v.stage)).toEqual(['leader'])            // the label re-derivation the stored stage replaces
    const stored = trailOf(events, NOW, id => (id === 'wip' ? 'In review' : undefined), id => ({ wip: 'running', in_review: 'leader' } as const)[id as 'wip'])
    expect(stored.map(v => v.stage)).toEqual(['running', 'leader'])
  })

  test('trailOf: a stored `none` is a status that names no stage (same as before)', () => {
    expect(trailOf([ev('1', NOW - H, 'weird')], NOW, undefined, () => 'none')).toEqual([])
  })

  test('buildLive: the card stage of a piece follows the stored stage, not the relabelled text', () => {
    const detail = {
      task: { id: 't1', title: 'T', status: 'in_progress', createdAt: iso(NOW - 9 * H), updatedAt: iso(NOW - H), startedAt: iso(NOW - 9 * H) },
      attempts: [], rollup: {}, stats: {}, comments: [], commentThreads: [], threads: [], files: [],
      subtasks: [{ id: 'a', taskId: 't1', title: 'A', done: false, status: 'wip', createdAt: iso(NOW - 8 * H), updatedAt: iso(NOW - H) }],
      sessions: [{ id: 's1', harness: 'claude', cwd: '/x', attemptId: null, subtaskId: 'a', createdAt: iso(NOW - 3 * H), model: 'opus', tokens: null, costUSD: null, rounds: null }],
      subtaskRollups: [], times: { startedAt: iso(NOW - 8 * H), completedAt: null, durationMs: null, activeMinutes: null, source: 'status' },
    } as unknown as TaskDetail
    const base = { nowMs: NOW, events: [] as TaskEvent[], details: [detail], statusLabel: (id: string) => (id === 'wip' ? 'In review' : undefined) }
    expect(buildLive(base).deliveries[0]!.stage).toBe('leader')
    expect(buildLive({ ...base, statusStage: id => (id === 'wip' ? 'running' : undefined) }).deliveries[0]!.stage).toBe('running')
  })
})
