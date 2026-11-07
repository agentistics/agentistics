import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeliveryService, type DeliveryDeps } from './service'
import { createDeliveryStore } from './store'
import type { GateFacts, SessionFact } from './gates'
import type { DeliveryCi, Phase } from './machine'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'delivery-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

interface World {
  autonomous: boolean
  sessions: SessionFact[]
  releaseRuns: Array<{ databaseId: number; status: string; conclusion: string; headSha: string }>
  tags: Array<{ name: string; commit: { sha: string } }>
  prFiles: Array<{ filename: string; status: string }>
  checkRuns: Array<{ name: string; conclusion: string | null }>
  /** What gh says about the PR (`pr view --json number,state,headRefOid,mergeCommit`). */
  pr: { number: number; state: string; headRefOid: string; mergeCommit: { oid: string } | null }
  /** `compare/<merge>...main` status. */
  onMain: string
  /** The branch tip as `ls-remote` answers (defaults to `head`). */
  remoteHead?: string
  /** The board status the subtask is found in. */
  status?: string
  /** false = the leader cannot be reached. */
  wakeOk?: boolean
  /** gh failure for the check-runs read. */
  checksError?: boolean
  head: string
  memory: number
}

function harness(over: Partial<World> = {}, extra: Partial<DeliveryDeps> = {}) {
  const w: World = {
    autonomous: true,
    sessions: [
      { id: 'leader', harness: 'claude', model: 'claude-opus-5-5', role: 'leader', alive: true, cwd: '/r', worktree: false, taskId: 't1' },
      { id: 'author', harness: 'claude', model: 'claude-opus-5-5', role: 'worker', alive: true, cwd: '/r/.wt/a', worktree: true, rootPath: '/r', taskId: 't1', subtaskId: 's1', label: 'impl', createdAt: '2026-11-07T00:00:00Z' },
      { id: 'qa', harness: 'claude', model: 'claude-sonnet-5-5', role: 'worker', alive: true, cwd: '/r/.wt/q', worktree: true, rootPath: '/r', taskId: 't1', subtaskId: 's1', label: 'QA fluxo', createdAt: '2026-11-07T01:00:00Z' },
    ],
    releaseRuns: [], tags: [], prFiles: [{ filename: 'a.ts', status: 'modified' }], checkRuns: [{ name: 'ci', conclusion: 'success' }],
    pr: { number: 7, state: 'MERGED', headRefOid: 'abc123', mergeCommit: { oid: 'merge1' } }, onMain: 'ahead', head: 'abc123', memory: 8 * 1024 ** 3,
    ...over,
  }
  const facts: GateFacts = {
    subtask: async id => (id === 's1' || id === 's2' ? { id, taskId: 't1', title: id, status: w.status ?? 'todo', groupMember: false, blockedBy: id === 's2' ? ['s1'] : [], staged: { prompt: 'do it', harness: 'claude', model: 'claude-opus-5-5', effort: 'high', account: 'acc_1', cwd: '/r' } } : null),
    sessions: async () => w.sessions,
    budgets: async () => [{ harness: 'claude', account: 'acc_1', fiveHourPct: 20, weekPct: 30, stale: false }],
    memoryBytes: async () => w.memory,
    topCap: async () => 2,
    git: async (_cwd, args) => {
      if (args[0] === 'rev-parse') return `${w.head}\n`
      if (args[0] === 'status') return ''
      if (args[0] === 'symbolic-ref') return 'feat/x\n'
      if (args[0] === 'ls-remote') return `${w.remoteHead ?? w.head}\trefs/heads/feat/x\n`
      return ''
    },
    gh: async (_cwd, args) => {
      const a = args.join(' ')
      calls.gh.push(a)
      if (a.includes('check-runs') && w.checksError) throw new Error('gh: HTTP 502')
      if (a.includes('check-runs')) return JSON.stringify({ check_runs: w.checkRuns })
      if (a.includes('/files')) return JSON.stringify(w.prFiles)
      if (a.startsWith('run list')) return JSON.stringify(w.releaseRuns)
      if (a.includes('/tags')) return JSON.stringify(w.tags)
      if (a.includes('/compare/') && a.includes('...main')) return JSON.stringify({ status: w.onMain })
      if (a.includes('/compare/')) return JSON.stringify({ status: 'ahead' })
      if (a.startsWith('pr view')) return JSON.stringify(w.pr)
      return '{}'
    },
  }
  const calls = { gh: [] as string[], owner: [] as Array<{ text: string; kind: string }>, session: [] as Array<{ id: string; text: string }>, status: [] as Array<{ id: string; phase: Phase }>, ci: [] as Array<DeliveryCi | null>, steps: [] as number[], emits: [] as Array<{ type: string; payload: Record<string, unknown> }>, comments: [] as string[] }
  let now = Date.parse('2026-11-07T02:00:00Z')
  const svc = createDeliveryService({
    store: createDeliveryStore(join(dir, 'deliveries.json')),
    facts,
    board: {
      setPhaseStatus: async (id, phase) => { calls.status.push({ id, phase }); return { ok: true } },
      setCi: async (_id, ci) => { calls.ci.push(ci) },
      logStep: async (_t, _s, n) => { calls.steps.push(n) },
      comment: async (_t, _s, body) => { calls.comments.push(body) },
      subtaskFinished: async () => false,
      stage: async () => ({ ok: true }),
    },
    notify: {
      session: async (id, text) => { calls.session.push({ id, text }); return w.wakeOk !== false },
      owner: async (text, kind) => { calls.owner.push({ text, kind }) },
    },
    autonomous: async () => w.autonomous,
    emit: async (type, payload) => { calls.emits.push({ type, payload }) },
    merge: async () => ({ ok: true, mergeSha: 'merge1', pr: 7 }),
    now: () => now,
    ...extra,
  })
  return { svc, w, calls, advance: (ms: number) => { now += ms } }
}

