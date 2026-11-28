/**
 * S7a r2 — the QA findings (F1–F6) against REAL stores in an isolated temp dir: deliveries.json, guards.json, tasks.json (the
 * real TaskStore), a real session registry and real sidebar-folder values. Every attack goes through its real door, and every
 * negative control runs after the positive helper has established custody AND its message in the same fixture.
 * No server, no port, no network; git is not involved.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout } from 'bun:test'
import { ownedTests, REAL_STORE_TIMEOUT_MS } from './real-store-lifecycle.testing'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planAddToGroup, planCreateGroup, planNestGroup, type SessionUserGroupsValue } from '@agentistics/core'
import { createGuaranteesStore, type ActivationFacts, type RuleState } from './activation'
import { createDeliveryStore } from './store'
import { createDeliveryService } from './service'
import { newDelivery, type DeliveryRecord } from './machine'
import { orphanMsOf } from './custody'
import { custodyTick } from './custody-tick'
import { flowContext } from './guard'
import { guardPathsOf } from './guard-host'
import { withGuardEnvelope } from './guard-transaction'
import { resolveCustodyProjects } from './custody-project'
import { lockFile } from '../sessions/file-lock'
import { createTaskStore } from '../sessions/task-store'
import { createSessionRegistry } from '../sessions/registry'
import { unattributedContext } from './guard'

const MIN = 60_000
const H = 3600_000
const N = orphanMsOf(undefined)
const T0 = Date.parse('2026-11-16T08:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const check = async () => ({ ok: true as const, via: 'legacy-browser' as const })
const facts = (now: number): ActivationFacts => ({ now: iso(now), build: 'qa', capabilities: ['S0', 'S1', 'S2', 'S3', 'S7'], migrated: ['a', 'c'], unexplainedWouldRefuse: 0 })
const PROJECT = new Map<string, string>([['p1', 'acme/app'], ['p2', 'acme/app'], ['p3', 'acme/app'], ['px', 'acme/other']])

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'custody-r2-')) })
const { test, settled } = ownedTests()
setDefaultTimeout(REAL_STORE_TIMEOUT_MS)
afterEach(async () => { await settled(); rmSync(root, { recursive: true, force: true }) })

interface Row { id: string; role: string; taskId: string; alive: boolean; cwd: string; harness: string; worktree: boolean }
const row = (id: string, taskId: string, alive = true, role = 'leader'): Row => ({ id, role, taskId, alive, cwd: '/nowhere', harness: 'claude', worktree: false })
const custodyMsgs = (w: World, to?: string) => w.messages.filter(m => m.text.includes('flow custódia') && (to === undefined || m.to === to))

interface World {
  svc: any; clock: { now: number }; fleet: { rows: Row[] | null }; messages: Array<{ to: string; text: string }>
  path: string; tasks: ReturnType<typeof createTaskStore>; writes: { updates: number }
  reload(): { svc: any; store: ReturnType<typeof createDeliveryStore> }; read(id: string): any
}

async function world(rules: { a?: RuleState; c: RuleState }): Promise<World> {
  const clock = { now: T0 }
  const fleet: World['fleet'] = { rows: [] }
  const messages: World['messages'] = []
  const writes = { updates: 0 }
  const path = join(root, 'deliveries.json')
  const tasks = createTaskStore(join(root, 'tasks.json'))
  const build = () => {
    const raw = createDeliveryStore(path)
    const store = { ...raw, path, read: raw.read, readStrict: raw.readStrict, get: raw.get, update: ((fn: any, o: any) => { writes.updates++; return raw.update(fn, o) }) as typeof raw.update }
    const svc = createDeliveryService({
      store: store as never,
      facts: { subtask: async (id: string) => ({ id, taskId: `t-${id}`, title: id, status: 'in_review', groupMember: false, blockedBy: [] }), sessions: async () => { if (!fleet.rows) throw new Error('fleet unreadable'); return fleet.rows }, blockedSubtasks: async () => [] } as never,
      board: { comment: async () => undefined, subtaskFinished: async () => false, setPhaseStatus: async () => ({ ok: true }) } as never,
      notify: { session: async (to: string, text: string) => { messages.push({ to, text }); return fleet.rows?.find(r => r.id === to)?.alive === true }, owner: async () => undefined } as never,
      autonomous: async () => true, emit: async () => undefined, now: () => clock.now, autoReconcile: () => false,
      custody: { tasks: async () => tasks, projectsOf: async (pieces: ReadonlyArray<{ subtaskId: string }>) => new Map(pieces.map(p => [p.subtaskId, PROJECT.get(p.subtaskId) ?? ''] as const)), orphanAfterHours: async () => undefined },
    } as never) as any
    return { svc, store: raw }
  }
  const first = build()
  const g = createGuaranteesStore(join(root, 'guarantees.json'))
  for (const [rule, state] of [['c', rules.c], ['a', rules.a ?? 'off']] as const) {
    if (state === 'off') continue
    expect(await g.setState(rule, 'shadow', { check, facts: facts(T0 - 25 * H) })).toEqual({ ok: true })
    if (state === 'on') expect(await g.setState(rule, 'on', { check, facts: facts(T0) })).toEqual({ ok: true })
  }
  return { svc: first.svc, clock, fleet, messages, path, tasks, writes, reload: build, read: id => JSON.parse(readFileSync(path, 'utf8')).deliveries[id] }
}

const seed = (w: World, id: string, o: Partial<DeliveryRecord> = {}) => {
  let raw: any
  try { raw = JSON.parse(readFileSync(w.path, 'utf8')) } catch { raw = { version: 1, deliveries: {} } }
  const r = newDelivery({ subtaskId: id, taskId: `t-${id}`, at: iso(T0 - H) }) as any
  r.phase = 'revisao_lider'; r.revision = 2
  r.history = [{ from: 'fila', to: 'revisao_lider', at: iso(T0 - H), actor: 'flow:entrega', revision: 2, detail: 'x' }]
  raw.deliveries[id] = Object.assign(r, o)
  writeFileSync(w.path, JSON.stringify(raw))
}
const tickAt = async (w: World, ms: number) => { w.clock.now = ms; return (await w.reload().svc.tick()).actions as string[] }
const upTo = async (w: World, from: number, to: number, step = 5 * MIN) => { for (let t = from; t <= to; t += step) await tickAt(w, t) }

/**
 * The positive (§5.4.1): L1 filed p1 and acted at T0, then died; L2 is a live leader of the same project. The helper asserts the
 * FINAL custodian, the message it received (exactly once, naming p1) and that the state is on disk — every consumer starts from it.
 */
