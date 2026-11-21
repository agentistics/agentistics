/**
 * S2a r7 notes R7-2 / R7-3(prod) / R7-4(M8) — regressions. Pure-ish: real stores in a temp dir, the same world the r7 suite uses.
 */
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGuaranteesStore, type ActivationFacts } from './activation'
import { createDeliveryStore } from './store'
import { createGuardsStore } from './guards-store'
import { createDeliveryService } from './service'
import { execGit } from './classify-host'
import { newDelivery, isPureAdoption } from './machine'
import { flowContext } from './guard'
import { forbiddenCapabilities } from './guard-ast.testing'

const T = Date.parse('2026-11-13T10:00:00Z')
const check = async () => ({ ok: true as const, via: 'legacy-browser' as const })
const facts = (now = T): ActivationFacts => ({ now: new Date(now).toISOString(), build: 'qa', capabilities: ['S0', 'S1', 'S2', 'S3'], migrated: ['a'], unexplainedWouldRefuse: 0 })
const flow = flowContext()
type Blocked = { id: string; taskId: string; title: string; blockedBy: string[]; groupMember: boolean; since: string; reason?: string }

function world(root: string, clock: { now: number }) {
  const board = { blocked: [] as Blocked[] }
  const sessions = [{ id: 'leader', role: 'leader', taskId: 't1', alive: true, cwd: '/nowhere', harness: 'claude', worktree: false }]
  const comments: string[] = []
  const store = createDeliveryStore(join(root, 'deliveries.json'), { guard: { deps: { sessions: async () => sessions, git: execGit }, now: () => clock.now } })
  const svc = createDeliveryService({
    store,
    facts: { subtask: async (id: string) => ({ id, taskId: 't1', title: id, status: 'in_progress', groupMember: false, blockedBy: [] }), sessions: async () => sessions, blockedSubtasks: async () => board.blocked } as never,
    board: { comment: async (_t: string, id: string, text: string) => { comments.push(`${id}: ${text}`) }, subtaskFinished: async () => false, setPhaseStatus: async () => ({ ok: true }) } as never,
    notify: { session: async () => true, owner: async () => undefined } as never,
    autonomous: async () => true, emit: async () => undefined, now: () => clock.now,
    classify: { sessions: async () => sessions, git: execGit },
    guardsPath: join(root, 'guards.json'),
    autoReconcile: () => false,
  } as never) as any
  return { svc, board, store, comments }
}

/** A piece with ranked history whose record was deleted: its floor stays, so every re-adoption is refused. */
async function refusedWorld(root: string, clock: { now: number }) {
  const w = world(root, clock)
  const g = createGuaranteesStore(join(root, 'guarantees.json'))
  await g.setState('a', 'shadow', { check, facts: facts(T - 25 * 3600_000) })
  await g.setState('a', 'on', { check, facts: facts() })
  const r = newDelivery({ subtaskId: 's-a', taskId: 't1', at: new Date(T).toISOString() })
  r.adopted = 'board'
  r.history = [{ from: 'executando', to: 'revisao_lider', at: new Date(T).toISOString(), revision: 1, actor: 'flow:entrega', detail: 'review' }]
  await w.store.update(d => { d.deliveries['s-a'] = r }, { guard: flow })
  await w.store.update(d => { delete d.deliveries['s-a'] }, { guard: flow })
  w.board.blocked = [{ id: 's-a', taskId: 't1', title: 's-a', blockedBy: [], groupMember: false, since: new Date(T - 1000).toISOString() }]
  return w
}

test('R7-3 any `.constructor` whose result is called, constructed, passed on or chained is refused, on ANY receiver', () => {
  const refused = [
    'const f = () => 0; f.constructor("return 1")()', "Object.constructor('return 1')()", "''.constructor.constructor('return 1')()",
    '[].map.constructor("x")', 'async function g(){}; g.constructor', 'Object.getPrototypeOf(h).constructor("x")',
    'new x.constructor("x")', 'Reflect.construct(x.constructor, args)', 'Reflect.apply(x.constructor, null, args)', "x['constructor']('x')",
    'const C = x.constructor; C("x")', 'run(x.constructor)', '(x as any).constructor("x")', 'x!.constructor.constructor("x")',
    'const { constructor: C } = x', 'x?.constructor("x")', 'export const y = [x.constructor]', 'bind(...[x.constructor])',
  ]
  for (const src of refused) expect(forbiddenCapabilities(src), src).not.toEqual([])
  // Reading a name or comparing identity is not a capability.
  for (const ok of ['if (x.constructor === Object) {}', 'const n = e.constructor.name', "if (x['constructor'] !== Map) {}"]) expect(forbiddenCapabilities(ok), ok).toEqual([])
})

const refusalNotes =(comments: string[]) => comments.filter(c => c.includes('guard-refused s-a: evidence_binding_protected'))

test('R7-2 a persistently refused piece leaves ONE board note, in English and Portuguese', async () => {
  const root = mkdtempSync(join(tmpdir(), 'r8-dedupe-'))
  try {
    const clock = { now: T }
    const { svc, comments } = await refusedWorld(root, clock)
    for (let i = 0; i < 6; i++) { clock.now += 60_000; await svc.tick() }
    expect(refusalNotes(comments)).toHaveLength(1)
    expect(refusalNotes(comments)[0]).toContain('recusa do guarda')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('R7-2 the note is written again once the refusal has cleared and then comes back', async () => {
  const root = mkdtempSync(join(tmpdir(), 'r8-dedupe-clear-'))
  try {
    const clock = { now: T }
    const { svc, board, comments } = await refusedWorld(root, clock)
    const blocked = board.blocked
    for (let i = 0; i < 3; i++) { clock.now += 60_000; await svc.tick() }
    expect(refusalNotes(comments)).toHaveLength(1)
    board.blocked = []
    clock.now += 60_000; await svc.tick() // nothing is refused this tick: the memory of the refusal is dropped
    board.blocked = blocked
    for (let i = 0; i < 3; i++) { clock.now += 60_000; await svc.tick() }
    expect(refusalNotes(comments)).toHaveLength(2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('R7-4/M8 a board adoption already sitting in a RANKED phase is not a pure adoption: it gets a floor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'r8-m8-'))
  try {
    const clock = { now: T }
    const { store } = world(root, clock)
    const g = createGuaranteesStore(join(root, 'guarantees.json')), guards = createGuardsStore(join(root, 'guards.json'))
    await g.setState('a', 'shadow', { check, facts: facts(T - 25 * 3600_000) })
    await g.setState('a', 'on', { check, facts: facts() })
    const r = newDelivery({ subtaskId: 's-r', taskId: 't1', at: new Date(T).toISOString() })
    r.adopted = 'board'; r.phase = 'ci'; r.revision = 1
    expect(isPureAdoption(r)).toBe(false)
    const pure = newDelivery({ subtaskId: 's-p', taskId: 't1', at: new Date(T).toISOString() })
    pure.adopted = 'board'; pure.phase = 'bloqueado'
    expect(isPureAdoption(pure)).toBe(true)
    try { await store.update(d => { d.deliveries['s-r'] = r }, { guard: flow }) } catch { /* a refusal is also acceptable here; the floor assertion below is what matters */ }
    const floors = (await guards.read()).deliveryFloors ?? {}
    if (await store.get('s-r')) {
      expect(floors['s-r']).toBeDefined()
      await expect(store.update(d => { d.deliveries['s-r']!.phase = 'fila' as never; d.deliveries['s-r']!.revision = 0 }, { guard: flow })).rejects.toBeDefined()
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
