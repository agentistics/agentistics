/**
 * S2b — the guard sweep (spec §2.6, §3.5.17–19, .21). REAL stores in a temp dir: tasks.json (task-store), deliveries.json
 * (delivery store), guards.json (sealed), guarantees.json; the real service `tick()` drives the sweep. A checkpoint is written
 * through the real guards store; the "forger" is a raw file write — what an older binary or a hand edit does.
 */
import { afterEach, beforeEach, describe, expect, test as bunTest } from 'bun:test'
import * as fs from 'node:fs/promises'
import { __setDurableOpsForTest } from '../durable-file'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGuaranteesStore, type ActivationFacts } from './activation'
import { createDeliveryStore } from './store'
import { applyGuardedWrite, createGuardsStore, type GuardAuth, type PieceCheckpoint } from './guards-store'
import { createDeliveryService } from './service'
import { execGit } from './classify-host'
import { flowContext } from './guard'
import { newDelivery } from './machine'
import { createTaskStore, type TaskStore } from '../sessions/task-store'
import { planSweep, sweepWarnings } from './sweep-plan'
import { unattributedContext } from './guard'

const T = Date.parse('2026-11-13T10:00:00Z')
const ISO = new Date(T).toISOString()
const check = async () => ({ ok: true as const, via: 'legacy-browser' as const })
const facts = (now: number): ActivationFacts => ({ now: new Date(now).toISOString(), build: 'qa', capabilities: ['S0', 'S1', 'S2', 'S3'], migrated: ['a'], unexplainedWouldRefuse: 0 })
const def = (id: string, label: string, stage: string, order: number, prot = false) => ({ id, label, color: '#112233', protected: prot, order, stage }) as never
const DEFS = [def('todo', 'To do', 'queue', 0, true), def('in_progress', 'In progress', 'running', 1, true), def('blocked', 'Blocked', 'blocked', 2, true), def('done', 'Done', 'published', 3, true),
  def('in_review', 'In review', 'leader', 4), def('pr_merge', 'PR merge', 'merge', 5), def('ci', 'CI', 'ci', 6)]
const subtask = (id: string, status = 'in_progress') => ({ id, taskId: 't1', title: id, done: false, status, createdAt: ISO, updatedAt: ISO }) as never

/**
 * Every test here builds REAL sealed stores (40+ guarded upserts) and runs the real tick, so under a
 * loaded machine (the full pre-commit hook) one test can take several seconds. Two rules keep that
 * from becoming a flake:
 * - an explicit, realistic timeout per test (bun's 5 s default is below what a loaded run needs);
 * - the teardown WAITS for the test body before deleting its temp dir. When bun times a test out it
 *   runs `afterEach` while the body is still writing; removing the dir under it surfaced as
 *   "errors outside any test" (and a still-installed `fs.rename` spy leaked into the next test).
 */
const WORLD_TIMEOUT_MS = 30_000
const HEAVY_TIMEOUT_MS = 60_000
let running: Promise<unknown> | null = null
const test = (name: string, fn: () => Promise<void> | void, timeout = WORLD_TIMEOUT_MS) =>
  bunTest(name, () => { const p = Promise.resolve().then(fn); running = p; return p }, timeout)

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'sweep-')) })
afterEach(async () => {
  const body = running
  running = null
  if (body) await body.catch(() => {}) // a timed-out body is still running: let it finish first
  rmSync(root, { recursive: true, force: true })
}, HEAVY_TIMEOUT_MS)

interface World { svc: any; tasks: TaskStore; store: ReturnType<typeof createDeliveryStore>; guards: ReturnType<typeof createGuardsStore>; clock: { now: number }; board: { catchUps: string[]; comments: string[] }; logs: string[]; paths: { tasks: string; deliveries: string; guards: string } }