async function established(rules: { a?: RuleState; c: RuleState } = { c: 'on' }): Promise<World> {
  const w = await world(rules)
  seed(w, 'p1', { leaderSessionId: 'L1', leaderActivityBy: 'L1', leaderActivityAt: iso(T0) })
  seed(w, 'p2', { taskId: 't-p2', leaderSessionId: 'L2', leaderActivityBy: 'L2', leaderActivityAt: iso(T0 + N) })
  w.fleet.rows = [row('L1', 't-p1', false), row('L2', 't-p2')]
  await upTo(w, T0 + 5 * MIN, T0 + N - 5 * MIN)
  expect(w.read('p1').custody).toBeUndefined()
  await upTo(w, T0 + N, T0 + N + 10 * MIN)
  expect(w.read('p1').custody).toMatchObject({ sessionId: 'L2', via: 'project-leader', project: 'acme/app' })
  expect(w.read('p1').custody.notifiedAt).toBeTruthy()
  expect(custodyMsgs(w, 'L2')).toHaveLength(1)
  expect(custodyMsgs(w, 'L2')[0]!.text).toContain('p1')
  expect(custodyMsgs(w)).toHaveLength(1)
  return w
}
const live = (w: World, id: string) => { w.fleet.rows = w.fleet.rows!.map(r => (r.id === id ? { ...r, alive: true } : r)) }

const deps = (w: World, extra: Record<string, unknown> = {}) => {
  const paths = guardPathsOf({ deliveriesFile: w.path }).paths
  return {
    rule: async () => 'on' as const, store: w.reload().store as never, envelope: <T>(fn: () => Promise<T>) => withGuardEnvelope(paths, fn),
    board: async () => { const b = await w.tasks.read(); return { comments: b.comments, events: b.events } },
    sessions: async () => w.fleet.rows as never, projectsOf: async () => PROJECT, orphanAfterHours: async () => undefined,
    notify: async (to: string, text: string) => { w.messages.push({ to, text }); return true }, guard: flowContext('custody'), now: () => w.clock.now, ...extra,
  }
}