async function walkToQa(svc: ReturnType<typeof harness>['svc']) {
  await svc.configure('s1', { leaderSessionId: 'leader', versionTarget: '2.200.8' }, 'leader')
  expect((await svc.transition('s1', 'executando', {}, 'leader')).ok).toBe(true)
  const qa = await svc.transition('s1', 'qa', {}, 'author')
  expect(qa.ok).toBe(true)
}

describe('delivery service', () => {
  test('happy path end to end, gates run by the transition itself, every phase visited', async () => {
    const { svc, w, calls, advance } = harness()
    await walkToQa(svc)
    expect((await svc.get('s1'))!.headSha).toBe('abc123')
    expect((await svc.transition('s1', 'revisao_lider', { verdict: 'APROVADO', findings: '12 tests green' }, 'qa')).ok).toBe(true)
    const rec = (await svc.get('s1'))!
    expect(rec.qaSha).toBe('abc123')
    expect(rec.gates['qa-modelo']!.evidence).toMatchObject({ authorModel: 'claude-opus-5-5', qaModel: 'claude-sonnet-5-5' })
    expect((await svc.transition('s1', 'pr_merge', { reviewedSha: 'abc123', detail: 'ok' }, 'leader')).ok).toBe(true)
    const merged = await svc.merge('s1', 'leader')
    expect(merged.ok && merged.record.phase).toBe('ci')
    expect((await svc.tick()).actions).toEqual([])
    advance(61_000) // the ci poll backs off between reads
    w.releaseRuns = [{ databaseId: 1, status: 'completed', conclusion: 'success', headSha: 'merge1' }]
    w.tags = [{ name: 'v2.200.8', commit: { sha: 'tagsha' } }]
    const t = await svc.tick()
    expect(t.actions[0]).toBe('publish s1:true')
    const final = (await svc.get('s1'))!
    expect(final.phase).toBe('publicado')
    expect(final.history.map(h => h.to)).toEqual(['executando', 'qa', 'revisao_lider', 'pr_merge', 'ci', 'publicado'])
    expect(calls.status.map(s => s.phase)).toEqual(['executando', 'qa', 'revisao_lider', 'pr_merge', 'ci', 'publicado'])
    expect(calls.emits.filter(e => e.type === 'entrega.etapa').map(e => e.payload.fase)).toEqual(['executando', 'qa', 'revisao_lider', 'pr_merge', 'ci', 'publicado'])
    expect(calls.ci.at(-1)).toEqual({ mergedMain: true, releaseGreen: true, tagPublished: true, tag: 'v2.200.8', pr: 7 })
    expect(calls.steps).toContain(1)
    // The owner hears ONE informational notice (published), never a decision.
    expect(calls.owner).toEqual([expect.objectContaining({ kind: 'aviso' })])
  })

  test('QA with the same model as the author is refused', async () => {
    const { svc, w } = harness()
    await walkToQa(svc)
    w.sessions[2]!.model = 'claude-opus-5-5'
    const r = await svc.transition('s1', 'revisao_lider', { verdict: 'APROVADO', findings: 'x' }, 'qa')
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.status).toBe(422); expect(r.sentence).toContain('same model') }
  })

  test('never Sonnet over Sonnet', async () => {
    const { svc, w } = harness()
    w.sessions[1]!.model = 'claude-sonnet-5-5'
    w.sessions[2]!.model = 'claude-sonnet-4-6'
    await walkToQa(svc)
    const r = await svc.transition('s1', 'revisao_lider', { verdict: 'APROVADO', findings: 'x' }, 'qa')
    expect(!r.ok && r.sentence).toContain('Sonnet')
  })

  test('the owner print case through the service: 422 fase_pulada', async () => {
    const { svc } = harness()
    await svc.configure('s1', { leaderSessionId: 'leader' }, 'leader')
    await svc.transition('s1', 'executando', {}, 'leader')
    const r = await svc.transition('s1', 'revisao_lider', {}, 'leader')
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.status).toBe(422); expect(r.code).toBe('fase_pulada') }
  })

  test('QA failure wakes the author with the findings; ajuste must go back through QA', async () => {
    const { svc, calls } = harness()
    await walkToQa(svc)
    expect((await svc.transition('s1', 'ajuste', { verdict: 'REPROVADO', findings: 'button misaligned' }, 'qa')).ok).toBe(true)
    expect(calls.session.at(-1)).toMatchObject({ id: 'author' })
    expect(calls.session.at(-1)!.text).toContain('button misaligned')
    expect((await svc.transition('s1', 'revisao_lider', {}, 'author')).ok).toBe(false)
    expect((await svc.transition('s1', 'qa', {}, 'author')).ok).toBe(true)
  })

  test('a merge that fails goes back to the leader review with the reason', async () => {
    const { svc, calls } = harness({}, { merge: async () => ({ ok: false, message: 'merge conflict in a.ts' }) })
    await walkToQa(svc)
    await svc.transition('s1', 'revisao_lider', { verdict: 'APROVADO', findings: 'ok' }, 'qa')
    await svc.transition('s1', 'pr_merge', { reviewedSha: 'abc123' }, 'leader')
    const r = await svc.merge('s1', 'leader')
    expect(r.ok && r.record.phase).toBe('revisao_lider')
    expect(calls.session.at(-1)!.text).toContain('merge conflict')
  })

  test('a PR deleting a file outright never merges', async () => {
    const { svc, w } = harness({ prFiles: [{ filename: 'keep.ts', status: 'removed' }] })
    await walkToQa(svc)
    await svc.transition('s1', 'revisao_lider', { verdict: 'APROVADO', findings: 'ok' }, 'qa')
    await svc.transition('s1', 'pr_merge', { reviewedSha: 'abc123' }, 'leader')
    const r = await svc.merge('s1', 'leader')
    expect(r.ok && r.record.phase).toBe('revisao_lider')
    expect(r.ok && r.record.history.at(-1)!.detail).toContain('keep.ts')
    void w
  })

  test('release that fails goes back to the leader review', async () => {
    const { svc, w } = harness()
    await walkToQa(svc)
    await svc.transition('s1', 'revisao_lider', { verdict: 'APROVADO', findings: 'ok' }, 'qa')
    await svc.transition('s1', 'pr_merge', { reviewedSha: 'abc123' }, 'leader')
    await svc.merge('s1', 'leader')
    w.releaseRuns = [{ databaseId: 2, status: 'completed', conclusion: 'failure', headSha: 'merge1' }]
    await svc.tick()
    expect((await svc.get('s1'))!.phase).toBe('revisao_lider')
  })

  test('the vaga gate refuses past the 4-worker machine ceiling and below 3 GB', async () => {
    const extra: SessionFact[] = [1, 2, 3, 4].map(i => ({ id: `w${i}`, harness: 'codex', role: 'worker', alive: true, cwd: '/x', worktree: true }))
    const { svc, w } = harness()
    w.sessions = [...w.sessions.filter(s => s.role === 'leader'), ...extra]
    const r = await svc.transition('s1', 'executando', {}, 'leader')
    expect(!r.ok && r.sentence).toContain('machine ceiling')
    w.sessions = w.sessions.filter(s => s.role === 'leader'); w.memory = 1024 ** 3
    const m = await svc.transition('s1', 'executando', {}, 'leader')
    expect(!m.ok && m.sentence).toContain('3 GB')
  })

  test('block returns to the origin phase; the leader is woken, the owner never in autonomous mode', async () => {
    const { svc, calls, advance } = harness()
    await walkToQa(svc)
    const b = await svc.block('s1', 'externo', 'GitHub Actions down', 'leader')
    expect(b.ok && b.record.phase).toBe('bloqueado')
    expect(calls.session.at(-1)!.id).toBe('leader')
    advance(31 * 60_000)
    expect((await svc.tick()).actions).toEqual(['wake s1'])
    advance(2 * 3600_000)
    expect((await svc.tick()).actions).toEqual(['defer s1'])
    expect((await svc.get('s1'))!.versionTarget).toBe('next')
    const u = await svc.unblock('s1', 'leader', 'GitHub back')
    expect(u.ok && u.record.phase).toBe('qa')
    expect(calls.owner).toEqual([])
  })

  test('autonomous ON: an owner decision request becomes the leader\'s safe path; nothing reaches the owner', async () => {
    const { svc, calls } = harness()
    await walkToQa(svc)
    const b = await svc.block('s1', 'decisao_do_dono', 'needs the Apple subscription', 'leader')
    expect(b.ok && b.record.block!.reason).toBe('fora_das_autorizacoes')
    expect(b.ok && b.record.block!.deferredAt).toBeTruthy()
    expect(calls.owner).toEqual([])
  })

  test('autonomous OFF: an owner decision reaches the owner as a decision', async () => {
    const { svc, calls } = harness({ autonomous: false })
    await walkToQa(svc)
    const b = await svc.block('s1', 'fora_das_autorizacoes', 'spend money', 'leader')
    expect(b.ok && b.record.block!.reason).toBe('decisao_do_dono')
    expect(calls.owner).toEqual([expect.objectContaining({ kind: 'decisao' })])
  })

  describe('human gates', () => {
    async function toReview(autonomous: boolean) {
      const h = harness({ autonomous })
      await h.svc.configure('s1', { humanGates: ['pr_merge'] }, 'leader')
      await walkToQa(h.svc)
      await h.svc.transition('s1', 'revisao_lider', { verdict: 'APROVADO', findings: 'ok' }, 'qa')
      return h
    }
    test('autonomous ON skips and records "pulado: modo autônomo"', async () => {
      const { svc, calls } = await toReview(true)
      const r = await svc.transition('s1', 'pr_merge', { reviewedSha: 'abc123' }, 'leader')
      expect(r.ok && r.record.skips).toEqual([expect.objectContaining({ phase: 'pr_merge', outcome: 'pulado: modo autônomo' })])
      expect(calls.comments.at(-1)).toContain('pulado: modo autônomo')
      expect(calls.owner.filter(o => o.kind === 'decisao')).toEqual([])
    })
    test('autonomous OFF asks the owner, waits (409), proceeds on approval; a session cannot approve', async () => {
      const { svc, calls } = await toReview(false)
      const waiting = await svc.transition('s1', 'pr_merge', { reviewedSha: 'abc123' }, 'leader')
      expect(!waiting.ok && waiting.status).toBe(409)
      expect(calls.owner.at(-1)!.kind).toBe('decisao')
      expect((await svc.approve('s1', 'pr_merge', 'approve', undefined, false)).ok).toBe(false)
      expect((await svc.approve('s1', 'pr_merge', 'approve', 'go', true)).ok).toBe(true)
      expect((await svc.transition('s1', 'pr_merge', { reviewedSha: 'abc123' }, 'leader')).ok).toBe(true)
    })
  })

  test('a dependency unblocks itself once its sibling is published', async () => {
    const { svc, w } = harness()
    expect((await svc.block('s2', 'dependencia', 'waits for s1', 'leader')).ok).toBe(true)
    expect((await svc.tick()).actions).toEqual([])
    await walkToQa(svc)
    await svc.transition('s1', 'revisao_lider', { verdict: 'APROVADO', findings: 'ok' }, 'qa')
    await svc.transition('s1', 'pr_merge', { reviewedSha: 'abc123' }, 'leader')
    await svc.merge('s1', 'leader')
    w.releaseRuns = [{ databaseId: 1, status: 'completed', conclusion: 'success', headSha: 'merge1' }]
    w.tags = [{ name: 'v2.200.8', commit: { sha: 'merge1' } }]
    await svc.tick()
    expect((await svc.tick()).actions).toEqual(['unblock s2'])
    expect((await svc.get('s2'))!.phase).toBe('fila')
  })

  test('stage writes the pre-dispatch and records the predispatch gate', async () => {
    const { svc, calls } = harness()
    const r = await svc.stage('s1', { prompt: 'x', harness: 'claude', model: 'claude-opus-5-5', effort: 'high', account: 'acc_1' }, 'leader', { leaderSessionId: 'leader', pedidoId: 'p-1' })
    expect(r.ok && r.record.gates.predispatch!.ok).toBe(true)
    expect(calls.emits.find(e => e.type === 'subtarefa.preparada')!.payload).toMatchObject({ subtarefa: 's1', pedido: 'p-1' })
  })
})

