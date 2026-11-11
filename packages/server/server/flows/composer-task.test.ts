import { afterEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
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
  const emitted: string[] = []
  const d: ComposerTaskDeps = {
    now: () => Date.parse('2026-11-09T12:00:00Z'), target: async () => ({ taskId: task.id, conversationId: 'conv' }), store: async () => store,
    emit: async event => {
      emitted.push(event.type)
      const key = String(event.payload.at)
      if (!pedidos.has(key)) pedidos.set(key, { state: 'open', linkedSubtaskIds: [] })
      return { status: 'success', output: { pedido: pedidos.get(key) } }
    },
    run: async (_name, input) => {
      for (const p of pedidos.values()) { p.state = 'linked'; p.linkedSubtaskIds = input.subtaskIds as string[] }
      return { status: 'success' }
    },
  }
  return { d, store, pedidos, emitted, task, file }
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
  expect(x.emitted).toEqual(['owner.message'])
  expect(book.subtasks[0]!.ownerRequest?.pedidoId).toBe(`p-${createHash('sha256').update(`conv\0${book.subtasks[0]!.ownerRequest!.at}\0${request.text.trim()}`).digest('hex').slice(0, 12)}`)
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

test('a registration failure leaves no orphan card and retry creates one', async () => {
  const x = await world()
  expect((await registerComposerTask(request, 'en', { ...x.d, emit: async () => { throw new Error('interrupted') } })).ok).toBe(false)
  expect((await registerComposerTask(request, 'en', x.d)).ok).toBe(true)
  expect((await x.store.read()).subtasks).toHaveLength(1)
})

test('link failure rolls back the subtask', async () => {
  const x = await world()
  const failed = { ...x.d, run: async () => { throw new Error('link unavailable') } }
  expect((await registerComposerTask(request, 'en', failed)).ok).toBe(false)
  expect((await x.store.read()).subtasks).toHaveLength(0)
})

test('automatic placement already linked the pedido: preserve and enrich its card instead of relinking a closed pedido', async () => {
  const x = await world()
  let pedidoId = ''
  const d: ComposerTaskDeps = {
    ...x.d,
    emit: async event => {
      const p = event.payload
      pedidoId = `p-${createHash('sha256').update(`${p.conversationId}\0${p.at}\0${p.text}`).digest('hex').slice(0, 12)}`
      await x.store.upsertSubtask({ id: 's-placed', taskId: 't1', title: `Owner request · ${pedidoId}`, status: 'todo', done: false, createdAt: String(p.at), updatedAt: String(p.at) })
      return []
    },
    pedido: async () => ({ id: pedidoId, taskId: 't1', state: 'linked', linkedSubtaskIds: ['s-placed'] }),
    run: async () => ({ status: 'refused', refusal: { message: 'pedido is already linked' } }),
  }
  const register = x.store.registerComposerSubtask.bind(x.store)
  const adoption = spyOn(x.store, 'registerComposerSubtask').mockImplementation(async card => {
    // A worker can file the engine's card after the caller read it but before the store's lock.
    const placed = (await x.store.read()).subtasks.find(s => s.id === 's-placed')!
    await x.store.upsertSubtask({ ...placed, status: 'in_progress', assignee: 'worker' })
    return register(card)
  })
  const result = await registerComposerTask(request, 'en', d)
  adoption.mockRestore()
  expect(result.ok).toBe(true)
  expect((await x.store.read()).subtasks).toMatchObject([{ id: 's-placed', status: 'in_progress', assignee: 'worker', title: 'Fix the calendar', priority: 'high', dueDate: '2026-11-12', ownerRequest: { messageId: 'msg-1' } }])
  expect((await registerComposerTask(request, 'en', d)).ok).toBe(true)
  expect((await x.store.read()).subtasks).toHaveLength(1)
})

test('a canonical link to an unrelated card is refused without changing or deleting it', async () => {
  const x = await world()
  const alien = { id: 's-alien', taskId: 't1', title: 'Unrelated work', status: 'in_progress', done: false, createdAt: '2026-11-09T10:00:00Z', updatedAt: '2026-11-09T10:00:00Z' }
  await x.store.upsertSubtask(alien)
  const result = await registerComposerTask(request, 'en', { ...x.d, pedido: async () => ({ id: 'p-other', taskId: 't1', state: 'linked', linkedSubtaskIds: [alien.id] }) })
  expect(result.ok).toBe(false)
  expect((await x.store.read()).subtasks).toEqual([alien])
})

test('a committed link whose response was lost keeps its card and completes successfully', async () => {
  const x = await world()
  let ids: string[] = []
  const d: ComposerTaskDeps = { ...x.d, sleep: async () => {},
    pedido: async id => ({ id, taskId: 't1', state: ids.length ? 'linked' : 'open', linkedSubtaskIds: ids }),
    run: async (_name, input) => { ids = input.subtaskIds as string[]; throw new Error('response lost after commit') },
  }
  expect((await registerComposerTask(request, 'en', d)).ok).toBe(true)
  expect((await x.store.read()).subtasks.map(s => s.id)).toEqual(ids)
})

test('event rollback never removes an unrelated concurrent subtask', async () => {
  const x = await world()
  const alien = { id: 's-alien', taskId: 't1', title: 'Parallel work', status: 'todo' as const, done: false,
    createdAt: '2026-11-09T12:00:00.000Z', updatedAt: '2026-11-09T12:00:00.000Z' }
  const d = { ...x.d, emit: async () => {
    await x.store.upsertSubtask(alien)
    throw new Error('event failed')
  } }
  expect((await registerComposerTask(request, 'en', d)).ok).toBe(false)
  expect((await x.store.read()).subtasks.map(s => s.id)).toEqual(['s-alien'])
})

test('link retries while the event delivery is still being persisted', async () => {
  const x = await world(); let attempts = 0
  const d = { ...x.d, sleep: async () => {}, run: async (_name: string, input: Record<string, unknown>) => {
    attempts++
    if (attempts < 3) return { status: 'pending' }
    for (const p of x.pedidos.values()) { p.state = 'linked'; p.linkedSubtaskIds = input.subtaskIds as string[] }
    return { status: 'success' }
  } }
  expect((await registerComposerTask(request, 'en', d)).ok).toBe(true)
  expect(attempts).toBe(3)
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

/** An engine like the real one: emit returns at once, one serial queue builds the pedido card (no ownerRequest) later. */
async function asyncEngineWorld(stepMs: number, linkWorks = true) {
  const x = await world()
  let chain: Promise<unknown> = Promise.resolve()
  const done = new Set<string>()
  const pedidoOf = (p: Record<string, unknown>) => `p-${createHash('sha256').update(`${p.conversationId}\0${p.at}\0${p.text}`).digest('hex').slice(0, 12)}`
  const d: ComposerTaskDeps = {
    ...x.d,
    sleep: () => new Promise(r => setTimeout(r, 25)),
    emit: async event => {
      const id = pedidoOf(event.payload)
      chain = chain.then(async () => {
        await new Promise(r => setTimeout(r, stepMs))
        await x.store.upsertSubtask({ id: `s-flow-${id}`, taskId: 't1', title: `Owner's request: ${String(event.payload.text)} [high priority] · ${id}`,
          status: 'todo', done: false, createdAt: '2026-11-09T12:00:00.000Z', updatedAt: '2026-11-09T12:00:00.000Z' })
        done.add(id)
      })
      return { status: 'success' }
    },
    run: async (_n, input) => {
      const book = await x.store.read()
      const sub = book.subtasks.find(s => s.id === (input.subtaskIds as string[])[0])
      return linkWorks && sub?.ownerRequest && done.has(sub.ownerRequest.pedidoId) ? { status: 'success' } : { status: 'pending' }
    },
  }
  return { ...x, d, drain: () => chain }
}
const mk = (n: number, text = `Task number ${n}`) => ({ ...request, messageId: `msg-c${n}`, text })

test('concurrent sends (3 at once, then the same text twice) each register exactly one linked subtask and leave no orphan card', async () => {
  const x = await asyncEngineWorld(30)
  const alien = { id: 's-alien', taskId: 't1', title: 'Parallel work', status: 'todo' as const, done: false, createdAt: '2026-11-09T12:00:00.000Z', updatedAt: '2026-11-09T12:00:00.000Z' }
  await x.store.upsertSubtask(alien)
  const results = await Promise.all([1, 2, 3].map(n => registerComposerTask(mk(n), 'en', x.d)))
  expect(results.map(r => r.ok)).toEqual([true, true, true])
  await x.drain()
  const twice = await Promise.all([registerComposerTask(mk(4, 'Same words'), 'en', x.d), registerComposerTask(mk(4, 'Same words'), 'en', x.d)])
  expect(twice.map(r => r.ok)).toEqual([true, true])
  await x.drain()
  const subs = (await x.store.read()).subtasks
  expect(subs.filter(s => s.ownerRequest)).toHaveLength(4)
  expect(subs.find(s => s.id === 's-alien')).toBeTruthy()
  expect(subs.filter(s => s.id.startsWith('s-flow-'))).toHaveLength(0) // flow cards are swept, none orphaned
  expect(subs).toHaveLength(5)
})

test('a failed registration whose flow card lands late leaves zero cards of its own and never touches a foreign one', async () => {
  const x = await asyncEngineWorld(60, false)
  const alien = { id: 's-alien', taskId: 't1', title: 'Parallel work', status: 'todo' as const, done: false, createdAt: '2026-11-09T12:00:00.000Z', updatedAt: '2026-11-09T12:00:00.000Z' }
  await x.store.upsertSubtask(alien)
  expect((await registerComposerTask(mk(1), 'en', x.d)).ok).toBe(false)
  await x.drain()
  expect((await x.store.read()).subtasks.map(s => s.id)).toEqual(['s-alien'])
})