async function world(rule: 'off' | 'shadow' | 'on', pieces = ['p1']): Promise<World> {
  const clock = { now: T }
  const paths = { tasks: join(root, 'tasks.json'), deliveries: join(root, 'deliveries.json'), guards: join(root, 'guards.json') }
  const sessions = [{ id: 'leader', role: 'leader', taskId: 't1', alive: true, cwd: '/nowhere', harness: 'claude', worktree: false }]
  const deps = { sessions: async () => sessions, git: execGit }
  const tasks = createTaskStore(paths.tasks, { guard: { deps, now: () => clock.now } })
  await tasks.seedStatuses(DEFS)
  await tasks.upsertTask({ id: 't1', title: 't1', status: 'in_progress', createdAt: ISO, updatedAt: ISO } as never, unattributedContext())
  for (const id of pieces) await tasks.upsertSubtask(subtask(id), unattributedContext())
  for (let i = 0; i < 40; i++) await tasks.upsertTask({ id: `quiet-${i}`, title: 'quiet', status: 'in_progress', createdAt: ISO, updatedAt: ISO } as never, unattributedContext())
  const store = createDeliveryStore(paths.deliveries, { guard: { deps, now: () => clock.now } })
  const board = { catchUps: [] as string[], comments: [] as string[] }
  const logs: string[] = []
  const svc = createDeliveryService({
    store,
    facts: { subtask: async (id: string) => ({ id, taskId: 't1', title: id, status: 'in_progress', groupMember: false, blockedBy: [] }), sessions: async () => sessions, blockedSubtasks: async () => [] } as never,
    board: { comment: async (_t: string, id: string, text: string) => { board.comments.push(`${id}: ${text}`) }, subtaskFinished: async () => false, setPhaseStatus: async (id: string, phase: string) => { board.catchUps.push(`${id}:${phase}`); return { ok: true } } } as never,
    notify: { session: async () => true, owner: async () => undefined } as never,
    autonomous: async () => true, emit: async () => undefined, now: () => clock.now,
    classify: { sessions: async () => sessions, git: execGit },
    guardsPath: paths.guards, autoReconcile: () => false, log: (l: string) => logs.push(l),
    sweep: { tasks: async () => tasks, paths },
  } as never) as any
  if (rule !== 'off') {
    const g = createGuaranteesStore(join(root, 'guarantees.json'))
    expect(await g.setState('a', 'shadow', { check, facts: facts(T - 25 * 3600_000) })).toEqual({ ok: true })
    if (rule === 'on') expect(await g.setState('a', 'on', { check, facts: facts(T) })).toEqual({ ok: true })
    const guards = createGuardsStore(paths.guards)
    await guards.write({ ...(await guards.read()), migrations: { a: { version: 1, at: ISO } } })
  }
  return { svc, tasks, store, guards: createGuardsStore(paths.guards), clock, board, logs, paths }
}

const cp = (key: string, o: Partial<PieceCheckpoint> = {}): PieceCheckpoint => ({
  key, rank: 1, boardStatus: 'in_review', boardStage: 'leader', phase: 'revisao_lider', revision: 2, headSha: null,
  auth: [{ kind: 'evidence', ids: ['e1'], sha256: ['aa'] }], by: { kind: 'flow', engine: 'entrega' }, at: ISO, transitionId: `tr-${key}`, ...o,
})
const writeCheckpoint = async (w: World, c: PieceCheckpoint) => { const doc = await w.guards.read(); await w.guards.write({ ...doc, checkpoints: { ...doc.checkpoints, [c.key]: c } }) }
const record = (id: string, phase: string, extra: Record<string, unknown> = {}) => {
  const r = newDelivery({ subtaskId: id, taskId: 't1', at: ISO }) as any
  r.phase = phase; r.revision = 2
  r.history = [{ from: 'fila', to: 'executando', at: ISO, actor: 'flow:entrega', revision: 1, detail: 'start' }]
  r.evidence = [{ id: 'e1', sha256: 'aa', revision: 1 }]
  return Object.assign(r, extra)
}
/** What an older binary or a hand edit does: bytes, with no guard in the way. */
const forgeBoard = (w: World, id: string, patch: Record<string, unknown>) => {
  const raw = JSON.parse(readFileSync(w.paths.tasks, 'utf8'))
  raw.subtasks = raw.subtasks.map((s: any) => (s.id === id ? { ...s, ...patch } : s))
  writeFileSync(w.paths.tasks, JSON.stringify(raw))
}
const forgeDelivery = (w: World, id: string, patch: Record<string, unknown>) => {
  let raw: any
  try { raw = JSON.parse(readFileSync(w.paths.deliveries, 'utf8')) } catch { raw = { version: 1, deliveries: {} } }
  raw.deliveries[id] = { ...(raw.deliveries[id] ?? record(id, 'executando')), ...patch }
  writeFileSync(w.paths.deliveries, JSON.stringify(raw))
}
const boardOf = async (w: World, id: string) => (await w.tasks.read()).subtasks.find(s => s.id === id)!
const comments = async (w: World, id: string) => (await w.tasks.read()).comments.filter(c => c.subtaskId === id).map(c => c.body)