test('two concurrent ticks wake the leader once (the tick is serialised)', async () => {
  const { svc, calls, advance } = harness()
  await walkToQa(svc)
  await svc.block('s1', 'limite', 'conta em 90%', 'leader')
  const wakesBefore = calls.session.length
  advance(31 * 60_000)
  const [a, b] = await Promise.all([svc.tick(), svc.tick()])
  expect([...a.actions, ...b.actions]).toEqual(['wake s1'])
  expect(calls.session.length - wakesBefore).toBe(1)
})


// ------------------------------------------------------------------------------------- QA fix round (07/11)

async function toPrMerge(h: ReturnType<typeof harness>) {
  await walkToQa(h.svc)
  expect((await h.svc.transition('s1', 'revisao_lider', { verdict: 'APROVADO', findings: 'ok' }, 'qa')).ok).toBe(true)
  await h.svc.configure('s1', { pr: 7 }, 'leader')
  expect((await h.svc.transition('s1', 'pr_merge', { reviewedSha: 'abc123' }, 'leader')).ok).toBe(true)
}

describe('H1 — the merge is verified on the host', () => {
  test('a caller-supplied merge sha with no merged PR does not reach ci', async () => {
    const h = harness({ pr: { number: 7, state: 'OPEN', headRefOid: 'abc123', mergeCommit: null } })
    await toPrMerge(h)
    const r = await h.svc.transition('s1', 'ci', { mergeSha: 'deadbeef-never-merged' }, 'worker')
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.sentence).toContain('mergeado'); expect(r.sentence).toContain('not merged') }
    expect((await h.svc.get('s1'))!.phase).toBe('pr_merge')
  })
  test('a merged PR whose merge commit is not on origin/main is refused', async () => {
    const h = harness({ onMain: 'behind' })
    await toPrMerge(h)
    const r = await h.svc.transition('s1', 'ci', {}, 'leader')
    expect(!r.ok && r.sentence).toContain('not on origin/main')
  })
  test('a PR merged from a head other than the sha QA approved is refused', async () => {
    const h = harness({ pr: { number: 7, state: 'MERGED', headRefOid: 'other999', mergeCommit: { oid: 'merge1' } } })
    await toPrMerge(h)
    const r = await h.svc.transition('s1', 'ci', {}, 'leader')
    expect(!r.ok && r.sentence).toContain('not the sha QA approved')
  })
  test('the merge sha is the PR\'s, whatever the caller states', async () => {
    const h = harness()
    await toPrMerge(h)
    const r = await h.svc.transition('s1', 'ci', { mergeSha: 'caller-made-up' }, 'worker')
    expect(r.ok && r.record.mergeSha).toBe('merge1')
  })
})

