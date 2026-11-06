/**
 * Profile the server-side pieces of `GET /api/tasks` on the current machine (read-only).
 * `bun packages/server/scripts/profile-tasks-list.ts`
 */
import { buildTaskList } from '../server/sessions/task-report'
import { buildBoardOverview } from '../server/sessions/task-overview'
import { loadTaskWorld } from '../server/sessions/task-source'
import { listTasks } from '../server/sessions/task-web'

const clock = () => performance.now()
const r = (n: number) => Math.round(n * 10) / 10
const t0 = clock()
const w = await loadTaskWorld()
const t1 = clock()
const list = buildTaskList({
  tasks: w.book.tasks, attempts: w.book.attempts, rows: w.rollupRows, metas: w.metas, costOf: w.costOf,
  comments: w.book.comments, threads: w.book.threads, subtasks: w.book.subtasks, files: w.book.files,
})
const t2 = clock()
const overview = buildBoardOverview({
  tasks: w.book.tasks, rows: w.rollupRows, metas: w.metas, costOf: w.costOf,
  statusIds: w.book.statuses.map(s => s.id),
})
const t3 = clock()
const body = JSON.stringify({ tasks: list, overview, excludedByFilter: 0 })
const t4 = clock()
await listTasks()
const t5 = clock()
console.log(JSON.stringify({
  tasks: w.book.tasks.length, subtasks: w.book.subtasks.length, comments: w.book.comments.length,
  events: w.book.events.length, metas: w.metas.size, rollupRows: w.rollupRows.length,
  worldMs: r(t1 - t0), buildTaskListMs: r(t2 - t1), overviewMs: r(t3 - t2), stringifyMs: r(t4 - t3),
  warmListTasksMs: r(t5 - t4), bytes: body.length,
}, null, 2))
