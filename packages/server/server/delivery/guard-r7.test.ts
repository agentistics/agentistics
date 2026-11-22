/**
 * r7 regressions derived from Claude Opus r6 A1/B1/B2, plus floor, tick isolation, ceiling and cache controls.
 * The adoption fixture implements the board's real setPhaseStatus reply; every attack asserts the required safe result.
 */
import { expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGuaranteesStore, guaranteeWarnings, type ActivationFacts } from './activation'
import { createDeliveryStore } from './store'
import { createGuardsStore } from './guards-store'
import { createDeliveryService } from './service'
import { execGit } from './classify-host'
import { forbiddenCapabilities } from './guard-ast.testing'
import { newDelivery } from './machine'
import { GuardRefused, flowContext } from './guard'
import { deliveryRequest } from './web'

const T = Date.parse('2026-11-13T10:00:00Z')
const check = async () => ({ ok: true as const, via: 'legacy-browser' as const })
const facts = (now = T): ActivationFacts => ({ now: new Date(now).toISOString(), build: 'qa', capabilities: ['S0', 'S1', 'S2', 'S3'], migrated: ['a'], unexplainedWouldRefuse: 0 })
const flow = flowContext()

function adoptWorld(root: string, clock: { now: number }, extra: Record<string, unknown> = {}) {
  const board = { blocked: [] as Array<{ id: string; taskId: string; title: string; blockedBy: string[]; groupMember: boolean; since: string; reason?: string }>, status: new Map<string, string>() }
  const sessions = [{ id: 'leader', role: 'leader', taskId: 't1', alive: true, cwd: '/nowhere', harness: 'claude', worktree: false }]
  const comments: string[] = [], late: string[] = []
  const store = createDeliveryStore(join(root, 'deliveries.json'), { guard: { deps: { sessions: async () => sessions, git: execGit }, now: () => clock.now } })
  const svc = createDeliveryService({
    store,
    facts: {
      subtask: async (id: string) => ({ id, taskId: 't1', title: id, status: board.status.get(id) ?? 'in_progress', groupMember: false, blockedBy: [] }),
      sessions: async () => sessions,
      blockedSubtasks: async () => board.blocked,
    } as never,
    board: { comment: async (_task: string, id: string, text: string) => { comments.push(`${id}: ${text}`) }, subtaskFinished: async () => false, setPhaseStatus: async () => ({ ok: true }) } as never,
    notify: { session: async () => true, owner: async () => undefined } as never,
    autonomous: async () => true, emit: async () => undefined, now: () => clock.now,
    classify: { sessions: async () => sessions, git: execGit },
    guardsPath: join(root, 'guards.json'),
    autoReconcile: () => { late.push('auto-reconcile'); return false },
    ...extra,
  } as never) as any
  return { svc, board, store, comments, late }
}