describe('H2 — the QA and the author come from the registry, not from a caller', () => {
  const world = () => ({
    sessions: [
      { id: 'leader', harness: 'claude', model: 'claude-opus-5-5', role: 'leader', alive: true, cwd: '/r', worktree: false, taskId: 't1' },
      { id: 'author', harness: 'claude', model: 'claude-sonnet-5-5', role: 'worker', alive: true, cwd: '/r/.wt/a', worktree: true, rootPath: '/r', taskId: 't1', subtaskId: 's1', label: 'impl' },
      { id: 'qa', harness: 'claude', model: 'claude-sonnet-4-6', role: 'worker', alive: true, cwd: '/r/.wt/q', worktree: true, rootPath: '/r', taskId: 't1', subtaskId: 's1', label: 'QA x' },
      { id: 'rand', harness: 'claude', model: 'claude-haiku-5-5', role: 'worker', alive: true, cwd: '/x', worktree: true, rootPath: '/x', taskId: 't2', subtaskId: 'other', label: 'whatever' },
    ] as SessionFact[],
  })
  test('configure ignores qaSessionId / authorSessionId (Sonnet over Sonnet still refused)', async () => {
    const h = harness(world())
    await walkToQa(h.svc)
    await h.svc.configure('s1', { qaSessionId: 'rand', authorSessionId: 'rand' }, 'leader')
    const rec = (await h.svc.get('s1'))!
    expect(rec.qaSessionId).toBeUndefined()
    expect(rec.authorSessionId).toBe('author')
    const r = await h.svc.transition('s1', 'revisao_lider', { verdict: 'APROVADO', findings: 'x' }, 'qa')
    expect(!r.ok && r.sentence).toContain('Sonnet')
  })
  test('a session of another subtask never stands for the QA, even when recorded', async () => {
    const { qaOf, authorOf } = await import('./gates')
    const { newDelivery } = await import('./machine')
    const r = { ...newDelivery({ subtaskId: 's1', taskId: 't1', at: 'x' }), qaSessionId: 'rand', authorSessionId: 'rand' }
    expect(qaOf(r, world().sessions)).toBeNull()
    expect(authorOf(r, world().sessions)).toBeNull()
  })
  test('the leader is neither author nor QA', async () => {
    const { qaOf } = await import('./gates')
    const { newDelivery } = await import('./machine')
    const s = world().sessions.map(x => (x.id === 'leader' ? { ...x, subtaskId: 's1', label: 'QA lead' } : x))
    expect(qaOf(newDelivery({ subtaskId: 's1', taskId: 't1', at: 'x' }), s)!.id).toBe('qa')
  })
  test('a worker session cannot configure; the leader of the task and the owner can', async () => {
    const h = harness()
    const worker = await h.svc.configure('s1', { versionTarget: '9.9.9' }, 'author')
    expect(!worker.ok && worker.status).toBe(403)
    expect((await h.svc.configure('s1', { versionTarget: '2.200.8' }, 'leader')).ok).toBe(true)
    expect((await h.svc.configure('s1', { versionTarget: '2.200.9' }, 'owner')).ok).toBe(true)
  })
})