describe('F1 — decide AND apply inside the envelope; a concurrent action wins', () => {
  test('a leader action landing between the read and the plan cancels the stale assignment (no custody, no message)', async () => {
    const w = await established()
    // Hand the piece back to L1's orbit: L1 alive, p1 an orphan again with no custody (a fresh fixture state).
    seed(w, 'p1', { leaderSessionId: 'L1', leaderActivityBy: 'L1', leaderActivityAt: iso(T0), leaderAbsentSince: iso(T0) })
    live(w, 'L1'); w.fleet.rows = w.fleet.rows!.map(r => (r.id === 'L2' ? r : r))
    w.clock.now = T0 + N + 20 * MIN
    const before = w.messages.length
    const actions: string[] = []
    await custodyTick(deps(w, {
      projectsOf: async () => { expect((await w.reload().svc.configure('p1', { versionTarget: '9.0.0' }, 'L1')).ok).toBe(true); return PROJECT },
    }) as never, actions)
    expect(w.read('p1').leaderActivityAt).toBe(iso(w.clock.now))
    expect(w.read('p1').custody).toBeUndefined()
    expect(w.messages.length).toBe(before)
    expect(actions.some(a => a.startsWith('custody-assigned'))).toBe(false)
  })
  test('a leader action landing INSIDE the write (after the freshest read) is recomputed away: no custody, no message', async () => {
    const w = await established()
    seed(w, 'p1', { leaderSessionId: 'L1', leaderActivityBy: 'L1', leaderActivityAt: iso(T0), leaderAbsentSince: iso(T0) })
    live(w, 'L1')
    w.clock.now = T0 + N + 20 * MIN
    const before = w.messages.length
    const real = w.reload().store
    const racing = { ...real, path: w.path, read: real.read, update: (async (fn: any, o: any) => {
      if (!(racing as any).done) { (racing as any).done = true; expect((await w.reload().svc.configure('p1', { versionTarget: '7.0.0' }, 'L1')).ok).toBe(true) }
      return real.update(fn, o)
    }) as typeof real.update }
    await custodyTick(deps(w, { store: racing }) as never, [])
    expect(w.read('p1').custody).toBeUndefined()
    expect(w.read('p1').leaderAbsentSince).toBeNull()
    expect(w.messages.length).toBe(before)
  })
  test('a piece published between the read and the plan is never given a custody', async () => {
    const w = await established()
    seed(w, 'p3', { taskId: 't-p3', leaderSessionId: 'Z', leaderActivityBy: 'Z', leaderActivityAt: iso(T0) })
    w.fleet.rows = [...w.fleet.rows!, row('Z', 't-p3', false)]
    w.clock.now = T0 + N + 30 * MIN
    const before = w.messages.length
    await custodyTick(deps(w, {
      projectsOf: async () => { seed(w, 'p3', { taskId: 't-p3', phase: 'publicado' as never, leaderSessionId: 'Z', leaderActivityBy: 'Z', leaderActivityAt: iso(T0) }); return PROJECT },
    }) as never, [])
    expect(w.read('p3').custody).toBeUndefined()
    expect(w.messages.length).toBe(before)
  })
  test('a piece that retreated out of review between the read and the plan is never given a custody', async () => {
    const w = await established()
    seed(w, 'p3', { taskId: 't-p3', leaderSessionId: 'Z', leaderActivityBy: 'Z', leaderActivityAt: iso(T0) })
    w.fleet.rows = [...w.fleet.rows!, row('Z', 't-p3', false)]
    w.clock.now = T0 + N + 30 * MIN
    await custodyTick(deps(w, {
      projectsOf: async () => { seed(w, 'p3', { taskId: 't-p3', phase: 'fila' as never, leaderSessionId: 'Z', leaderActivityBy: 'Z', leaderActivityAt: iso(T0) }); return PROJECT },
    }) as never, [])
    expect(w.read('p3').custody).toBeUndefined()
  })
  test('control: without the race the very same tick DOES assign (the positive of this fixture)', async () => {
    const w = await established()
    seed(w, 'p3', { taskId: 't-p3', leaderSessionId: 'Z', leaderActivityBy: 'Z', leaderActivityAt: iso(T0) })
    w.fleet.rows = [...w.fleet.rows!, row('Z', 't-p3', false)]
    w.clock.now = T0 + N + 30 * MIN
    await custodyTick(deps(w) as never, [])
    expect(w.read('p3').custody).toMatchObject({ sessionId: 'L2' })
    expect(custodyMsgs(w, 'L2')).toHaveLength(2)
  })
})