async function run(state: 'off' | 'on') {
  const root = mkdtempSync(join(tmpdir(), 'qa-r6-adopt-'))
  try {
    const g = createGuaranteesStore(join(root, 'guarantees.json'))
    if (state === 'on') {
      expect(await g.setState('a', 'shadow', { check, facts: facts(T - 25 * 3600_000) })).toEqual({ ok: true })
      expect(await g.setState('a', 'on', { check, facts: facts() })).toEqual({ ok: true })
    }
    const clock = { now: T }
    const { svc, board } = adoptWorld(root, clock)
    const disk = () => JSON.parse(readFileSync(join(root, 'deliveries.json'), 'utf8')).deliveries
    const tick = async () => { try { return (await svc.tick()).actions.join(' | ') } catch (e: any) { return `THREW ${e.code ?? e.message}` } }
    const out: Record<string, unknown> = {}
    // 1. the board blocks s-a: the vigia adopts it
    board.blocked = [{ id: 's-a', taskId: 't1', title: 'a', blockedBy: [], groupMember: false, since: new Date(T - 3600_000).toISOString(), reason: 'waiting' }]
    out.tick1 = await tick(); out.adopted1 = disk()['s-a']?.phase ?? null
    // 2. the person unblocks it on the board: the pure adoption is DELETED
    clock.now += 60_000; board.blocked = []; board.status.set('s-a', 'in_progress')
    out.tick2 = await tick(); out.afterRelease = disk()['s-a']?.phase ?? null
    // 3. the person blocks it again (and blocks s-b for the first time): the vigia should adopt both again
    clock.now += 60_000
    board.blocked = [
      { id: 's-a', taskId: 't1', title: 'a', blockedBy: [], groupMember: false, since: new Date(clock.now - 1000).toISOString(), reason: 'again' },
      { id: 's-b', taskId: 't1', title: 'b', blockedBy: [], groupMember: false, since: new Date(clock.now - 500).toISOString(), reason: 'new' },
    ]
    out.tick3 = await tick(); out.readoptA = disk()['s-a']?.phase ?? null; out.adoptB = disk()['s-b']?.phase ?? null
    clock.now += 60_000
    out.tick4 = await tick(); out.adoptB4 = disk()['s-b']?.phase ?? null
    console.log(`ADOPT[${state}]`, JSON.stringify(out))
    return out
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('A1 control (rule OFF): release then re-block re-adopts', async () => {
  const o = await run('off')
  expect(o.readoptA).toBe('bloqueado')
  expect(o.adoptB).toBe('bloqueado')
})

test('A1 ATTACK (rule ON): tombstone floor refuses the re-adoption and stalls the vigia', async () => {
  const o = await run('on')
  expect(o.afterRelease).toBeNull()
  // REQUIRED: same as OFF — a released pure adoption can be re-adopted, and an unrelated piece is never held hostage.
  expect(o.readoptA).toBe('bloqueado')
  expect(o.adoptB).toBe('bloqueado')
})

test('A2 ATTACK: an adoption cycle during the SHADOW week arms the same stall for the day rule A goes ON', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-r6-adopt-shadow-'))
  try {
    const g = createGuaranteesStore(join(root, 'guarantees.json'))
    expect(await g.setState('a', 'shadow', { check, facts: facts(T) })).toEqual({ ok: true })
    const clock = { now: T + 60_000 }
    const { svc, board } = adoptWorld(root, clock)
    const disk = () => JSON.parse(readFileSync(join(root, 'deliveries.json'), 'utf8')).deliveries
    const tick = async () => { try { return (await svc.tick()).actions.join(' | ') } catch (e: any) { return `THREW ${e.code ?? e.message}` } }
    const out: Record<string, unknown> = {}
    board.blocked = [{ id: 's-a', taskId: 't1', title: 'a', blockedBy: [], groupMember: false, since: new Date(T).toISOString(), reason: 'x' }]
    out.s1 = await tick()
    clock.now += 60_000; board.blocked = []; out.s2 = await tick()
    clock.now += 60_000
    board.blocked = [{ id: 's-a', taskId: 't1', title: 'a', blockedBy: [], groupMember: false, since: new Date(clock.now - 1000).toISOString(), reason: 'y' }]
    out.s3 = await tick(); out.shadowRecord = disk()['s-a']?.phase ?? null
    // 25 h later the owner turns rule A on (no production caller feeds unexplainedWouldRefuse)
    clock.now = T + 25 * 3600_000
    out.on = await g.setState('a', 'on', { check, facts: facts(clock.now) })
    out.onTick = await tick()
    out.aAfterOnTick = { phase: disk()['s-a']?.phase, rev: disk()['s-a']?.revision, history: disk()['s-a']?.history?.length }
    board.blocked.push({ id: 's-b', taskId: 't1', title: 'b', blockedBy: [], groupMember: false, since: new Date(clock.now - 1000).toISOString(), reason: 'z' })
    clock.now += 31 * 60_000
    out.onTick2 = await tick(); out.adoptB = disk()['s-b']?.phase ?? null
    console.log('ADOPT[shadow→on]', JSON.stringify(out))
    expect(String(out.onTick)).not.toContain('THREW')
    expect(out.adoptB).toBe('bloqueado')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('B2 after the off → shadow re-seal, on still needs a FRESH shadow period', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-r6-reseal2-'))
  try {
    const g = createGuaranteesStore(join(root, 'guarantees.json'))
    const move = (to: 'off' | 'shadow' | 'on', now: number) => g.setState('a', to, { check, facts: facts(now) })
    expect(await move('shadow', T - 25 * 3600_000)).toEqual({ ok: true })
    expect(await move('on', T)).toEqual({ ok: true })
    expect(await move('off', T + 1000)).toEqual({ ok: true })
    expect(await move('shadow', T + 2000)).toEqual({ ok: true })
    const early = await move('on', T + 3600_000)
    console.log('RESEAL early on', JSON.stringify(early))
    expect(early.ok).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('B1 off → shadow re-seal: audit of dropped floors, and what it does NOT record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-r6-reseal-'))
  try {
    const path = join(root, 'deliveries.json')
    const g = createGuaranteesStore(join(root, 'guarantees.json'))
    const move = (to: 'off' | 'shadow' | 'on', now = T) => g.setState('a', to, { check, facts: facts(now) })
    expect(await move('shadow', T - 25 * 3600_000)).toEqual({ ok: true })
    expect(await move('on')).toEqual({ ok: true })
    const store = createDeliveryStore(path)
    const at = new Date(T).toISOString()
    const rec = (id: string, history: unknown[], revision: number, phase = 'fila') => ({ subtaskId: id, taskId: 't1', phase, revision, gates: {}, humanGates: [], approvals: {}, skips: [], history, createdAt: at, updatedAt: at })
    const h = (n: number) => ({ from: 'fila', to: 'bloqueado', at, actor: 'flow:entrega', detail: `h${n}`, revision: n })
    await store.update(d => { d.deliveries.p1 = rec('p1', [h(2)], 2) as never; d.deliveries.p2 = rec('p2', [h(2)], 2) as never }, { guard: flow })
    await store.update(d => { d.deliveries.p1!.history.push(h(3) as never); d.deliveries.p1!.revision = 3 }, { guard: flow })
    expect(await move('off', T + 1000)).toEqual({ ok: true })
    // OFF: an ordinary process rewrites the ledger: p1 loses its history (rolled back), p2 is forged UP to publicado with
    // history intact (append-only), p3 appears directly at publicado.
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    raw.deliveries.p1 = rec('p1', [h(2)], 2)
    raw.deliveries.p2.phase = 'publicado'
    raw.deliveries.p3 = rec('p3', [], 1, 'publicado')
    writeFileSync(path, JSON.stringify(raw))
    expect(await move('shadow', T + 2000)).toEqual({ ok: true })
    const log = (await g.read()).doc.log!
    const entry = log[log.length - 1]
    expect(guaranteeWarnings((await g.read()).doc).join(' ')).toContain('p2')
    console.log('RESEAL entry', JSON.stringify(entry))
    const floors = (await createGuardsStore(join(root, 'guards.json')).read()).deliveryFloors ?? {}
    console.log('RESEAL floors', JSON.stringify(Object.fromEntries(Object.entries(floors).map(([k, v]) => [k, { revision: v.revision, history: (v.history ?? []).length }]))))
    // 25 h later: on. Does the owner's `on` see anything about the reseal?
    const on = await move('on', T + 26 * 3600_000)
    const warn = (await g.read()).warn ?? null
    console.log('RESEAL on', JSON.stringify({ on, warn }))
    expect(entry?.reconciledFloors?.dropped).toEqual(['p1'])
    expect(entry?.reconciledFloors?.climbed).toEqual(['p2'])
    expect(entry?.reconciledFloors?.createdRanked).toEqual(['p3'])
    expect(guaranteeWarnings((await g.read()).doc)).toEqual([])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('R6-2 X1 shadow and on transitions never re-seal a shortened history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'r7-x1-'))
  try {
    const path = join(root, 'deliveries.json'), store = createDeliveryStore(path)
    const g = createGuaranteesStore(join(root, 'guarantees.json')), guards = createGuardsStore(join(root, 'guards.json'))
    const move = (to: 'off' | 'shadow' | 'on', now: number) => g.setState('a', to, { check, facts: facts(now) })
    await move('shadow', T)
    const r = newDelivery({ subtaskId: 'p1', taskId: 't1', at: new Date(T).toISOString() })
    r.phase = 'ajuste'
    r.history = [{ from: 'executando', to: 'ajuste', at: new Date(T).toISOString(), actor: 'flow:entrega', revision: 2, detail: 'adjustment' }]
    r.revision = 2
    await store.update(d => { d.deliveries.p1 = r }, { guard: flow })
    const floor = (await guards.read()).deliveryFloors
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    raw.deliveries.p1.history = []; raw.deliveries.p1.revision = 1
    writeFileSync(path, JSON.stringify(raw))
    await move('on', T + 25 * 3600_000)
    expect((await guards.read()).deliveryFloors).toEqual(floor)
    await move('shadow', T + 26 * 3600_000)
    expect((await guards.read()).deliveryFloors).toEqual(floor)
    await move('on', T + 51 * 3600_000)
    expect((await guards.read()).deliveryFloors).toEqual(floor)
    let code = ''
    try { await store.update(d => { d.deliveries.p1!.phase = 'revisao_lider' }, { guard: flow }) }
    catch (e: any) { code = e.code }
    expect(code).toBe('evidence_binding_protected')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('R6-3 Function references, global eval and function literal constructors are forbidden', () => {
  const forms = ['const F = Function', 'Reflect.construct(Function, args)', 'Reflect.apply(Function, null, args)', 'Function.call(null, code)', 'new (Function.bind(null, code))()']
  for (const receiver of ['global', 'globalThis', 'self', 'Bun']) for (const wrapped of [receiver, `((${receiver} as any)!)`]) {
    for (const key of ['eval', 'Function']) forms.push(`${wrapped}['${key}']`, `${wrapped}.${key}`)
  }
  for (const fn of ['function(){}', 'async function(){}', 'function*(){}', 'async function*(){}', '()=>0', 'async ()=>0']) {
    forms.push(`(${fn}).constructor`, `(${fn})['constructor']`, `Object.getPrototypeOf((${fn})).constructor`, `(Object.getPrototypeOf((${fn})) as any)!['constructor']`)
  }
  for (const src of forms) expect(forbiddenCapabilities(src), src).not.toEqual([])
  expect(forbiddenCapabilities('const x = "Function"; // eval\nconst f = () => 0; f()')).toEqual([])
})

test('R6-5 OFF writes with no journal parse no guards after warmup and observe a new journal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'r7-offwrite-'))
  try {
    const path = join(root, 'deliveries.json'), store = createDeliveryStore(path)
    const g = createGuaranteesStore(join(root, 'guarantees.json')), guards = createGuardsStore(join(root, 'guards.json'))
    await g.setState('a', 'off', { check, facts: facts() })
    await store.update(() => undefined)
    const original = fs.readFile, reads: string[] = []
    const spy = spyOn(fs, 'readFile').mockImplementation(((path: any, ...args: any[]) => { reads.push(String(path)); return (original as any)(path, ...args) }) as typeof fs.readFile)
    try {
      for (let i = 0; i < 5; i++) await store.update(() => undefined)
      expect(reads).toContain(path)
      // Policy authentication already probes the sibling seal once per write; the journal adds no reads/parses.
      expect(reads.filter(p => p === join(root, 'guards.json'))).toEqual(Array(5).fill(join(root, 'guards.json')))
      const r = newDelivery({ subtaskId: 'p1', taskId: 't1', at: new Date(T).toISOString() })
      await guards.write({ ...await guards.read(), pendingDelivery: JSON.stringify({ version: 1, deliveries: { p1: r } }) })
      await store.update(d => { expect(d.deliveries.p1).toBeDefined() })
      expect((await guards.read()).pendingDelivery).toBeUndefined()
    } finally { spy.mockRestore() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('R6-1 tick HTTP refusal is structured and contains no source/stack', async () => {
  const error = new GuardRefused({ code: 'evidence_binding_protected', piece: 'p1', message: 'write refused', messagePt: 'recusada', missing: [] })
  const reply = await deliveryRequest('POST', '/api/deliveries/tick', {}, { verify: async () => null, service: { tick: async () => { throw error } } as never })
  expect(reply).toEqual({ status: 422, body: { ok: false, error: error.code, sentence: error.message, sentencePt: error.messagePt, missing: [] } })
})

for (const protection of ['evidence', 'evidenceHistory', 'rankedHistory'] as const) test(`R6-1 ${protection} floor survives release and isolates a refused piece from adoption and later tick steps`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'r7-floor-'))
  try {
    const { svc, board, store, comments, late } = adoptWorld(root, { now: T })
    const g = createGuaranteesStore(join(root, 'guarantees.json')), guards = createGuardsStore(join(root, 'guards.json'))
    await g.setState('a', 'shadow', { check, facts: facts(T - 25 * 3600_000) })
    await g.setState('a', 'on', { check, facts: facts() })
    const r = newDelivery({ subtaskId: 's-a', taskId: 't1', at: new Date(T).toISOString() })
    r.adopted = 'board'
    if (protection === 'evidence') r.evidence = [{ id: 'proof', sha256: 'a'.repeat(64), revision: 1 }] as never
    if (protection === 'evidenceHistory') r.evidenceHistory = [{ evidenceId: 'proof', revision: 1 }] as never
    if (protection === 'rankedHistory') r.history = [{ from: 'executando', to: 'revisao_lider', at: new Date(T).toISOString(), revision: 1, actor: 'flow:entrega', detail: 'review' }]
    await store.update(d => { d.deliveries['s-a'] = r }, { guard: flow })
    const floor = (await guards.read()).deliveryFloors!['s-a']
    expect(floor).toBeDefined()
    await store.update(d => { delete d.deliveries['s-a'] }, { guard: flow })
    expect((await guards.read()).deliveryFloors!['s-a']).toEqual(floor)
    board.blocked = ['s-a', 's-b'].map((id, i) => ({ id, taskId: 't1', title: id, blockedBy: [], groupMember: false, since: new Date(T - 1000 + i).toISOString() }))
    const actions = (await svc.tick()).actions as string[]
    expect((await store.get('s-b'))?.phase).toBe('bloqueado')
    expect(late).toEqual(['auto-reconcile'])
    // Evidence removal with an attributed context remains allowed, but reusing the record cannot erase its floor.
    if (protection === 'evidence') {
      await expect(store.update(d => { d.deliveries['s-a']!.evidence = [{ id: 'proof', sha256: 'b'.repeat(64), revision: 1 }] as never }, { guard: flow })).rejects.toMatchObject({ code: 'evidence_binding_protected' })
    } else {
      expect(await store.get('s-a')).toBeNull()
      expect(actions.join(' ')).toContain('guard-refused s-a: evidence_binding_protected')
      expect(comments.join(' ')).toContain('guard-refused s-a: evidence_binding_protected')
    }
    expect((await guards.read()).deliveryFloors!['s-a']!.evidence).toEqual(floor!.evidence)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('R6-1 per-piece tick refusal writes a delivery tickNote and continues after leader reassignment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'r7-tick-note-'))
  try {
    const { svc, board, store, late } = adoptWorld(root, { now: T })
    const g = createGuaranteesStore(join(root, 'guarantees.json'))
    await g.setState('a', 'shadow', { check, facts: facts(T - 25 * 3600_000) })
    await g.setState('a', 'on', { check, facts: facts() })
    board.blocked = ['s-a', 's-b'].map(id => ({ id, taskId: 't1', title: id, blockedBy: [], groupMember: false, since: new Date(T - 1000).toISOString() }))
    await svc.tick()
    await store.update(d => { for (const r of Object.values(d.deliveries)) delete r.leaderSessionId }, { guard: flow })
    const original = store.update
    store.update = (fn, options) => original(async doc => {
      const value = await fn(doc)
      if (doc.deliveries['s-a']?.leaderSessionId) throw new GuardRefused({ code: 'test_piece_refusal', piece: 's-a', message: 'refused piece', messagePt: 'recusada', missing: [] })
      return value
    }, options)
    late.length = 0
    const out = await svc.tick()
    expect(out.actions.join(' ')).toContain('guard-refused s-a: test_piece_refusal')
    expect((await store.get('s-a'))!.tickNote?.reason).toContain('s-a: test_piece_refusal')
    expect((await store.get('s-b'))!.leaderSessionId).toBe('leader')
    expect(late).toEqual(['auto-reconcile'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('R6-1 a refused wake stamp cannot suppress a sibling or the final tick step', async () => {
  const root = mkdtempSync(join(tmpdir(), 'r7-wake-'))
  try {
    const { svc, board, store, late } = adoptWorld(root, { now: T })
    const g = createGuaranteesStore(join(root, 'guarantees.json'))
    await g.setState('a', 'shadow', { check, facts: facts(T - 25 * 3600_000) })
    await g.setState('a', 'on', { check, facts: facts() })
    board.blocked = ['s-a', 's-b'].map(id => ({ id, taskId: 't1', title: id, blockedBy: [], groupMember: false, since: new Date(T - 1000).toISOString() }))
    await svc.tick()
    await store.update(d => { for (const r of Object.values(d.deliveries)) { delete r.block!.lastWakeAt; delete r.block!.lastWakeAttemptAt } }, { guard: flow })
    const original = store.update
    store.update = (fn, options) => original(async doc => {
      const value = await fn(doc)
      if (doc.deliveries['s-a']?.block?.lastWakeAt) throw new GuardRefused({ code: 'wake_refused', piece: 's-a', message: 'wake stamp refused', messagePt: 'recusada', missing: [] })
      return value
    }, options)
    late.length = 0
    const out = await svc.tick()
    expect(out.actions.join(' ')).toContain('guard-refused s-a: wake_refused')
    expect((await store.get('s-a'))!.tickNote?.reason).toContain('s-a: wake_refused')
    expect((await store.get('s-b'))!.block!.lastWakeAt).toBe(new Date(T).toISOString())
    expect(late).toEqual(['auto-reconcile'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('R6-1 queue reminder refusal is isolated per piece and later tick steps run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'r7-queue-note-'))
  try {
    const { svc, store, late } = adoptWorld(root, { now: T }, { spawn: async () => ({ ok: true, sessionId: 'author' }), autonomous: async () => false })
    const g = createGuaranteesStore(join(root, 'guarantees.json'))
    await g.setState('a', 'shadow', { check, facts: facts(T - 25 * 3600_000) })
    await g.setState('a', 'on', { check, facts: facts() })
    await store.update(d => {
      for (const id of ['s-a', 's-b']) {
        const r = newDelivery({ subtaskId: id, taskId: 't1', at: new Date(T).toISOString() })
        r.leaderSessionId = 'leader'
        r.queueAsk = { at: new Date(T - 11 * 60_000).toISOString(), delivered: true, leaderSessionId: 'leader' }
        d.deliveries[id] = r
      }
    }, { guard: flow })
    const original = store.update
    store.update = (fn, options) => original(async doc => {
      const value = await fn(doc)
      if (doc.deliveries['s-a']?.queueAsk?.remindedAt) throw new GuardRefused({ code: 'queue_refused', piece: 's-a', message: 'queue reminder refused', messagePt: 'recusada', missing: [] })
      return value
    }, options)
    const out = await svc.tick()
    expect(out.actions.join(' ')).toContain('guard-refused s-a: queue_refused')
    expect((await store.get('s-a'))!.tickNote?.reason).toContain('s-a: queue_refused')
    expect((await store.get('s-b'))!.queueAsk!.remindedAt).toBe(new Date(T).toISOString())
    expect(late).toEqual(['auto-reconcile'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