describe('H3 — salvo reads the real check runs', () => {
  test('pending check runs refuse', async () => {
    const h = harness({ checkRuns: [{ name: 'ci', conclusion: 'success' }, { name: 'e2e', conclusion: null }] })
    await h.svc.configure('s1', { leaderSessionId: 'leader' }, 'leader')
    await h.svc.transition('s1', 'executando', {}, 'leader')
    const r = await h.svc.transition('s1', 'qa', {}, 'author')
    expect(!r.ok && r.sentence).toContain('pending')
  })
  test('no check run at all refuses', async () => {
    const h = harness({ checkRuns: [] })
    await h.svc.configure('s1', { leaderSessionId: 'leader' }, 'leader')
    await h.svc.transition('s1', 'executando', {}, 'leader')
    const r = await h.svc.transition('s1', 'qa', {}, 'author')
    expect(!r.ok && r.sentence).toContain('no check run')
  })
  test('an unreadable check-runs source refuses (fail closed)', async () => {
    const h = harness({ checksError: true })
    await h.svc.configure('s1', { leaderSessionId: 'leader' }, 'leader')
    await h.svc.transition('s1', 'executando', {}, 'leader')
    const r = await h.svc.transition('s1', 'qa', {}, 'author')
    expect(!r.ok && r.sentence).toContain('could not be read')
  })
  test('green runs pass and the evidence no longer claims a hook was checked', async () => {
    const h = harness()
    await walkToQa(h.svc)
    const ev = (await h.svc.get('s1'))!.gates.salvo!.evidence!
    expect(ev.checks).toBe('passed')
    expect(JSON.stringify(ev)).not.toContain('pre-commit')
  })
})

