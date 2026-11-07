import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeliveryService } from './service'
import { createDeliveryStore } from './store'
import type { GateFacts, SessionFact, SubtaskFact } from './gates'
import { ASK_TIMEOUT_MS, holdState, orderQueue, parseQueueAnswer, planQueue, QUEUE_HEADER, reminderDue, startClaimLive, type QueueItem } from './fila-proximo'
import { kickQueueNext } from './queue-kick'

const NOW = Date.parse('2026-11-07T18:00:00Z')

describe('fila-proximo — pure', () => {
  const item = (o: Partial<QueueItem> & { subtaskId: string }): QueueItem => ({ taskId: 't1', title: o.subtaskId, priority: 'low', since: '2026-11-07T10:00:00Z', ...o })

  test('the queue leaves by priority, then arrival, then id — and a changed priority reorders the exit', () => {
    const items = [
      item({ subtaskId: 'c', priority: 'low', since: '2026-11-07T09:00:00Z' }),
      item({ subtaskId: 'b', priority: 'urgent', since: '2026-11-07T11:00:00Z' }),
      item({ subtaskId: 'a', priority: 'urgent', since: '2026-11-07T11:00:00Z' }),
      item({ subtaskId: 'd', priority: 'high', since: '2026-11-07T08:00:00Z' }),
    ]
    expect(orderQueue(items).map(i => i.subtaskId)).toEqual(['a', 'b', 'd', 'c'])
    // Raising the low one to urgent puts it in front of the later urgent ones: arrival breaks the tie.
    expect(orderQueue(items.map(i => (i.subtaskId === 'c' ? { ...i, priority: 'urgent' } : i))).map(i => i.subtaskId)).toEqual(['c', 'a', 'b', 'd'])
    expect(orderQueue([item({ subtaskId: 'x', priority: 'none' }), item({ subtaskId: 'y', priority: 'medium' })]).map(i => i.subtaskId)).toEqual(['y', 'x'])
  })

  test('the four answers parse; a `nao` or `agendar` without its reason, or an agendar in the past, is refused in a sentence', () => {
    expect(parseQueueAnswer('sim', NOW)).toEqual({ ok: true, answer: { kind: 'sim' } })
    expect(parseQueueAnswer('  Sim ', NOW)).toEqual({ ok: true, answer: { kind: 'sim' } })
    expect(parseQueueAnswer('não porque o build está vermelho', NOW)).toEqual({ ok: true, answer: { kind: 'nao', reason: 'porque o build está vermelho' } })
    expect(parseQueueAnswer('nao depois do release', NOW)).toEqual({ ok: true, answer: { kind: 'nao', reason: 'depois do release' } })
    expect(parseQueueAnswer('agendar 2026-11-08T14:00:00Z depois do almoço', NOW)).toEqual({ ok: true, answer: { kind: 'agendar', until: '2026-11-08T14:00:00.000Z', reason: 'depois do almoço' } })
    expect(parseQueueAnswer({ decision: 'agendar', at: '2026-11-08T14:00:00Z', reason: 'r' }, NOW)).toEqual({ ok: true, answer: { kind: 'agendar', until: '2026-11-08T14:00:00.000Z', reason: 'r' } })
    expect(parseQueueAnswer({ decision: 'nao', reason: 'x' }, NOW)).toEqual({ ok: true, answer: { kind: 'nao', reason: 'x' } })
    for (const bad of ['nao', 'agendar', 'agendar amanhã porque sim', 'agendar 2026-11-07T10:00:00Z já passou', 'agendar 2026-11-08T14:00:00Z', 'talvez', '', { decision: 'nao' }, 7]) {
      const out = parseQueueAnswer(bad, NOW)
      expect(out.ok).toBe(false)
    }
  })

  test('holds: `nao` keeps the piece out until changed; `agendar` only until its instant', () => {
    expect(holdState(undefined, NOW)).toBeNull()
    expect(holdState({ kind: 'nao', reason: 'r', at: 'x', actor: 'l' }, NOW)).toBe('nao')
    expect(holdState({ kind: 'agendar', reason: 'r', at: 'x', actor: 'l', until: new Date(NOW + 1000).toISOString() }, NOW)).toBe('agendado')
    expect(holdState({ kind: 'agendar', reason: 'r', at: 'x', actor: 'l', until: new Date(NOW - 1000).toISOString() }, NOW)).toBeNull()
    expect(holdState({ kind: 'agendar', reason: 'r', at: 'x', actor: 'l', until: 'garbage' }, NOW)).toBeNull()
  })

  test('a plan: held pieces and a task with an open question are not candidates; 10 min without an answer expires it', () => {
    const iso = (ms: number) => new Date(ms).toISOString()
    const plan = planQueue([
      item({ subtaskId: 'a', taskId: 't1', priority: 'urgent', ask: { at: iso(NOW - ASK_TIMEOUT_MS - 1), delivered: true } }),
      item({ subtaskId: 'b', taskId: 't1', priority: 'high' }),
      item({ subtaskId: 'c', taskId: 't2', priority: 'low', hold: { kind: 'nao', reason: 'r', at: 'x', actor: 'l' } }),
      item({ subtaskId: 'd', taskId: 't3', priority: 'low', hold: { kind: 'agendar', reason: 'r', at: 'x', actor: 'l', until: iso(NOW + 60_000) } }),
      item({ subtaskId: 'e', taskId: 't4', priority: 'low' }),
    ], NOW)
    expect(plan.candidates.map(i => i.subtaskId)).toEqual(['e'])
    expect(plan.expired.map(i => i.subtaskId)).toEqual(['a'])
    expect(planQueue([item({ subtaskId: 'a', ask: { at: iso(NOW - 1000), delivered: false } })], NOW).undelivered.map(i => i.subtaskId)).toEqual(['a'])
  })

  test('reminders wait a full 10 min after the last one; a start claim expires', () => {
    const at = new Date(NOW - 11 * 60_000).toISOString()
    expect(reminderDue({ at, delivered: true }, NOW)).toBe(true)
    expect(reminderDue({ at, delivered: true, remindedAt: new Date(NOW - 60_000).toISOString() }, NOW)).toBe(false)
    expect(reminderDue({ at: new Date(NOW - 60_000).toISOString(), delivered: true }, NOW)).toBe(false)
    expect(reminderDue({ at, delivered: true, approved: { at, actor: 'l', auto: false } }, NOW)).toBe(false)
    expect(startClaimLive({ at, delivered: true, startingAt: new Date(NOW - 1000).toISOString() }, NOW)).toBe(true)
    expect(startClaimLive({ at, delivered: true, startingAt: new Date(NOW - 10 * 60_000).toISOString() }, NOW)).toBe(false)
    expect(startClaimLive(undefined, NOW)).toBe(false)
  })
})

