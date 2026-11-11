/** Run only inside agentop run --rm, with COMPOSER_QA_ENGINE pointing to a private engine checkout. */
import { copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createTaskStore } from '../packages/server/server/sessions/task-store'
import { registerComposerTask, type ComposerTaskDeps } from '../packages/server/server/flows/composer-task'

const engineDir = process.env.COMPOSER_QA_ENGINE
const source = process.env.COMPOSER_QA_SOURCE
const home = process.env.HOME!
assert(engineDir && source && home.includes('agentistics-throwaway'), 'Run in an isolated agentop HOME with explicit engine/source paths')
const dir = join(home, '.agentistics', 'composer-qa')
await mkdir(join(dir, 'flows'), { recursive: true })
// Only these documents are copied. No registry, structured process state, credentials or live ports.
await copyFile(join(source, 'tasks.json'), join(dir, 'tasks.json'))
await copyFile(join(source, 'flows', 'pedidos.json'), join(dir, 'flows', 'pedidos.json'))
const store = createTaskStore(join(dir, 'tasks.json'))
const initial = await store.read()
const original = await Bun.file(join(dir, 'flows', 'pedidos.json')).json()
const audit = ['p-5c849f08cfb7', 'p-2c58c1504d91'].map(id => {
  const p = original.pedidos[id]
  return { id, state: p?.state, missingLinks: (p?.linkedSubtaskIds ?? []).filter((s: string) => !initial.subtasks.some(x => x.id === s)) }
})
const taskId = 't-e1dea7cd6f'
assert(initial.tasks.some(t => t.id === taskId))
// Bundle the actual private flows into the disposable HOME. Its stale workspace links must not
// be repaired in place, so the build resolves contracts to THIS worktree explicitly.
const bundle = await Bun.build({ entrypoints: ['composer-qa-engine'], outdir: join(dir, 'engine'), target: 'bun',
  plugins: [{ name: 'composer-qa-contracts', setup(build) {
    build.onResolve({ filter: /^composer-qa-engine$/ }, () => ({ path: 'composer-qa-engine', namespace: 'composer-qa' }))
    build.onLoad({ filter: /.*/, namespace: 'composer-qa' }, () => ({ contents: `export { createFlowRuntime } from ${JSON.stringify(join(engineDir, 'engine/src/flows/triggers.ts'))}; export { JsonFlowStore, runBuiltinFlow } from ${JSON.stringify(join(engineDir, 'engine/src/flows/index.ts'))};`, loader: 'ts', resolveDir: engineDir }))
    build.onResolve({ filter: /^@agentistics\/(core|engine-api)$/ }, args => ({ path: join(import.meta.dir, '..', 'packages', args.path.split('/')[1]!, 'src/index.ts') }))
  } }],
})
assert(bundle.success, bundle.logs.map(String).join('\n'))
const { createFlowRuntime, JsonFlowStore, runBuiltinFlow } = await import(join(dir, 'engine/composer-qa-engine.js'))
const runs = new JsonFlowStore(join(dir, 'flows', 'runs'))
const board = {
  get: async (ref: string) => ({ ok: true, body: { task: { ...(await store.read()).tasks.find(t => t.id === ref), subtasks: (await store.read()).subtasks.filter(s => s.taskId === ref) } } }),
  subtask: async (ref: string, patch: any) => {
    const existing = patch.id && (await store.read()).subtasks.find(s => s.id === patch.id)
    const id = existing?.id ?? `s-qa-${crypto.randomUUID()}`
    const at = new Date().toISOString()
    await store.upsertSubtask({ status: 'todo', done: false, createdAt: at, updatedAt: at, ...existing, ...patch, id, taskId: ref })
    return { ok: true, body: { id } }
  },
  comment: async () => ({ ok: true, body: { id: 'c-qa' } }),
}
const rt = createFlowRuntime({ dir: join(dir, 'flows'), board, now: Date.now, lang: () => 'en',
  hostOps: {
    'sessoes-gerenciadas': () => ({ sessions: [{ id: 'qa-lead', cwd: dir, role: 'leader', alive: true, state: 'working', taskId }] }),
    'capacidade-de-workers': () => ({ maxWorkers: 0, currentWorkers: 0 }),
    'cutucar-sessao': () => ({ ok: true }),
    'aviso-ao-dono': () => ({ ok: true }),
  },
  run: (n: any, i: any, ops: any, t: any) => runBuiltinFlow(n, i, ops, runs, t),
})
await rt.enable('pedido-do-dono', true)
await rt.enable('encaixe-do-pedido', true)
let linkCalls = 0
const deps: ComposerTaskDeps = {
  now: Date.now, target: async () => ({ taskId, conversationId: 'qa-conversation' }), store: async () => store,
  emit: event => rt.emit(event),
  run: async (n, i) => { linkCalls++; return rt.run(n, i) },
  pedido: async id => (await rt.read('pedidos', { taskId })).pedidos.find((p: any) => p.id === id),
}
const req = { id: 'qa-lead', action: 'prompt', text: 'Fix composer task sending with the switch on.\n' + 'Long attachment-bearing message. '.repeat(40) + '\n/home/example/a.png\n/home/example/b.png', messageId: crypto.randomUUID(), asTask: { priority: 'medium' as const, dueDate: '2026-12-15T14:35' } }
const result = await registerComposerTask(req, 'en', deps)
assert(result.ok, JSON.stringify(result))
if (!result.ok) throw new Error(result.message)
assert.equal(linkCalls, 0, 'Engine placement already linked the pedido; do not relink it')
assert.equal(result.subtask.priority, 'medium')
assert.equal(result.subtask.dueDate, '2026-12-15T14:35')
assert((await registerComposerTask(req, 'en', deps)).ok)
const book = await store.read()
assert.equal(book.subtasks.filter(s => s.ownerRequest?.messageId === req.messageId).length, 1)
const pedido = await deps.pedido!(result.subtask.ownerRequest!.pedidoId, taskId)
assert.deepEqual(pedido?.linkedSubtaskIds, [result.subtask.id])
assert(book.subtasks.some(s => s.id === pedido!.linkedSubtaskIds[0]))
const relink = await rt.run('pedido-link', { id: pedido!.id, subtaskIds: [result.subtask.id], by: 'owner:composer' })
assert.equal(relink.status, 'refused')
assert(JSON.stringify(relink.refusal).includes('already linked'))
console.log(JSON.stringify({ result: 'PASS', audit, newRequest: { state: pedido!.state, survivingLinkedCards: 1, priority: result.subtask.priority, dueDate: result.subtask.dueDate }, hostRelinkCalls: linkCalls, oldAlgorithmRelink: { status: relink.status, refusal: relink.refusal }, liveStoreWritten: false }, null, 2))