describe('M1 — HEAD must not have moved since QA', () => {
  test('a push after QA blocks revisao_lider → pr_merge', async () => {
    const h = harness()
    await walkToQa(h.svc)
    await h.svc.transition('s1', 'revisao_lider', { verdict: 'APROVADO', findings: 'ok' }, 'qa')
    h.w.remoteHead = 'pushed-after-qa'
    const r = await h.svc.transition('s1', 'pr_merge', { reviewedSha: 'abc123' }, 'leader')
    expect(!r.ok && r.sentence).toContain('cabeca')
    h.w.remoteHead = undefined
    expect((await h.svc.transition('s1', 'pr_merge', { reviewedSha: 'abc123' }, 'leader')).ok).toBe(true)
  })
})

describe('M2 — who may unblock', () => {
  test('a worker cannot lift a leader block; the leader can', async () => {
    const h = harness()
    await walkToQa(h.svc)
    await h.svc.block('s1', 'externo', 'gh down', 'leader')
    const w = await h.svc.unblock('s1', 'author', 'trust me')
    expect(!w.ok && w.status).toBe(403)
    expect((await h.svc.unblock('s1', 'leader', 'back')).ok).toBe(true)
  })
  test('an owner-decision block is lifted only by the owner (autonomous OFF)', async () => {
    const h = harness({ autonomous: false })
    await walkToQa(h.svc)
    await h.svc.block('s1', 'decisao_do_dono', 'pick one', 'leader')
    const l = await h.svc.unblock('s1', 'leader')
    expect(!l.ok && l.code).toBe('so_o_dono')
    const w = await h.svc.unblock('s1', 'author')
    expect(!w.ok && w.status).toBe(403)
    expect((await h.svc.unblock('s1', 'owner', 'chose B')).ok).toBe(true)
  })
})