describe('§3.5.17 forged state against the real storage', () => {
  for (const [name, board, delivery] of [['board status only', true, false], ['delivery phase only', false, true], ['both', true, true]] as const) {
    test(`${name} → the real tick puts both documents back at the checkpoint, with a comment and a history entry`, async () => {
      const w = await world('on')
      await writeCheckpoint(w, cp('p1', { rank: 0, boardStatus: 'in_progress', boardStage: 'running', phase: 'executando', auth: [{ kind: 'grandfathered', at: ISO }] }))
      forgeDelivery(w, 'p1', record('p1', 'executando'))
      if (board) forgeBoard(w, 'p1', { status: 'in_review' })
      if (delivery) forgeDelivery(w, 'p1', { phase: 'revisao_lider' })
      const out = await w.svc.tick()
      expect(out.actions.join(' | ')).toContain('sweep-revert p1: above_checkpoint')
      expect((await boardOf(w, 'p1')).status).toBe('in_progress')
      expect((await w.store.get('p1'))!.phase).toBe('executando')
      if (delivery) expect((await w.store.get('p1'))!.history.at(-1)).toMatchObject({ to: 'executando', actor: 'flow:sweep' })
      const said = (await comments(w, 'p1')).join('\n')
      expect(said).toContain('guard sweep reverted p1')
      expect(said).toContain('only reverts raw file writes')
      expect(said).toContain('varredura do guarda reverteu p1')
    })
  }

  test('a piece with NO checkpoint that jumped to review has no authorization on record: reverted', async () => {
    const w = await world('on')
    forgeBoard(w, 'p1', { status: 'in_review' })
    await w.svc.tick()
    expect((await boardOf(w, 'p1')).status).toBe('in_progress')
  })

  test('above a rank-1 checkpoint (ci instead of review) goes back to the checkpoint, not to rank 0', async () => {
    const w = await world('on')
    await writeCheckpoint(w, cp('p1'))
    forgeDelivery(w, 'p1', record('p1', 'revisao_lider'))
    forgeBoard(w, 'p1', { status: 'ci' }); forgeDelivery(w, 'p1', { phase: 'ci' })
    await w.svc.tick()
    expect((await boardOf(w, 'p1')).status).toBe('in_review')
    expect((await w.store.get('p1'))!.phase).toBe('revisao_lider')
    expect((await w.store.get('p1'))!.revision).toBe(2)
    expect((await w.store.get('p1'))!.history.at(-1)!.revision).toBe(2)
  })

  test('the ci SIGNAL alone moves the Live: it is cleared when the checkpoint is lower', async () => {
    const w = await world('on')
    forgeBoard(w, 'p1', { ci: { mergedMain: true, releaseGreen: false, tagPublished: false, tag: null, pr: 1 } })
    await w.svc.tick()
    expect((await boardOf(w, 'p1')).ci).toBeUndefined()
  })

  test('a legitimate piece at its checkpoint is left alone (control): nothing is written', async () => {
    const w = await world('on')
    await writeCheckpoint(w, cp('p1'))
    forgeDelivery(w, 'p1', record('p1', 'revisao_lider'))
    forgeBoard(w, 'p1', { status: 'in_review' })
    const before = readFileSync(w.paths.tasks, 'utf8')
    const out = await w.svc.tick()
    expect(out.actions.join(' ')).not.toContain('sweep-revert')
    expect(readFileSync(w.paths.tasks, 'utf8')).toBe(before)
  })
})