describe('F2 — rule C is fail-closed by itself (A off and A on)', () => {
  for (const a of ['off', 'shadow'] as const) {
    test(`A ${a} / C on: a held deliveries lock SKIPS the tick — no byte written, no message, guard_busy said`, async () => {
      const w = await established({ a, c: 'on' })
      seed(w, 'p3', { taskId: 't-p3', leaderSessionId: 'Z', leaderActivityBy: 'Z', leaderActivityAt: iso(T0) })
      w.fleet.rows = [...w.fleet.rows!, row('Z', 't-p3', false)]
      const cs = () => JSON.stringify(['p1', 'p2', 'p3'].map(id => ['leaderAbsentSince', 'custody', 'custodyLog', 'leaderActivityAt'].map(k => w.read(id)?.[k]))); const bytes = cs()
      const msgs = w.messages.length
      const held = await lockFile(w.path)
      expect(held.contended).toBe(false)
      let actions: string[] = []
      try { actions = await tickAt(w, T0 + N + 30 * MIN) } finally { await held.release() }
      expect(actions.join(' | ')).toContain('guard_busy')
      expect(cs()).toBe(bytes)
      expect(w.messages.length).toBe(msgs)
      // control: the moment the lock is free, the same tick writes.
      await tickAt(w, T0 + N + 31 * MIN)
      expect(w.read('p3').custody).toMatchObject({ sessionId: 'L2' })
    })
  }
  test('rule C off keeps the OLD locking: nothing custody-shaped is taken or written', async () => {
    const w = await world({ c: 'off' })
    seed(w, 'p1', { leaderSessionId: 'L1', leaderActivityBy: 'L1', leaderActivityAt: iso(T0) })
    w.fleet.rows = [row('L1', 't-p1', false)]
    const cs = () => JSON.stringify(['p1'].map(id => ['leaderAbsentSince', 'custody', 'custodyLog'].map(k => w.read(id)?.[k]))); const bytes = cs()
    const held = await lockFile(w.path)
    try { await tickAt(w, T0 + N + 30 * MIN) } finally { await held.release() }
    expect(cs()).toBe(bytes)
  })
})

describe('F3 — only semantic, authorized changes are activity', () => {
  test('empty, invalid and idempotent configure never renew the clock, and never take custody back', async () => {
    const w = await established()
    live(w, 'L1')
    // the positive of THIS finding: one real change by L1 is activity (and ends the custody).
    const base = w.read('p1').leaderActivityAt
    for (const [patch, at] of [[{}, 30], [{ versionTarget: '   ' }, 40], [{ tag: 'not a tag!' }, 50], [{ pr: -1 }, 60]] as const) {
      w.clock.now = T0 + N + at * MIN
      expect((await w.reload().svc.configure('p1', patch as never, 'L1')).ok).toBe(true)
      expect(w.read('p1').leaderActivityAt).toBe(base)
    }
    await tickAt(w, T0 + N + 70 * MIN)
    expect(w.read('p1').custody).toMatchObject({ sessionId: 'L2' })
    // first real value: activity. The SAME value again two hours later: not activity.
    w.clock.now = T0 + N + 80 * MIN
    await w.reload().svc.configure('p1', { versionTarget: '9.0.0' }, 'L1')
    const first = w.read('p1').leaderActivityAt
    expect(first).toBe(iso(w.clock.now))
    w.clock.now += 2 * H
    await w.reload().svc.configure('p1', { versionTarget: '9.0.0' }, 'L1')
    expect(w.read('p1').leaderActivityAt).toBe(first)
  })
  test('a stranger or a worker configure is refused or stamps nothing; the owner stamps nothing', async () => {
    const w = await established()
    const base = w.read('p1').leaderActivityAt
    for (const actor of ['owner', 'stranger-session', 'W1']) { w.clock.now += MIN; await w.reload().svc.configure('p1', { versionTarget: '3.0.0' }, actor) }
    expect(w.read('p1').leaderActivityAt).toBe(base)
    expect(w.read('p1').leaderActivityBy).toBe('L1')
  })
})