describe('M5 — the human gate asks the owner ONCE and is answerable', () => {
  async function toReview() {
    const h = harness({ autonomous: false })
    await h.svc.configure('s1', { humanGates: ['pr_merge'] }, 'leader')
    await walkToQa(h.svc)
    await h.svc.transition('s1', 'revisao_lider', { verdict: 'APROVADO', findings: 'ok' }, 'qa')
    return h
  }
  test('three refused retries ring ONE bell', async () => {
    const h = await toReview()
    for (let i = 0; i < 3; i++) await h.svc.transition('s1', 'pr_merge', { reviewedSha: 'abc123' }, 'leader')
    expect(h.calls.owner.filter(o => o.kind === 'decisao')).toHaveLength(1)
    expect(h.calls.owner.at(-1)!.text).toContain('agentop flow approve')
  })
  test('an answer to a question nobody asked is refused; after the ask it is accepted', async () => {
    const h = await toReview()
    const early = await h.svc.approve('s1', 'pr_merge', 'approve', undefined, true)
    expect(!early.ok && early.code).toBe('nao_perguntado')
    await h.svc.transition('s1', 'pr_merge', { reviewedSha: 'abc123' }, 'leader')
    expect((await h.svc.approve('s1', 'pr_merge', 'approve', 'go', true)).ok).toBe(true)
    expect((await h.svc.transition('s1', 'pr_merge', { reviewedSha: 'abc123' }, 'leader')).ok).toBe(true)
  })
})

