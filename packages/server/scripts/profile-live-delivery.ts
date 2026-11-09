/**
 * Profile the server-side pieces of `/api/tasks/live` on the current machine.
 *
 * Run with `bun packages/server/scripts/profile-live-delivery.ts`. It only reads the task book,
 * consolidated metadata, fleet snapshot and role document; each number is a wall-clock sample for
 * one cold process and the second fleet read demonstrates the in-process snapshot cache.
 */
import { buildLive } from '../server/sessions/task-live'
import { buildTaskDetail } from '../server/sessions/task-report'
import { conversationOwners } from '../server/sessions/task-conversations'
import { loadTaskWorld } from '../server/sessions/task-source'
import { readLiveFleet } from '../server/sessions/fleet-web'
import { defaultRoleDeps, listRoles } from '../server/sessions/session-roles'

const clock = () => performance.now()
const rounded = (n: number) => Math.round(n * 10) / 10

const started = clock()
const world = await loadTaskWorld()
const afterWorld = clock()
const owners = conversationOwners(world.rollupRows)
const details = world.book.tasks.map(task => buildTaskDetail({
  owners,
  task,
  attempts: world.book.attempts,
  rows: world.rollupRows,
  metas: world.metas,
  costOf: world.costOf,
  comments: [],
  threads: [],
  subtasks: world.book.subtasks.filter(subtask => subtask.taskId === task.id),
  files: [],
}))
const afterDetails = clock()
const labels = new Map(world.book.statuses.map(status => [status.id, status.label]))
buildLive({ details, events: world.book.events, nowMs: Date.now(), statusLabel: id => labels.get(id) })
const afterBuild = clock()
const coldFleet = await readLiveFleet('en')
const afterColdFleet = clock()
const warmFleet = await readLiveFleet('en')
const afterWarmFleet = clock()
await listRoles(await defaultRoleDeps())
const finished = clock()

console.log(JSON.stringify({
  tasks: world.book.tasks.length,
  fleetRows: coldFleet.length,
  warmFleetRows: warmFleet.length,
  worldMs: rounded(afterWorld - started),
  detailsMs: rounded(afterDetails - afterWorld),
  buildLiveMs: rounded(afterBuild - afterDetails),
  coldFleetMs: rounded(afterColdFleet - afterBuild),
  warmFleetMs: rounded(afterWarmFleet - afterColdFleet),
  rolesMs: rounded(finished - afterWarmFleet),
  totalMs: rounded(finished - started),
}, null, 2))
