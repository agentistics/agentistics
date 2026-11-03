import { expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskStore } from './task-store'
import { planDeadlineReminders, pruneSentKeys, thresholdFor } from './task-deadlines'
import { runDeadlineTick } from './task-deadlines-io'

const NOW = new Date(2026, 10, 3, 10, 0, 0) // 2026-11-03 local
const task = (id: string, dueDate?: string, status = 'todo') => ({ id, title: `T-${id}`, status, dueDate })
const sub = (id: string, taskId: string, dueDate?: string, over: object = {}) => ({ id, taskId, title: `S-${id}`, status: 'todo', done: false, dueDate, ...over })

test('thresholds are day arithmetic: tomorrow, today, past due, else nothing', () => {
  expect(thresholdFor('2026-11-04', '2026-11-03')).toBe('soon')
  expect(thresholdFor('2026-11-03', '2026-11-03')).toBe('today')
  expect(thresholdFor('2026-11-01', '2026-11-03')).toBe('overdue')
  expect(thresholdFor('2026-11-05', '2026-11-03')).toBeNull()
  expect(thresholdFor('garbage', '2026-11-03')).toBeNull()
})

test('a closed task or subtask never reminds; an open one with a due day does', () => {
  const r = planDeadlineReminders(
    [task('a', '2026-11-03'), task('b', '2026-11-03', 'done'), task('c', '2026-11-03', 'abandoned'), task('d')],
    [sub('s1', 'a', '2026-11-04'), sub('s2', 'a', '2026-11-04', { done: true }), sub('s3', 'b', '2026-11-04')],
    new Set(), NOW)
  expect(r.map(x => x.key)).toEqual(['task:a:2026-11-03:today', 'subtask:s1:2026-11-04:soon'])
  expect(r[1]!.taskTitle).toBe('T-a')
})

test('already-sent keys are skipped, and rescheduling re-arms the item', () => {
  const sent = new Set(['task:a:2026-11-03:today'])
  expect(planDeadlineReminders([task('a', '2026-11-03')], [], sent, NOW)).toEqual([])
  expect(planDeadlineReminders([task('a', '2026-11-04')], [], sent, NOW).map(x => x.threshold)).toEqual(['soon'])
})

test('pruneSentKeys drops deleted and rescheduled items', () => {
  const sent = new Set(['task:a:2026-11-03:today', 'task:gone:2026-11-03:today', 'task:a:2026-10-01:overdue'])
  expect(pruneSentKeys(sent, [task('a', '2026-11-03')], [])).toEqual(['task:a:2026-11-03:today'])
})

test('a tick notifies once per threshold and survives a restart (persisted keys)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentop-deadlines-'))
  const tasksFile = join(dir, 'tasks.json'), remindersFile = join(dir, 'task-reminders.json')
  const store = createTaskStore(tasksFile)
  const at = '2026-11-01T10:00:00.000Z'
  await store.upsertTask({ id: 'a', title: 'Ship it', status: 'todo', dueDate: '2026-11-03', createdAt: at, updatedAt: at } as never)
  const raised: string[] = []
  const deps = { tasksFile, remindersFile, now: () => NOW, notify: (r: { key: string }) => raised.push(r.key) }
  expect((await runDeadlineTick(deps)).length).toBe(1)
  expect((await runDeadlineTick(deps)).length).toBe(0) // same process, second tick
  expect((await runDeadlineTick({ ...deps }) ).length).toBe(0) // a "restart" reads the file again
  expect(raised).toEqual(['task:a:2026-11-03:today'])
  expect(JSON.parse(await readFile(remindersFile, 'utf8')).sent).toEqual(['task:a:2026-11-03:today'])
  // Tomorrow it is overdue: exactly one more.
  const next = { ...deps, now: () => new Date(2026, 10, 5, 9) }
  expect((await runDeadlineTick(next)).map(r => r.threshold)).toEqual(['overdue'])
  expect((await runDeadlineTick({ ...next, now: () => new Date(2026, 10, 6, 9) })).length).toBe(0)
})