describe('L1/L5/L6/L7', () => {
  test('L1: an unreadable autonomous mode is said, not silently assumed', async () => {
    const h = harness({}, { autonomous: async () => { throw new Error('prefs unreadable') } })
    await h.svc.configure('s1', { leaderSessionId: 'leader' }, 'leader')
    const r = await h.svc.transition('s1', 'executando', {}, 'leader')
    expect(r.ok && r.warnings.join(' ')).toContain('autonomous mode could not be read')
  })
  test('L6: a subtask already in progress on the board is adopted at executando, not re-queued', async () => {
    const h = harness({ status: 'in_progress' })
    const r = await h.svc.ensure('s1')
    expect('phase' in r && r.phase).toBe('executando')
  })
  test('L7: a wake that did not reach the leader is not stamped as a wake', async () => {
    const h = harness({ wakeOk: false })
    await walkToQa(h.svc)
    await h.svc.block('s1', 'externo', 'gh down', 'leader')
    const b = (await h.svc.get('s1'))!.block!
    expect(b.lastWakeAt).toBeUndefined()
    expect(b.wakes).toBe(0)
  })
  test('L5: the ci poll backs off and publishes on ONE release read', async () => {
    const h = harness()
    await toPrMerge(h)
    await h.svc.transition('s1', 'ci', {}, 'leader')
    h.calls.gh.length = 0
    await h.svc.tick()
    expect(h.calls.gh.filter(c => c.startsWith('run list'))).toHaveLength(1)
    await h.svc.tick()
    expect(h.calls.gh.filter(c => c.startsWith('run list'))).toHaveLength(1)
    h.advance(61_000)
    h.w.releaseRuns = [{ databaseId: 1, status: 'completed', conclusion: 'success', headSha: 'merge1' }]
    h.w.tags = [{ name: 'v2.200.8', commit: { sha: 'tagsha' } }]
    h.calls.gh.length = 0
    expect((await h.svc.tick()).actions[0]).toBe('publish s1:true')
    expect(h.calls.gh.filter(c => c.startsWith('run list'))).toHaveLength(1)
  })
})

describe('M6 — the queue shows its expected slot', () => {
  test('stage reads the vaga gate at once (no more "not checked yet")', async () => {
    const h = harness()
    const r = await h.svc.stage('s1', { prompt: 'x', harness: 'claude', model: 'claude-opus-5-5', effort: 'high', account: 'acc_1' }, 'leader', { leaderSessionId: 'leader' })
    expect(r.ok && r.record.gates.vaga).toMatchObject({ ok: true })
  })
  test('the minute tick re-reads the slot of a queued piece every few minutes, and not every minute', async () => {
    const h = harness()
    await h.svc.stage('s1', { prompt: 'x', harness: 'claude', model: 'claude-opus-5-5', effort: 'high', account: 'acc_1' }, 'leader', { leaderSessionId: 'leader' })
    h.w.memory = 1024 ** 3 // the machine got tight
    await h.svc.tick()
    expect((await h.svc.get('s1'))!.gates.vaga!.ok).toBe(true) // inside the refresh window: untouched
    h.advance(6 * 60_000)
    await h.svc.tick()
    const vaga = (await h.svc.get('s1'))!.gates.vaga!
    expect(vaga.ok).toBe(false)
    expect(vaga.reason).toContain('3 GB')
  })
})