describe('F4 — the stamp is part of the action\'s own write; the board\'s own decisions count', () => {
  test('one configure = ONE store write carrying both the setting and the stamp', async () => {
    const w = await established()
    live(w, 'L1')
    const svc = w.reload().svc
    w.writes.updates = 0
    w.clock.now = T0 + N + 20 * MIN
    await svc.configure('p1', { versionTarget: '4.0.0' }, 'L1')
    expect(w.writes.updates).toBe(1)
    expect(w.read('p1')).toMatchObject({ versionTarget: '4.0.0', leaderActivityBy: 'L1', leaderActivityAt: iso(w.clock.now) })
  })
  test('crash between the action and the stamp is impossible: a write that fails leaves neither', async () => {
    const w = await established()
    live(w, 'L1')
    const before = readFileSync(w.path, 'utf8')
    const { store } = w.reload()
    await expect(store.update(doc => { doc.deliveries.p1!.versionTarget = '5.0.0'; throw new Error('crash mid-write') }, { guard: unattributedContext(), stamp: { key: 'p1', actor: 'L1', at: iso(T0 + N) } })).rejects.toThrow('crash mid-write')
    expect(readFileSync(w.path, 'utf8')).toBe(before)
  })
  test('a refused transition is not a piece action (no stamp)', async () => {
    const w = await established()
    live(w, 'L1')
    const base = w.read('p1').leaderActivityAt
    w.clock.now = T0 + N + 20 * MIN
    const out = await w.reload().svc.transition('p1', 'nao_existe', {}, 'L1')
    expect(out.ok).toBe(false)
    expect(w.read('p1').leaderActivityAt).toBe(base)
  })
  const post = (w: World, o: Record<string, unknown>) => w.tasks.addComment({ id: `c-${Math.random().toString(36).slice(2)}`, taskId: 't-p1', subtaskId: 'p1', threadId: 'th1', role: 'session', sessionId: 'L1', kind: 'decision', author: 'L1', body: 'Approved the approach after review.', createdAt: iso(w.clock.now), ...o } as never)
  test('a verified leader DECISION thread comment on the piece is activity: the original leader returns and custody ends', async () => {
    const w = await established()
    live(w, 'L1')
    w.clock.now = T0 + N + 30 * MIN
    await post(w, {})
    await tickAt(w, w.clock.now + MIN)
    const rec = w.read('p1')
    expect(rec.custody).toBeUndefined()
    expect(rec.leaderAbsentSince).toBeNull()
    expect(rec.custodyLog.map((e: any) => e.event)).toEqual(['assigned', 'ended'])
  })
  test('a verified BLOCK thread comment counts too', async () => {
    const w = await established()
    live(w, 'L1')
    w.clock.now = T0 + N + 30 * MIN
    await post(w, { kind: 'block' })
    await tickAt(w, w.clock.now + MIN)
    expect(w.read('p1').custody).toBeUndefined()
  })
  for (const [name, o] of [
    ['a plain comment (no thread, no kind)', { threadId: undefined, kind: undefined }],
    ['a thread NOTE (kind absent)', { kind: undefined }],
    ['a handback record', { kind: 'handback' }],
    ['an unverified poster (no role)', { role: undefined, sessionId: undefined }],
    ['a decision by a worker session', { sessionId: 'W1', author: 'W1' }],
    ['a decision on ANOTHER task', { taskId: 't-p2', subtaskId: 'p2' }],
    ['a decision on a sibling piece of the same task', { subtaskId: 'p9' }],
  ] as const) {
    test(`control: ${name} does not renew absence — custody stays with L2`, async () => {
      const w = await established()
      live(w, 'L1'); w.fleet.rows = [...w.fleet.rows!, row('W1', 't-p1', true, 'worker')]
      w.clock.now = T0 + N + 30 * MIN
      await post(w, o as Record<string, unknown>)
      await tickAt(w, w.clock.now + MIN)
      expect(w.read('p1').custody).toMatchObject({ sessionId: 'L2' })
      expect(w.read('p1').leaderAbsentSince).toBe(iso(T0))
    })
  }
})