describe('§3.5.18 the checkpoint, not the feed, authorizes', () => {
  test('after 2 001 unrelated events the next tick does not revert the authorized piece', async () => {
    const w = await world('on')
    await writeCheckpoint(w, cp('p1'))
    forgeDelivery(w, 'p1', record('p1', 'revisao_lider'))
    forgeBoard(w, 'p1', { status: 'in_review' })
    await w.tasks.logEvents(Array.from({ length: 2001 }, (_, i) => ({ id: `e-${i}`, taskId: 't1', at: ISO, actor: 'x', kind: 'comment' })) as never)
    const out = await w.svc.tick()
    expect(out.actions.join(' ')).not.toContain('sweep-revert')
    expect((await boardOf(w, 'p1')).status).toBe('in_review')
  })
})

describe('§3.5.19 crash between writes', () => {
  const crashAfter = async (w: World, stage: 'documents' | 'intent') => {
    const target = cp('p1')
    try {
      await applyGuardedWrite({
        locks: ['tasks', 'deliveries', 'guards'], paths: w.paths, piece: 'p1', target, now: ISO,
        writeDocuments: async () => { if (stage === 'intent') throw new Error('crash after the intent'); forgeBoard(w, 'p1', { status: 'in_review' }) },
        afterDocuments: async () => { throw new Error('crash after the task write') },
      })
    } catch { /* the crash */ }
    expect(Object.keys((await w.guards.read()).intents)).toEqual(['p1'])
  }
  test('after the intent AND the task write: the next tick commits the intent and reverts nothing', async () => {
    const w = await world('on')
    forgeDelivery(w, 'p1', record('p1', 'revisao_lider'))
    forgeDelivery(w, 'p1', { phase: 'revisao_lider' })
    await crashAfter(w, 'documents')
    const out = await w.svc.tick()
    expect(out.actions.join(' | ')).toContain('sweep-intent-committed p1')
    expect(out.actions.join(' ')).not.toContain('sweep-revert')
    const doc = await w.guards.read()
    expect(doc.intents).toEqual({})
    expect(doc.checkpoints.p1).toMatchObject({ rank: 1, transitionId: 'tr-p1' })
    expect((await boardOf(w, 'p1')).status).toBe('in_review')
  })
  test('after the intent only: the next tick drops it and reverts nothing', async () => {
    const w = await world('on')
    await crashAfter(w, 'intent')
    const out = await w.svc.tick()
    expect(out.actions.join(' | ')).toContain('sweep-intent-dropped p1')
    expect(out.actions.join(' ')).not.toContain('sweep-revert')
    const doc = await w.guards.read()
    expect(doc.intents).toEqual({})
    expect(doc.checkpoints.p1).toBeUndefined()
    expect((await boardOf(w, 'p1')).status).toBe('in_progress')
  })
})

