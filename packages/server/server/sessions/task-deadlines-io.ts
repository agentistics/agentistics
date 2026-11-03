/**
 * The IO half of the deadline reminders (`task-deadlines.ts` is the rule). One tick reads the task
 * book, raises a notification per due reminder through the app's own bell, and persists what it
 * raised so a restart never repeats it. A tick with nothing due writes nothing.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AGENTISTICS_DATA_DIR, TASKS_FILE } from '../config'
import { createTaskStore } from './task-store'
import { pruneSentKeys, planDeadlineReminders, type DeadlineReminder } from './task-deadlines'

export const TASK_REMINDERS_FILE = join(AGENTISTICS_DATA_DIR, 'task-reminders.json')

async function readSent(file: string): Promise<Set<string>> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as { sent?: unknown }
    return new Set(Array.isArray(raw.sent) ? raw.sent.filter((k): k is string => typeof k === 'string') : [])
  } catch { return new Set() }
}

async function writeSent(file: string, sent: readonly string[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify({ sent }), 'utf8')
  await rename(tmp, file)
}

export interface DeadlineDeps {
  tasksFile?: string
  remindersFile?: string
  now?: () => Date
  notify: (r: DeadlineReminder) => void
}

/** One pass. Returns the reminders raised. The keys are persisted BEFORE notifying: a crash between
 *  the two loses one reminder, where the other order repeats it on every restart. */
export async function runDeadlineTick(deps: DeadlineDeps): Promise<DeadlineReminder[]> {
  const file = deps.remindersFile ?? TASK_REMINDERS_FILE
  const book = await createTaskStore(deps.tasksFile ?? TASKS_FILE).read()
  const sent = await readSent(file)
  const due = planDeadlineReminders(book.tasks, book.subtasks, sent, (deps.now ?? (() => new Date()))())
  const kept = pruneSentKeys(sent, book.tasks, book.subtasks)
  if (due.length === 0) {
    if (kept.length !== sent.size) await writeSent(file, kept)
    return []
  }
  await writeSent(file, [...kept, ...due.map(d => d.key)])
  for (const r of due) deps.notify(r)
  return due
}