describe('F5 — the project of a piece: Task.repo → the piece\'s sessions → the sidebar folder → unknown', () => {
  const groupsWith = (spec: Array<{ name: string; parent?: string; keys: string[] }>): SessionUserGroupsValue => {
    let v: SessionUserGroupsValue = { groups: [] }
    const ids = new Map<string, string>()
    for (const g of spec) { const c = planCreateGroup(v, g.name); v = c.next; ids.set(g.name, c.id!) }
    for (const g of spec) {
      if (g.parent) { const n = planNestGroup(v, ids.get(g.name)!, ids.get(g.parent)!); if (n.ok) v = n.next }
      for (const k of g.keys) v = planAddToGroup(v, ids.get(g.name)!, k)
    }
    return v
  }
  const fixture = async () => {
    const tasks = createTaskStore(join(root, 'tasks.json'))
    const t = (id: string, repo?: string) => tasks.upsertTask({ id, title: id, status: 'in_progress', createdAt: iso(T0), updatedAt: iso(T0), ...(repo ? { repo } : {}) } as never, unattributedContext())
    await t('t-r', 'git@github.com:acme/app.git'); await t('t-s'); await t('t-f'); await t('t-g'); await t('t-m')
    const reg = createSessionRegistry(join(root, 'managed-sessions.json'))
    const add = (o: Record<string, unknown>) => reg.add({ harness: 'claude', cwd: '/nowhere', createdAt: iso(T0), ...o } as never)
    await add({ id: 's-leader', taskId: 't-f', conversationId: 'conv-leader', leader: true, role: 'leader' })
    await add({ id: 's-w1', taskId: 't-s', subtaskId: 'ps', repo: { repo: 'acme/web', worktree: false } })
    await add({ id: 's-f1', taskId: 't-f', subtaskId: 'pf', conversationId: 'conv-f1' })
    await add({ id: 's-g1', taskId: 't-g', subtaskId: 'pg', conversationId: 'conv-g1' })
    await add({ id: 's-m1', taskId: 't-m', subtaskId: 'pm', conversationId: 'conv-m1' })
    await add({ id: 's-m2', taskId: 't-m', subtaskId: 'pm', conversationId: 'conv-m2' })
    const book = await tasks.read()
    const groups = groupsWith([
      { name: 'Acme Engine', keys: ['conv-g1'] }, { name: 'Active', parent: 'Acme Engine', keys: ['conv-f1', 'conv-leader'] },
      { name: 'Other Folder', keys: ['conv-m1'] }, { name: 'Third', keys: ['conv-m2'] },
    ])
    return { book, sessions: (await reg.read()).map(r => ({ id: r.id, conversationId: r.conversationId, taskId: r.taskId, subtaskId: r.subtaskId, repo: r.repo?.repo })), groups }
  }
  test('Task.repo wins, then the repo of the piece\'s sessions, then the folder (a nested folder names its PARENT), else unknown', async () => {
    const f = await fixture()
    const out = resolveCustodyProjects({
      pieces: [{ taskId: 't-r', subtaskId: 'pr' }, { taskId: 't-s', subtaskId: 'ps' }, { taskId: 't-f', subtaskId: 'pf' }, { taskId: 't-g', subtaskId: 'pg' }, { taskId: 't-m', subtaskId: 'pm' }, { taskId: 't-x', subtaskId: 'px' }],
      taskRepos: new Map(f.book.tasks.map(t => [t.id, (t as { repo?: string }).repo ?? ''] as const)), sessions: f.sessions, groups: f.groups,
    })
    expect(out.get('pr')).toBe('acme/app')
    expect(out.get('ps')).toBe('acme/web')
    expect(out.get('pf')).toBe('folder:acme engine') // nested "Active" under "Acme Engine"
    expect(out.get('pg')).toBe('folder:acme engine') // top-level folder, same project as pf
    expect(out.get('pm')).toBe('') // two different folders: a conflict is not a vote
    expect(out.get('px')).toBe('') // no sessions at all
  })
  test('end to end: an orphan piece known ONLY through its folder goes to the live leader of the SAME folder, never to another', async () => {
    const f = await fixture()
    const w = await world({ c: 'on' })
    const projects = (pieces: ReadonlyArray<{ taskId: string; subtaskId: string }>) => resolveCustodyProjects({
      pieces, taskRepos: new Map(f.book.tasks.map(t => [t.id, (t as { repo?: string }).repo ?? ''] as const)), sessions: f.sessions, groups: f.groups,
    })
    seed(w, 'pf', { taskId: 't-f', leaderSessionId: 'L1', leaderActivityBy: 'L1', leaderActivityAt: iso(T0) })
    seed(w, 'pg', { taskId: 't-g', leaderSessionId: 'L2', leaderActivityBy: 'L2', leaderActivityAt: iso(T0 + N) })
    seed(w, 'pm', { taskId: 't-m', leaderSessionId: 'L3', leaderActivityBy: 'L3', leaderActivityAt: iso(T0 + N) })
    w.fleet.rows = [row('L1', 't-f', false), row('L2', 't-g'), row('L3', 't-m')]
    w.clock.now = T0 + N + 10 * MIN
    await custodyTick(deps(w, { projectsOf: async (p: never) => projects(p) }) as never, [])
    expect(w.read('pf').custody).toMatchObject({ sessionId: 'L2', project: 'folder:acme engine' })
    expect(custodyMsgs(w, 'L3')).toHaveLength(0)
    expect(custodyMsgs(w, 'L2')).toHaveLength(1)
  })
  test('the piece\'s own LEADER session counts as one of "the piece\'s sessions" (no non-leader filter)', () => {
    const out = resolveCustodyProjects({
      pieces: [{ taskId: 't-1', subtaskId: 'p1' }], taskRepos: new Map(),
      sessions: [{ id: 'lead', taskId: 't-1', subtaskId: 'p1', repo: 'acme/app' }], groups: { groups: [] },
    })
    expect(out.get('p1')).toBe('acme/app')
  })
})