describe('evidence, owner, catch-up', () => {
  const reviewed = async (extra: Partial<PieceCheckpoint> = {}, rec: Record<string, unknown> = {}) => {
    const w = await world('on')
    await writeCheckpoint(w, cp('p1', extra))
    forgeDelivery(w, 'p1', record('p1', 'revisao_lider', rec))
    forgeBoard(w, 'p1', { status: 'in_review' })
    return w
  }
  for (const [name, rec] of [['the evidence item is gone', { evidence: [] }], ['the id now points at other bytes', { evidence: [{ id: 'e1', sha256: 'bb', revision: 1 }] }],
    ['it belongs to an earlier capture round', { evidence: [{ id: 'e1', sha256: 'aa', revision: 1 }], history: [{ from: 'qa', to: 'ajuste', at: ISO, actor: 'x', revision: 2, detail: 'again' }] }]] as const) {
    test(`evidence_stale — ${name}: back to in_progress / ajuste`, async () => {
      const w = await reviewed({}, rec as never)
      const out = await w.svc.tick()
      expect(out.actions.join(' | ')).toContain('sweep-revert p1: evidence_stale')
      expect((await boardOf(w, 'p1')).status).toBe('in_progress')
      expect((await w.store.get('p1'))!.phase).toBe('ajuste')
    })
  }
  test('evidence_stale — the verified HEAD moved', async () => {
    const w = await reviewed({ headSha: 'abc1234' }, { headSha: 'def5678' })
    await w.svc.tick()
    expect((await boardOf(w, 'p1')).status).toBe('in_progress')
  })
  test('control: evidence intact and HEAD unchanged → left alone', async () => {
    const w = await reviewed({ headSha: 'abc1234' }, { headSha: 'abc1234' })
    const out = await w.svc.tick()
    expect(out.actions.join(' ')).not.toContain('sweep-revert')
  })
  for (const via of ['vault-credential', 'legacy-browser'] as const) test(`an owner checkpoint (${via}) is never reverted, above or stale`, async () => {
    const w = await reviewed({ auth: [{ kind: 'owner', via }, { kind: 'evidence', ids: ['e1'], sha256: ['aa'] }] as GuardAuth[], rank: 1 }, { evidence: [] })
    forgeBoard(w, 'p1', { status: 'ci' }); forgeDelivery(w, 'p1', { phase: 'ci' })
    const before = readFileSync(w.paths.tasks, 'utf8')
    const out = await w.svc.tick()
    expect(out.actions.join(' ')).not.toContain('sweep-revert')
    expect(readFileSync(w.paths.tasks, 'utf8')).toBe(before)
    expect((await w.store.get('p1'))!.phase).toBe('ci')
  })
  test('board BELOW the checkpoint while the phase is at it → the board is caught up, nothing is reverted', async () => {
    const w = await world('on')
    await writeCheckpoint(w, cp('p1'))
    forgeDelivery(w, 'p1', record('p1', 'revisao_lider'))
    const out = await w.svc.tick()
    expect(out.actions.join(' | ')).toContain('sweep-catch-up p1 → revisao_lider')
    expect(w.board.catchUps).toEqual(['p1:revisao_lider'])
    expect(out.actions.join(' ')).not.toContain('sweep-revert')
    expect((await w.store.get('p1'))!.phase).toBe('revisao_lider')
  })
})

