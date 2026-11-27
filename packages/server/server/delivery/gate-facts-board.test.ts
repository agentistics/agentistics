/**
 * PERF.SERVIDOR-OCIOSO fase 3 (QA C1) — the delivery tick's board facts (`subtask`, `pieceStatus`, `queueExtras`,
 * `blockedSubtasks`) share ONE board load while the book and the registry are unchanged, and read again the moment
 * either changes. Out of process: the board file is a module-level constant (`TASKS_FILE`).
 */
import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = import.meta.dir

test('N pieces on one tick -> one board load; a book write -> read again, never stale', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-board-'))
  try {
    const script = `
      const web = await import(${JSON.stringify(join(DIR, '..', 'sessions', 'task-web.ts'))})
      const src = await import(${JSON.stringify(join(DIR, '..', 'sessions', 'task-source.ts'))})
      const { defaultGateFacts } = await import(${JSON.stringify(join(DIR, 'gates.ts'))})
      const t = await web.createTask({ title: 'T' })
      const ids = []
      for (let i = 0; i < 6; i++) ids.push((await web.addSubtaskDetailed(t.id, 'S' + i)).id)
      const f = defaultGateFacts()
      const l0 = src.taskBoardLoads()
      // one tick: every piece asked three ways, plus the blocked list
      for (const id of ids) { await f.subtask(id); await f.pieceStatus(id); await f.queueExtras(id) }
      await f.blockedSubtasks()
      const tickLoads = src.taskBoardLoads() - l0
      // a write lands (status change): the next fact sees it
      await web.markTask(t.id, 'in_progress', 'test', {})
      const l1 = src.taskBoardLoads()
      const status = await f.pieceStatus(t.id)
      const afterWriteLoads = src.taskBoardLoads() - l1
      // another PROCESS writes the book (no in-process write event): the file stamp moves, the next fact sees it
      const { readFileSync, writeFileSync } = await import('node:fs')
      const cfg = await import(${JSON.stringify(join(DIR, '..', 'config.ts'))})
      const raw = JSON.parse(readFileSync(cfg.TASKS_FILE, 'utf-8'))
      raw.tasks.find(x => x.id === t.id).status = 'todo'
      await Bun.sleep(5)
      writeFileSync(cfg.TASKS_FILE, JSON.stringify(raw))
      const foreign = await f.pieceStatus(t.id)
      console.log(JSON.stringify({ tickLoads, status, afterWriteLoads, foreign }))
      process.exit(0)
    `
    const proc = Bun.spawn([process.execPath, '-e', script], { env: { ...process.env, AGENTISTICS_DIR: dir, AGENTISTICS_TELEMETRY: '0', AGENTISTICS_JOURNAL: '0' }, stdout: 'pipe', stderr: 'pipe', cwd: DIR })
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    expect(await proc.exited, err.slice(-2000)).toBe(0)
    const r = JSON.parse(out.trim().split('\n').pop()!)
    expect(r.tickLoads).toBe(1)
    expect(r.status).toBe('in_progress')
    expect(r.afterWriteLoads).toBe(1)
    expect(r.foreign).toBe('todo')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 60_000)