describe('fila-proximo — the flow', () => {
  let dir: string
  let seq = 0
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fila-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  interface World { autonomous: boolean; workers: number; priorities: Record<string, string>; leaderAlive: boolean; spawnOk: boolean; memory: number }

  function setup(over: Partial<World> = {}) {
    const w: World = { autonomous: true, workers: 0, priorities: { a: 'low', b: 'medium', c: 'urgent' }, leaderAlive: true, spawnOk: true, memory: 8 * 1024 ** 3, ...over }
    const calls = { told: [] as Array<{ id: string; text: string; header?: string }>, spawned: [] as string[], comments: [] as Array<{ sub: string; body: string }>, emits: [] as string[], status: [] as string[] }
    const taskOf: Record<string, string> = { a: 't1', b: 't1', c: 't1', x: 't2', y: 't2' }
    const sessions = (): SessionFact[] => [
      ...(w.leaderAlive ? [{ id: 'lead1', harness: 'claude', role: 'leader', alive: true, cwd: '/r', worktree: false, taskId: 't1' } satisfies SessionFact] : []),
      { id: 'lead2', harness: 'claude', role: 'leader', alive: true, cwd: '/r', worktree: false, taskId: 't2' },
      ...Array.from({ length: w.workers }, (_, i): SessionFact => ({ id: `w${i}`, harness: 'codex', model: 'gpt-6.1-sol', role: 'worker', alive: true, cwd: '/r', worktree: false })),
    ]
    const sub = (id: string): SubtaskFact | null => !taskOf[id] ? null : {
      id, taskId: taskOf[id]!, title: `Peça ${id}`, status: 'todo', groupMember: false, blockedBy: [], priority: w.priorities[id] ?? 'low',
      staged: { prompt: `brief ${id}`, harness: 'claude', model: 'claude-sonnet-5-5', effort: 'high', account: 'acc_1', cwd: '/r' },
    }
    const facts: GateFacts = {
      subtask: async id => sub(id), sessions: async () => sessions(),
      budgets: async () => [{ harness: 'claude', account: 'acc_1', fiveHourPct: 10, weekPct: 10, stale: false }],
      memoryBytes: async () => w.memory, topCap: async () => 9,
      git: async () => '', gh: async () => '{}',
    }
    let now = NOW
    const svc = createDeliveryService({
      store: createDeliveryStore(join(dir, `d${++seq}.json`)), facts,
      board: {
        setPhaseStatus: async (id, phase) => { calls.status.push(`${id}:${phase}`); return { ok: true } },
        setCi: async () => undefined, logStep: async () => undefined,
        comment: async (_t, s, body) => { calls.comments.push({ sub: s, body }) },
        subtaskFinished: async () => false, stage: async () => ({ ok: true }),
      },
      notify: { session: async (id, text, header) => { calls.told.push({ id, text, ...(header ? { header } : {}) }); return true }, owner: async () => undefined },
      autonomous: async () => w.autonomous,
      emit: async type => { calls.emits.push(type) },
      spawn: async r => { if (!w.spawnOk) return { ok: false as const, message: 'spawn refused' }; calls.spawned.push(r.subtaskId); w.workers++; return { ok: true as const, sessionId: `new-${r.subtaskId}` } },
      accountName: async () => 'Vini',
      now: () => now,
    })
    const queue = async (ids: string[]) => { for (const id of ids) { await svc.ensure(id, { leaderSessionId: taskOf[id] === 't2' ? 'lead2' : 'lead1' }) } }
    return { svc, w, calls, queue, advance: (ms: number) => { now += ms }, asks: () => calls.told.filter(t => t.text.includes(`[${QUEUE_HEADER}]`)) }
  }

  test('with three queued pieces of different priority and one free slot, the highest asks the leader — with the header, the item, the agent and the answers', async () => {
    const t = setup({ workers: 3 })
    await t.queue(['a', 'b', 'c'])
    const out = await t.svc.queueNext()
    expect(out.actions.some(a => a.startsWith('fila-pergunta c'))).toBe(true)
    expect(t.asks()).toHaveLength(1)
    const q = t.asks()[0]!
    expect(q.id).toBe('lead1')
    expect(q.header).toBe(QUEUE_HEADER)
    expect(q.text.startsWith(`[${QUEUE_HEADER}]`)).toBe(true)
    expect(q.text).toContain('Peça c')
    expect(q.text).toContain('urgente')
    expect(q.text).toContain('claude · claude-sonnet-5-5 · high · conta Vini')
    expect(q.text).toContain('sim')
    expect(q.text).toContain('nao <motivo>')
    expect(q.text).toContain('agendar <ISO> <motivo>')
    expect(q.text).not.toContain('acc_1')
    expect(t.calls.spawned).toEqual([])
    // ONE open question per task: asking again changes nothing.
    await t.svc.queueNext(); await t.svc.queueNext()
    expect(t.asks()).toHaveLength(1)
    const rec = await t.svc.get('c')
    expect(rec?.queueAsk?.delivered).toBe(true)
    expect(t.calls.comments.some(c => c.sub === 'c' && c.body.includes('pergunta ao líder'))).toBe(true)
  })

  test('sim opens the session, the card moves, the leader is told it started — and a second sim opens nothing', async () => {
    const t = setup()
    await t.queue(['c'])
    await t.svc.queueNext()
    const first = await t.svc.answerQueue('c', 'sim', 'lead1')
    expect(first.ok).toBe(true)
    expect(t.calls.spawned).toEqual(['c'])
    const rec = await t.svc.get('c')
    expect(rec?.phase).toBe('executando')
    expect(rec?.authorSessionId).toBe('new-c')
    expect(rec?.queueStarted).toMatchObject({ actor: 'lead1', auto: false, sessionId: 'new-c' })
    expect(rec?.queueAsk).toBeUndefined()
    expect(t.calls.told.some(x => x.id === 'lead1' && x.text.includes('entrou em andamento') && x.text.includes('new-c'))).toBe(true)
    expect(t.calls.comments.some(c => c.sub === 'c' && c.body.includes('decisão: sim') && c.body.includes('lead1'))).toBe(true)
    const again = await t.svc.answerQueue('c', 'sim', 'lead1')
    expect(again.ok).toBe(true)
    expect(t.calls.spawned).toEqual(['c'])
  })

  test('nao leaves the piece queued with the reason, records who/why/when, and the flow moves on to the next piece', async () => {
    const t = setup()
    await t.queue(['a', 'b', 'c'])
    await t.svc.queueNext()
    expect(t.asks()).toHaveLength(1)
    const no = await t.svc.answerQueue('c', 'nao precisa esperar o release sair', 'lead1')
    expect(no.ok).toBe(true)
    const rec = await t.svc.get('c')
    expect(rec?.phase).toBe('fila')
    expect(rec?.queueHold).toMatchObject({ kind: 'nao', reason: 'precisa esperar o release sair', actor: 'lead1' })
    expect(rec?.queueAsk).toBeUndefined()
    const note = t.calls.comments.find(c => c.sub === 'c' && c.body.includes('decisão: não'))
    expect(note?.body).toContain('lead1')
    expect(note?.body).toContain('precisa esperar o release sair')
    // The answer itself kicks the flow: the next piece (medium) is asked, not the held one.
    await t.svc.queueNext()
    const asked = t.asks().map(x => x.text)
    expect(asked).toHaveLength(2)
    expect(asked[1]).toContain('Peça b')
    // Same answer again records nothing twice.
    const before = t.calls.comments.length
    await t.svc.answerQueue('c', 'nao precisa esperar o release sair', 'lead1')
    expect(t.calls.comments.length).toBe(before)
  })

  test('agendar shows the hour and the piece is a candidate again only from that instant', async () => {
    const t = setup()
    await t.queue(['c'])
    await t.svc.queueNext()
    const until = new Date(NOW + 2 * 3600_000).toISOString()
    const r = await t.svc.answerQueue('c', `agendar ${until} depois da reunião`, 'lead1')
    expect(r.ok).toBe(true)
    expect((await t.svc.get('c'))?.queueHold).toMatchObject({ kind: 'agendar', until, reason: 'depois da reunião' })
    expect(t.calls.comments.some(c => c.body.includes('decisão: agendar') && c.body.includes(until) && c.body.includes('depois da reunião'))).toBe(true)
    const view = await t.svc.queueView('t1')
    expect(view.items[0]!.hold).toMatchObject({ kind: 'agendar', until, active: true })
    t.advance(3600_000)
    await t.svc.queueNext()
    expect(t.asks()).toHaveLength(1)
    t.advance(3600_000 + 1000)
    await t.svc.queueNext()
    expect(t.asks()).toHaveLength(2)
  })

  test('an agendar in the past, a nao with no reason, or a stranger answering is refused', async () => {
    const t = setup()
    await t.queue(['c'])
    await t.svc.queueNext()
    const past = await t.svc.answerQueue('c', `agendar ${new Date(NOW - 1000).toISOString()} x`, 'lead1')
    expect(past.ok).toBe(false)
    expect((await t.svc.answerQueue('c', 'nao', 'lead1')).ok).toBe(false)
    const stranger = await t.svc.answerQueue('c', 'sim', 'lead2')
    expect(stranger).toMatchObject({ ok: false, status: 403 })
    expect(t.calls.spawned).toEqual([])
    expect((await t.svc.answerQueue('c', 'sim', 'owner')).ok).toBe(true)
    expect(t.calls.spawned).toEqual(['c'])
  })

  test('no answer in 10 min: autonomous mode carries on as sim and records it; with it OFF the flow keeps waiting and reminds', async () => {
    const on = setup({ autonomous: true })
    await on.queue(['c'])
    await on.svc.queueNext()
    on.advance(ASK_TIMEOUT_MS - 1000)
    await on.svc.queueNext()
    expect(on.calls.spawned).toEqual([])
    on.advance(2000)
    await on.svc.queueNext()
    expect(on.calls.spawned).toEqual(['c'])
    expect((await on.svc.get('c'))?.queueStarted).toMatchObject({ auto: true, actor: 'flow:fila' })
    expect(on.calls.comments.some(c => c.sub === 'c' && c.body.includes('sem resposta em 10 min') && c.body.includes('seguiu como sim'))).toBe(true)

    const off = setup({ autonomous: false })
    await off.queue(['c'])
    await off.svc.queueNext()
    off.advance(ASK_TIMEOUT_MS + 1000)
    const out = await off.svc.queueNext()
    expect(off.calls.spawned).toEqual([])
    expect(out.actions.some(a => a.startsWith('fila-lembrete c'))).toBe(true)
    expect(off.calls.told.filter(x => x.text.includes('lembrete'))).toHaveLength(1)
    // One reminder per 10 minutes, not one per tick.
    await off.svc.queueNext()
    expect(off.calls.told.filter(x => x.text.includes('lembrete'))).toHaveLength(1)
    off.advance(ASK_TIMEOUT_MS + 1000)
    await off.svc.queueNext()
    expect(off.calls.told.filter(x => x.text.includes('lembrete'))).toHaveLength(2)
    expect((await off.svc.get('c'))?.phase).toBe('fila')
  })

  test('autonomous with no reachable leader: the question is retried every tick and the 10 min timeout still decides', async () => {
    const t = setup({ autonomous: true, leaderAlive: false })
    await t.queue(['c'])
    await t.svc.queueNext()
    expect((await t.svc.get('c'))?.queueAsk?.delivered).toBe(false)
    expect(t.asks()).toHaveLength(0)
    t.advance(ASK_TIMEOUT_MS + 1000)
    await t.svc.queueNext()
    expect(t.calls.spawned).toEqual(['c'])
  })

  test('a full machine asks nobody; the verdict is stored for the card, and the question comes once a slot frees', async () => {
    const t = setup({ workers: 4 })
    await t.queue(['a', 'c'])
    const out = await t.svc.queueNext()
    expect(out.actions.some(a => a.startsWith('fila-sem-vaga'))).toBe(true)
    expect(t.asks()).toHaveLength(0)
    const rec = await t.svc.get('c')
    expect(rec?.gates.vaga?.ok).toBe(false)
    expect(rec?.gates.vaga?.reason).toContain('4 workers running')
    t.w.workers = 3
    await t.svc.queueNext()
    expect(t.asks()).toHaveLength(1)
    expect(t.asks()[0]!.text).toContain('Peça c')
  })

  test('two questions never promise the same last slot', async () => {
    const t = setup({ workers: 3 })
    await t.queue(['c', 'x'])
    await t.svc.queueNext()
    // One slot: c (t1, urgent) is asked; x (t2) would need a second one.
    expect(t.asks().map(a => a.id)).toEqual(['lead1'])
    t.w.workers = 2
    await t.svc.queueNext()
    expect(t.asks().map(a => a.id).sort()).toEqual(['lead1', 'lead2'])
  })

  test('idempotency: concurrent ticks ask once, and a tick racing a sim opens exactly one session', async () => {
    const t = setup()
    await t.queue(['c'])
    await Promise.all([t.svc.queueNext(), t.svc.queueNext(), t.svc.tick()])
    expect(t.asks()).toHaveLength(1)
    await Promise.all([t.svc.answerQueue('c', 'sim', 'lead1'), t.svc.answerQueue('c', 'sim', 'owner'), t.svc.stageRun('c', 'owner'), t.svc.queueNext()])
    expect(t.calls.spawned).toEqual(['c'])
    expect((await t.svc.get('c'))?.phase).toBe('executando')
  })

  test('a sim that finds no slot is kept as an approval and the tick starts it when the slot frees', async () => {
    const t = setup()
    await t.queue(['c'])
    await t.svc.queueNext()
    t.w.workers = 4
    const r = await t.svc.answerQueue('c', 'sim', 'lead1')
    expect(r.ok).toBe(true)
    expect(t.calls.spawned).toEqual([])
    expect((await t.svc.get('c'))?.queueAsk?.approved).toMatchObject({ actor: 'lead1', auto: false })
    t.w.workers = 1
    await t.svc.queueNext()
    expect(t.calls.spawned).toEqual(['c'])
    expect((await t.svc.get('c'))?.phase).toBe('executando')
  })

  test('a failed spawn releases the claim: nothing opened, the approval stays and the next tick retries', async () => {
    const t = setup({ spawnOk: false })
    await t.queue(['c'])
    await t.svc.queueNext()
    const r = await t.svc.answerQueue('c', 'sim', 'lead1')
    expect(r.ok).toBe(false)
    expect((await t.svc.get('c'))?.queueAsk?.startingAt).toBeUndefined()
    t.w.spawnOk = true
    await t.svc.queueNext()
    expect(t.calls.spawned).toEqual(['c'])
  })

  test('changing the priority between ticks changes who is asked first', async () => {
    const t = setup()
    await t.queue(['a', 'b'])
    t.w.priorities.a = 'urgent'
    await t.svc.queueNext()
    expect(t.asks()[0]!.text).toContain('Peça a')
    await t.svc.answerQueue('a', 'nao depois', 'lead1')
    t.w.priorities.b = 'urgent'
    t.w.priorities.a = 'low'
    const view = await t.svc.queueView('t1')
    expect(view.items.map(i => i.subtaskId)).toEqual(['b', 'a'])
    expect(view.items.map(i => i.position)).toEqual([1, 2])
  })

  test('the queue view carries everything the tab and the MCP read', async () => {
    const t = setup({ autonomous: false })
    await t.queue(['a', 'c', 'x'])
    await t.svc.queueNext()
    const view = await t.svc.queueView('t1')
    expect(view.total).toBe(3)
    expect(view.autonomous).toBe(false)
    expect(view.items.map(i => i.subtaskId)).toEqual(['c', 'a'])
    const top = view.items[0]!
    expect(top).toMatchObject({ priority: 'urgent', position: 1, globalPosition: 1, taskId: 't1' })
    expect(top.predispatch).toMatchObject({ ok: true, harness: 'claude', model: 'claude-sonnet-5-5', effort: 'high', accountName: 'Vini', cwd: '/r', prompt: 'brief c' })
    expect(top.ask).toMatchObject({ delivered: true, approved: false, onTimeout: 'esperar', leaderSessionId: 'lead1' })
    expect(top.slot?.ok).toBe(true)
    expect((await t.svc.queueView()).items).toHaveLength(3)
    await t.svc.answerQueue('c', 'sim', 'lead1')
    const after = await t.svc.queueView('t1')
    expect(after.items.map(i => i.subtaskId)).toEqual(['a'])
    expect(after.recent[0]).toMatchObject({ subtaskId: 'c', sessionId: 'new-c', auto: false })
  })

  test('a dequeued piece, a closed piece and a group member are never asked about', async () => {
    const t = setup()
    await t.queue(['a', 'c'])
    expect((await t.svc.dequeue('c', 'não vale mais', 'lead1')).ok).toBe(true)
    await t.svc.queueNext()
    expect(t.asks()).toHaveLength(1)
    expect(t.asks()[0]!.text).toContain('Peça a')
  })

  test('the kick coalesces a burst of ended sessions into one run, then one more for what arrived meanwhile', async () => {
    const runs: number[] = []
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const run = async () => { runs.push(runs.length); if (runs.length === 1) await gate; return { actions: [] as string[] } }
    kickQueueNext('a', run); kickQueueNext('b', run); kickQueueNext('c', run)
    release()
    await new Promise(r => setTimeout(r, 20))
    expect(runs).toHaveLength(2)
  })
})