describe('bounded chunks, breaker, loop guard', () => {
  test('12 forged pieces below the breaker are all repaired in one tick in bounded document chunks', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `q${i}`)
    const w = await world('on', ids)
    for (const id of ids) await writeCheckpoint(w, cp(id, { rank: 0, boardStatus: 'in_progress', boardStage: 'running', phase: 'executando', auth: [{ kind: 'grandfathered', at: ISO }] }))
    for (const id of ids) forgeDelivery(w, id, record(id, 'executando'))
    const raw = JSON.parse(readFileSync(w.paths.tasks, 'utf8'))
    raw.tasks.push(...Array.from({ length: 240 }, (_, i) => ({ id: `padding-${i}`, title: 'padding', status: 'in_progress', createdAt: ISO, updatedAt: ISO })))
    raw.subtasks = raw.subtasks.map((s: any) => ({ ...s, status: 'in_review' }))
    writeFileSync(w.paths.tasks, JSON.stringify(raw))
    const del = JSON.parse(readFileSync(w.paths.deliveries, 'utf8'))
    for (const id of ids) del.deliveries[id].phase = 'revisao_lider'
    writeFileSync(w.paths.deliveries, JSON.stringify(del))
    // The board and the delivery book are written through `durableWrite`, whose rename is the injectable seam (dev #1494).
    const original = fs.rename, renamed: string[] = []
    __setDurableOpsForTest({ rename: (async (from: any, to: any) => { renamed.push(String(to)); return (original as any)(from, to) }) as typeof fs.rename })
    try { await w.svc.tick() } finally { __setDurableOpsForTest(null) }
    expect(renamed.filter(p => p === w.paths.tasks)).toHaveLength(3)
    expect(renamed.filter(p => p === w.paths.deliveries)).toHaveLength(3)
    const book = await w.tasks.read()
    expect(book.subtasks.filter(s => s.status === 'in_progress')).toHaveLength(12)
    for (const id of ids) expect((await w.store.get(id))!.phase).toBe('executando')
  }, HEAVY_TIMEOUT_MS)

  test('a piece reverted twice in 24 h is BLOCKED (externo), the WARN says how to release it (r4: no longer `guarantee off`), the third forge is not a silent revert', async () => {
    const w = await world('on')
    await writeCheckpoint(w, cp('p1', { rank: 0, boardStatus: 'in_progress', boardStage: 'running', phase: 'executando', auth: [{ kind: 'grandfathered', at: ISO }] }))
    forgeDelivery(w, 'p1', record('p1', 'executando'))
    forgeBoard(w, 'p1', { status: 'in_review' }); await w.svc.tick()
    expect((await boardOf(w, 'p1')).status).toBe('in_progress')
    w.clock.now += 3600_000
    forgeBoard(w, 'p1', { status: 'in_review' })
    const out = await w.svc.tick()
    expect(out.actions.join(' | ')).toContain('sweep-revert p1: above_checkpoint (loop: blocked)')
    expect((await boardOf(w, 'p1')).status).toBe('blocked')
    expect((await comments(w, 'p1')).join(' ')).toContain('an unknown writer keeps moving this piece')
    const rec = (await w.store.get('p1'))!
    expect(rec.phase).toBe('bloqueado')
    expect(w.logs.join('\n')).toContain('only reverts raw file writes')
    const doc = await w.guards.read()
    expect(sweepWarnings(doc.sweep, w.clock.now).join(' ')).toContain('only reverts raw writes')
  })

  test('reverts older than 24 h do not count: the loop window expires', async () => {
    const w = await world('on')
    await writeCheckpoint(w, cp('p1', { rank: 0, boardStatus: 'in_progress', boardStage: 'running', phase: 'executando', auth: [{ kind: 'grandfathered', at: ISO }] }))
    forgeBoard(w, 'p1', { status: 'in_review' }); await w.svc.tick()
    w.clock.now += 25 * 3600_000
    forgeBoard(w, 'p1', { status: 'in_review' }); await w.svc.tick()
    expect((await boardOf(w, 'p1')).status).toBe('in_progress')
  })
})

describe('rule off is the base; shadow only reports', () => {
  test('OFF: a forged state stays, no byte of any document changes, no guards.json appears', async () => {
    const w = await world('off')
    forgeBoard(w, 'p1', { status: 'in_review' })
    const before = readFileSync(w.paths.tasks, 'utf8')
    const out = await w.svc.tick()
    expect(out.actions.join(' ')).not.toContain('sweep')
    expect(readFileSync(w.paths.tasks, 'utf8')).toBe(before)
    expect(() => readFileSync(w.paths.guards, 'utf8')).toThrow()
  })
  test('SHADOW: would-revert is reported and nothing is reverted', async () => {
    const w = await world('shadow')
    forgeBoard(w, 'p1', { status: 'in_review' })
    const before = readFileSync(w.paths.tasks, 'utf8')
    const out = await w.svc.tick()
    expect(out.actions.join(' | ')).toContain('sweep would-revert p1: no_checkpoint')
    expect(readFileSync(w.paths.tasks, 'utf8')).toBe(before)
  })
  test('an unreadable guards.json skips the sweep (named) and the rest of the tick still runs', async () => {
    const w = await world('on')
    writeFileSync(w.paths.guards, '{not json')
    forgeBoard(w, 'p1', { status: 'in_review' })
    const out = await w.svc.tick()
    expect(out.actions.join(' | ')).toContain('sweep-skipped')
    expect((await boardOf(w, 'p1')).status).toBe('in_review')
  })
})

test('planSweep is pure: the same input answers the same plan', () => {
  const input = { pieces: [{ key: 'p', taskId: 't', subtaskId: 'p', boardStatus: 'in_review', boardRank: 1, ciRank: 0, record: null }], checkpoints: {}, statuses: DEFS as never, memory: { reverts: {} }, now: T }
  expect(planSweep(input)).toEqual(planSweep(input))
  expect(planSweep(input).reverts[0]).toMatchObject({ key: 'p', reason: 'no_checkpoint', board: { to: 'in_progress' } })
})