describe('G — the keep-alive cheats still fail through their real source (after the positive)', () => {
  test('(a) plain board comments on the same piece every hour (real TaskStore) never reset absence', async () => {
    const w = await established()
    seed(w, 'p3', { taskId: 't-p3', leaderSessionId: 'Z', leaderActivityBy: 'Z', leaderActivityAt: iso(T0 + 2 * H) })
    w.fleet.rows = [...w.fleet.rows!, row('Z', 't-p3')]
    for (let h = 3; h < 9; h++) await w.tasks.addComment({ id: `plain-${h}`, taskId: 't-p3', subtaskId: 'p3', author: 'Z', body: 'still here', createdAt: iso(T0 + h * H), role: 'session', sessionId: 'Z' } as never)
    await upTo(w, T0 + N + 15 * MIN, T0 + 2 * H + N - 5 * MIN)
    await upTo(w, T0 + 2 * H + N, T0 + 2 * H + N + 10 * MIN)
    expect(w.read('p3').custody).toMatchObject({ sessionId: 'L2' })
    expect(w.read('p3').leaderAbsentSince).toBe(iso(T0 + 2 * H))
  })
  test('(b/c) a leader row whose heartbeat and transcript are fresh but did no piece action is still an orphan', async () => {
    const w = await established()
    seed(w, 'p3', { taskId: 't-p3', leaderSessionId: 'Z', leaderActivityBy: 'Z', leaderActivityAt: iso(T0 + 2 * H) })
    w.fleet.rows = [...w.fleet.rows!, { ...row('Z', 't-p3'), lastSeenMs: T0 + 9 * H, lastTranscriptAt: iso(T0 + 9 * H), status: 'working' } as never]
    await upTo(w, T0 + 2 * H + N, T0 + 2 * H + N + 10 * MIN)
    expect(w.read('p3').custody).toMatchObject({ sessionId: 'L2' })
  })
})

mkdirSync(tmpdir(), { recursive: true })
