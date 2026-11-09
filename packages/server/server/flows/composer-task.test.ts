import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskStore } from '../sessions/task-store'
import { buildTaskDetail } from '../sessions/task-report'
import { buildLive } from '../sessions/task-live'
import { registerComposerTask, type ComposerTaskDeps } from './composer-task'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))) })
async function world() {
  const dir = await mkdtemp(join(tmpdir(), 'composer-task-')); dirs.push(dir)
  const file = join(dir, 'tasks.json')
  const store = createTaskStore(file)
  const task = { id: 't1', title: 'Delivery', status: 'in_progress', createdAt: '2026-11-09T10:00:00Z', updatedAt: '2026-11-09T10:00:00Z' }
  await store.upsertTask(task)
  const pedidos = new Map<string, { state: string; linkedSubtaskIds: string[] }>()
  const d: ComposerTaskDeps = {
    now: () => Date.parse('2026-11-09T12:00:00Z'), target: async () => ({ taskId: task.id, conversationId: 'conv' }), store: async () => store,
    run: async (name, input) => {
      if (name === 'pedido-do-dono') {
        const key = String(input.at)
        if (!pedidos.has(key)) pedidos.set(key, { state: 'open', linkedSubtaskIds: [] })
        return { status: 'success', output: { pedido: pedidos.get(key) } }
      }
      for (const p of pedidos.values()) { p.state = 'linked'; p.linkedSubtaskIds = input.subtaskIds as string[] }
      return { status: 'success' }
    },
  }
  return { d, store, pedidos, task, file }
}
const request = { id: 'lead', action: 'prompt', text: '  Fix the calendar\nFull details for the task.', messageId: 'msg-1', asTask: { priority: 'high' as const, dueDate: '2026-11-12' } }

test('flagged send creates one complete subtask and linked pedido, even after restart/retry', async () => {
  const x = await world()
  expect((await registerComposerTask(request, 'en', x.d)).ok).toBe(true)
  x.d.now = () => Date.parse('2026-11-10T15:00:00Z')
  await registerComposerTask(request, 'en', { ...x.d, store: async () => createTaskStore(x.file) })
  const book = await x.store.read()
  expect(book.subtasks).toHaveLength(1); expect(x.pedidos.size).toBe(1)
  expect(book.events.filter(e => e.actor === 'owner:composer')).toHaveLength(1)
  expect(book.subtasks[0]).toMatchObject({ taskId: 't1', title: 'Fix the calendar', notes: request.text.trim(), priority: 'high', dueDate: '2026-11-12', assignee: 'leader', status: 'todo', ownerRequest: { messageId: 'msg-1', at: '2026-11-09T12:00:00.000Z' } })
  expect(book.subtasks[0]!.startedAt).toBeUndefined() // Filing, rather than request creation, starts work.
  expect([...x.pedidos.values()][0]).toMatchObject({ state: 'linked', linkedSubtaskIds: [book.subtasks[0]!.id] })
  const detail = buildTaskDetail({ task: x.task, attempts: [], rows: [], metas: new Map(), costOf: () => 0, subtasks: book.subtasks })
  expect(detail.subtasks[0]).toEqual(book.subtasks[0]!) // Same detail returned by agentistics_task.
  const live = buildLive({ nowMs: x.d.now(), events: [], details: [detail] })
  expect(live.deliveries.find(p => p.subtaskId === book.subtasks[0]!.id)).toMatchObject({ stage: 'queue', priority: 'high' })
})

test('concurrent registrations are insert-if-absent under the real board lock', async () => {
  const x = await world()
  await Promise.all(Array.from({ length: 4 }, () => registerComposerTask(request, 'en', x.d)))
  expect((await x.store.read()).subtasks).toHaveLength(1)
})

test('a crash after the board write retries the original timestamp without a second card', async () => {
  const x = await world()
  expect((await registerComposerTask(request, 'en', { ...x.d, run: async () => { throw new Error('interrupted') } })).ok).toBe(false)
  expect((await registerComposerTask(request, 'en', x.d)).ok).toBe(true)
  expect((await x.store.read()).subtasks).toHaveLength(1)
})

test('no task, invalid date/priority, missing gesture/id and agent messages refuse without writes', async () => {
  const x = await world()
  expect((await registerComposerTask(request, 'pt', { ...x.d, target: async () => undefined })).ok).toBe(false)
  for (const extra of [{ asTask: undefined }, { messageId: undefined }, { asTask: { priority: 'none' } }, { asTask: { priority: 'high', dueDate: '2026-02-31' } }, { session: {} }, { callerVerified: true }]) {
    expect((await registerComposerTask({ ...request, ...extra }, 'en', x.d)).ok).toBe(false)
  }
  expect((await registerComposerTask(request, 'en', { ...x.d, ready: async () => false })).ok).toBe(false)
  expect((await x.store.read()).subtasks).toEqual([]); expect(x.pedidos.size).toBe(0)
})

test('same message id after a handoff is still one card; conflicting text is refused', async () => {
  const x = await world()
  await registerComposerTask(request, 'en', x.d)
  expect((await registerComposerTask({ ...request, id: 'successor' }, 'en', x.d)).ok).toBe(true)
  expect((await registerComposerTask({ ...request, text: 'Different work' }, 'en', x.d)).ok).toBe(false)
  expect((await x.store.read()).subtasks).toHaveLength(1)
})

test('actual shared send registers once and still delivers the message plus system note', async () => {
  const x = await world()
  const module = await import('./composer-task')
  const fleet = await import('../sessions/fleet-web')
  const hook = spyOn(module, 'defaultComposerTaskDeps').mockReturnValue(x.d)
  const sent: string[] = []
  fleet.__setFleetHostForTest('en', { sessions: async () => ({ sessions: [] }), promptSession: async (_id: string, text: string) => { sent.push(text); return { ok: true, message: 'sent' } } } as never)
  try {
    expect((await fleet.runFleetAction('en', { ...request, action: 'prompt' })).ok).toBe(true)
    expect((await fleet.runFleetAction('en', { ...request, action: 'prompt' })).ok).toBe(true)
    expect((await x.store.read()).subtasks).toHaveLength(1)
    expect(sent).toHaveLength(2)
    expect(sent[0]).toContain(request.text.trim())
    expect(sent[0]).toContain('[agentistics · Registered as task: Fix the calendar]')
  } finally { hook.mockRestore(); fleet.__setFleetHostForTest('en', null) }
})
