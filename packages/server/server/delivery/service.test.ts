import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeliveryService, type DeliveryDeps } from './service'
import { createDeliveryStore } from './store'
import { blockedPiecesOf, type BlockedSubtaskFact, type GateFacts, type SessionFact } from './gates'
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
  /** Board subtasks held in `blocked` (BLOQUEIO.ORFAO). */
  blocked?: BlockedSubtaskFact[]
  /** Board pieces (subtasks or tasks) that are done. */
  finished?: string[]
  /** true = every board status write is refused. */
  boardWriteFails?: boolean
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
    blockedSubtasks: async () => w.blocked ?? [],
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
      setPhaseStatus: async (id, phase) => { calls.status.push({ id, phase }); return w.boardWriteFails ? { ok: false, message: 'board write failed' } : { ok: true } },
      setCi: async (_id, ci) => { calls.ci.push(ci) },
      logStep: async (_t, _s, n) => { calls.steps.push(n) },
      comment: async (_t, _s, body) => { calls.comments.push(body) },
      subtaskFinished: async id => w.finished?.includes(id) ?? false,
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
    // A deferral takes the piece OUT of Bloqueado (r2): it is in the queue of the next batch, so there is nothing left to unblock.
    expect((await svc.get('s1'))!.phase).toBe('fila')
    expect((await svc.get('s1'))!.history.at(-1)!.detail).toContain('estava em qa')
    expect((await svc.unblock('s1', 'leader', 'GitHub back')).ok).toBe(false)
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

  test('autonomous ON: an out-of-authorisation block is never parked in Bloqueado — fila, next batch, board todo, one comment, one wake', async () => {
    const { svc, calls, advance } = harness()
    await walkToQa(svc)
    const woken = calls.session.length
    const comments = calls.comments.length
    const b = await svc.block('s1', 'fora_das_autorizacoes', 'spend money', 'leader')
    expect(b.ok && b.record).toMatchObject({ phase: 'fila', versionTarget: 'next', block: { reason: 'fora_das_autorizacoes', text: 'spend money', deferredAt: expect.any(String) } })
    expect((await svc.get('s1'))!.origin).toBeUndefined()
    expect(calls.status.at(-1)).toEqual({ id: 's1', phase: 'fila' })
    expect(calls.comments.slice(comments).filter(c => c.includes('adiada para o próximo lote'))).toHaveLength(1)
    expect(calls.session.slice(woken).filter(c => c.id === 'leader' && c.text.includes('adiada'))).toHaveLength(1)
    expect(calls.owner).toEqual([])
    // Nothing chases it afterwards.
    advance(3 * 3600_000)
    expect((await svc.tick()).actions).toEqual([])
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

describe('BLOQUEIO.ORFAO — a board-blocked piece with no delivery record is chased like any other', () => {
  const orphan = (over: Partial<BlockedSubtaskFact> = {}): BlockedSubtaskFact => ({ id: 's9', taskId: 't1', title: 'peça antiga', blockedBy: [], groupMember: false, since: '2026-11-07T01:50:00Z', ...over })

  test('QA: 60 legacy pieces do not send 60 wakes to one leader', async () => {
    const h = harness({ blocked: Array.from({ length: 60 }, (_, i) => orphan({ id: `s${100 + i}` })) })
    await h.svc.tick()
    expect(h.calls.session.length).toBeLessThanOrEqual(1)
  })

  test('QA: a finished sibling unblocks the adopted piece', async () => {
    let finished = false
    const h = harness({ blocked: [orphan({ id: 's2', blockedBy: ['s1'] })] })
    // Use the real service and disk store, with a board dependency that later completes.
    const base = h.svc
    await base.tick()
    const facts: GateFacts = {
      subtask: async id => ({ id, taskId: 't1', title: id, status: 'blocked', groupMember: false, blockedBy: ['s1'] }),
      sessions: async () => h.w.sessions, budgets: async () => [], memoryBytes: async () => null, topCap: async () => 2,
      git: async () => '', gh: async () => '{}',
    }
    const restarted = createDeliveryService({
      store: createDeliveryStore(join(dir, 'deliveries.json')), facts,
      board: { setPhaseStatus: async () => ({ ok: true }), setCi: async () => {}, logStep: async () => {}, comment: async () => {}, subtaskFinished: async () => finished, stage: async () => ({ ok: true }) },
      notify: { session: async () => true, owner: async () => {} }, autonomous: async () => true,
      emit: async () => {}, merge: async () => ({ ok: true, mergeSha: 'merge1', pr: 7 }), now: () => Date.parse('2026-11-07T02:01:00Z'),
    })
    finished = true
    await restarted.tick()
    expect((await restarted.get('s2'))!.phase).toBe('fila')
  })

  test('QA: a leader dying after adoption is replaced by the live leader', async () => {
    const h = harness({ blocked: [orphan()] })
    await h.svc.tick()
    h.w.sessions = [{ id: 'replacement', harness: 'claude', role: 'leader', alive: true, cwd: '/r', worktree: false, taskId: 't1' }]
    h.w.wakeOk = false
    h.advance(31 * 60_000)
    await h.svc.tick()
    expect(h.calls.session.at(-1)!.id).toBe('replacement')
  })

  // The QA's original expectation here was that a group member IS adopted and stays parked in Bloqueado after its deferral. Both
  // halves are the defects the r2 brief fixes (6: a member is never a delivery of its own; 5: a deferral leaves Bloqueado).
  test('QA (r2 contract): a group member is never adopted; its block is chased through the group', async () => {
    const h = harness({ blocked: [orphan({ groupMember: true, since: '2026-10-25T12:00:00Z' })] })
    expect((await h.svc.tick()).actions).toEqual([])
    expect(await h.svc.get('s9')).toBeNull()
    expect(h.calls.session).toEqual([])
    expect(h.calls.comments).toEqual([])
  })

  test('QA: restart does not duplicate adoption comments or leader wakes', async () => {
    const h = harness({ blocked: [orphan()] })
    await h.svc.tick()
    const restart = harness({ blocked: [orphan()] })
    expect((await restart.svc.tick()).actions).toEqual([])
    expect(restart.calls.comments).toEqual([])
    expect(restart.calls.session).toEqual([])
  })

  test.each(['done', 'abandoned'])('QA: an adopted piece later marked %s is never chased', async status => {
    const h = harness({ blocked: [orphan({ id: 's1' })] })
    await h.svc.tick()
    h.w.blocked = []
    h.w.status = status
    h.advance(31 * 60_000)
    expect((await h.svc.tick()).actions).toEqual([])
  })

  test('adopted at bloqueado, the leader woken, then deferred after 2 h; a second tick is a no-op', async () => {
    const h = harness({ blocked: [orphan()] })
    const first = await h.svc.tick()
    expect(first.actions).toContain('adopt s9')
    const rec = (await h.svc.get('s9'))!
    expect(rec).toMatchObject({ phase: 'bloqueado', leaderSessionId: 'leader', block: { reason: 'pedido_de_bloqueio', unlocker: 'leader', since: '2026-11-07T01:50:00Z' } })
    // Woken on the adopting tick (no lastWakeAt yet), and told in a comment.
    expect(first.actions).toContain('wake s9')
    expect(h.calls.session.filter(c => c.id === 'leader' && c.text.includes('[entrega s9]'))).toHaveLength(1)
    const commentsAfterFirst = h.calls.comments.length
    // The same minute again: nothing adopted, nobody woken, no new comment.
    const second = await h.svc.tick()
    expect(second.actions).toEqual([])
    expect(h.calls.comments.length).toBe(commentsAfterFirst)
    expect(h.calls.session.filter(c => c.text.includes('[entrega s9]'))).toHaveLength(1)
    // Past 30 min the leader is woken again; past 2 h the piece is deferred (once).
    h.advance(31 * 60_000)
    expect((await h.svc.tick()).actions).toEqual(['wake s9'])
    h.advance(95 * 60_000)
    expect((await h.svc.tick()).actions).toEqual(['defer s9'])
    expect((await h.svc.get('s9'))!.block!.deferredAt).toBeTruthy()
    expect((await h.svc.tick()).actions).toEqual([])
    expect(h.calls.emits.filter(e => e.type === 'entrega.adiada')).toHaveLength(1)
    // The owner is never called, in autonomous mode or any other.
    expect(h.calls.owner).toEqual([])
  })

  test('a thirteen-day-old block is deferred on the very tick that adopts it', async () => {
    const h = harness({ blocked: [orphan({ since: '2026-10-25T12:00:00Z' })] })
    const t = await h.svc.tick()
    expect(t.actions).toEqual(['adopt s9', 'defer s9'])
    expect(h.calls.comments.some(c => c.includes('ADIADA'))).toBe(true)
  })

  test('a leaderless task gets one comment and one warning, never a loop', async () => {
    const h = harness({ blocked: [orphan()], sessions: [{ id: 'worker', harness: 'claude', role: 'worker', alive: true, cwd: '/r', worktree: false, taskId: 't1' }] })
    expect((await h.svc.tick()).actions).toEqual(['adopt s9', 'no-leader s9', 'wake-failed s9'])
    expect(h.calls.comments.filter(c => c.includes('não tem líder vivo'))).toHaveLength(1)
    expect(h.calls.owner).toEqual([expect.objectContaining({ kind: 'aviso' })])
    expect(h.calls.session).toEqual([])
    // Every later tick stays silent: no comment, no bell.
    const again = await h.svc.tick()
    expect(again.actions.every(a => a.startsWith('wake-failed'))).toBe(true)
    expect(h.calls.comments.filter(c => c.includes('não tem líder vivo'))).toHaveLength(1)
    expect(h.calls.owner).toHaveLength(1)
  })

  test('a leader that shows up later is picked up by the next tick', async () => {
    const h = harness({ blocked: [orphan()], sessions: [] })
    await h.svc.tick()
    expect((await h.svc.get('s9'))!.leaderSessionId).toBeUndefined()
    h.w.sessions = [{ id: 'leader2', harness: 'claude', role: 'leader', alive: true, cwd: '/r', worktree: false, taskId: 't1', createdAt: '2026-11-07T02:00:00Z' }]
    h.advance(31 * 60_000)
    expect((await h.svc.tick()).actions).toEqual(['wake s9'])
    expect(h.calls.session.at(-1)!.id).toBe('leader2')
  })

  test('the leader filed on the piece wins over the task\'s newest leader', async () => {
    const h = harness({ blocked: [orphan()], sessions: [
      { id: 'newest', harness: 'claude', role: 'leader', alive: true, cwd: '/r', worktree: false, taskId: 't1', createdAt: '2026-11-07T01:59:00Z' },
      { id: 'filed', harness: 'claude', role: 'leader', alive: true, cwd: '/r', worktree: false, taskId: 't1', subtaskId: 's9', createdAt: '2026-11-07T01:00:00Z' },
      { id: 'dead', harness: 'claude', role: 'leader', alive: false, cwd: '/r', worktree: false, taskId: 't1', subtaskId: 's9', createdAt: '2026-11-07T01:58:00Z' },
    ] })
    await h.svc.tick()
    expect((await h.svc.get('s9'))!.leaderSessionId).toBe('filed')
  })

  test('a piece that already has a record is never re-adopted or touched', async () => {
    const h = harness({ blocked: [orphan({ id: 's1', since: '2026-10-25T12:00:00Z' })] })
    await h.svc.ensure('s1')
    const before = (await h.svc.get('s1'))!
    expect((await h.svc.tick()).actions).toEqual([])
    expect(await h.svc.get('s1')).toEqual(before)
  })

  test('an unfinished dependency is adopted as dependencia: the leader is not nagged, and it unblocks by itself', async () => {
    const h = harness({ blocked: [orphan({ id: 's2', blockedBy: ['s1'] })], status: 'todo' })
    const t = await h.svc.tick()
    expect(t.actions).toEqual(['adopt s2'])
    expect((await h.svc.get('s2'))!.block).toMatchObject({ reason: 'dependencia', unlocker: 'self' })
    expect(h.calls.session).toEqual([])
  })

  // ------------------------------------------------------------------------------------------------ r2 (QA findings)

  test('1 · a blocked TASK with no subtasks is a piece of its own, keyed by the task id, chased and deferred like the rest', async () => {
    const h = harness({ blocked: [orphan({ id: 't7', taskId: 't7', title: 'tarefa sozinha', since: '2026-11-07T01:00:00Z' })], sessions: [{ id: 'leader', harness: 'claude', role: 'leader', alive: true, cwd: '/r', worktree: false, taskId: 't7' }] })
    expect((await h.svc.tick()).actions).toEqual(['adopt t7', 'wake t7'])
    expect(await h.svc.get('t7')).toMatchObject({ subtaskId: 't7', taskId: 't7', phase: 'bloqueado', adopted: 'board' })
    h.advance(2 * 3600_000)
    expect((await h.svc.tick()).actions).toEqual(['defer t7'])
    expect(h.calls.status).toContainEqual({ id: 't7', phase: 'fila' })
  })

  test('1 · blockedPiecesOf lists a task only when it has no subtasks of its own, and never a closed piece', () => {
    const t = (id: string, status: string, over: Record<string, unknown> = {}) => ({ id, title: id, status, updatedAt: '2026-11-01T00:00:00Z', ...over })
    const s = (id: string, taskId: string, status: string, over: Record<string, unknown> = {}) => ({ id, taskId, title: id, status, updatedAt: '2026-11-02T00:00:00Z', ...over })
    const out = blockedPiecesOf({
      tasks: [t('t1', 'blocked', { blockedReason: 'esperando a chave' }), t('t2', 'blocked'), t('t3', 'done'), t('t4', 'blocked')],
      subtasks: [s('s1', 't2', 'in_progress'), s('s2', 't3', 'blocked')],
    })
    expect(out.map(p => p.id)).toEqual(['t1', 't4', 's2'])
    expect(out.find(p => p.id === 't1')).toMatchObject({ taskId: 't1', reason: 'esperando a chave', groupMember: false })
  })

  test('2 · sixty blocked pieces are ONE message to the leader per tick, adoption is capped and the rest comes on the next ticks', async () => {
    const h = harness({ blocked: Array.from({ length: 60 }, (_, i) => orphan({ id: `s${100 + i}`, title: `peça ${i}` })) })
    const first = await h.svc.tick()
    expect(first.actions.filter(a => a.startsWith('adopt '))).toHaveLength(20)
    expect(h.calls.session).toHaveLength(1)
    expect(h.calls.session[0]!.text).toContain('20 peças bloqueadas')
    expect(h.calls.session[0]!.text).toContain('e mais 15')
    expect(h.calls.owner).toEqual([])
    // The next tick adopts the next batch and sends one more message — the first batch is not woken again inside 30 min.
    const second = await h.svc.tick()
    expect(second.actions.filter(a => a.startsWith('adopt '))).toHaveLength(20)
    expect(h.calls.session).toHaveLength(2)
    expect((await h.svc.list()).length).toBe(40)
  })

  test('2 · no leader for a whole batch is ONE bell, not one per piece', async () => {
    const h = harness({ blocked: [orphan({ id: 's1' }), orphan({ id: 's2' }), orphan({ id: 's3' })], sessions: [] })
    await h.svc.tick()
    expect(h.calls.owner).toHaveLength(1)
    expect(h.calls.owner[0]!.text).toContain('3 peças')
  })

  test('3 · an adopted piece the board moved to done/abandoned leaves the flow quietly: record dropped, nothing said, nothing woken', async () => {
    for (const status of ['done', 'abandoned']) {
      const h = harness({ blocked: [orphan({ id: 's1' })] })
      await h.svc.tick()
      const said = { comments: h.calls.comments.length, session: h.calls.session.length }
      h.w.blocked = []
      h.w.status = status
      h.advance(31 * 60_000)
      expect((await h.svc.tick()).actions).toEqual([])
      expect(await h.svc.get('s1')).toBeNull()
      expect({ comments: h.calls.comments.length, session: h.calls.session.length }).toEqual(said)
    }
  })

  test('3 · an adopted piece unblocked on the board is dropped (no leftover record) and the board status is left as the person set it', async () => {
    const h = harness({ blocked: [orphan({ id: 's1' })] })
    await h.svc.tick()
    h.w.blocked = []
    h.w.status = 'in_progress'
    h.advance(31 * 60_000)
    expect((await h.svc.tick()).actions).toEqual(['released s1'])
    expect(await h.svc.get('s1')).toBeNull()
    expect(h.calls.status).toEqual([])
    expect(h.calls.session).toHaveLength(1)
  })

  test('3 · a board that cannot be read never drops or releases an adopted piece', async () => {
    const h = harness({ blocked: [orphan({ id: 's1' })] })
    await h.svc.tick()
    h.w.status = 'done'
    const down = createDeliveryService({
      store: createDeliveryStore(join(dir, 'deliveries.json')),
      facts: { blockedSubtasks: async () => { throw new Error('board down') }, pieceStatus: async () => 'done', subtask: async () => null, sessions: async () => h.w.sessions, budgets: async () => [], memoryBytes: async () => null, topCap: async () => 2, git: async () => '', gh: async () => '{}' },
      board: { setPhaseStatus: async () => ({ ok: true }), setCi: async () => {}, logStep: async () => {}, comment: async () => {}, subtaskFinished: async () => false, stage: async () => ({ ok: true }) },
      notify: { session: async () => true, owner: async () => {} }, autonomous: async () => true, emit: async () => {},
      now: () => Date.parse('2026-11-07T02:05:00Z'),
    })
    await down.tick()
    expect(await down.get('s1')).toMatchObject({ phase: 'bloqueado' })
  })

  test('4 · a leader that died after adoption is replaced before the wake, and a failed wake waits its 30 minutes instead of repeating every minute', async () => {
    const h = harness({ blocked: [orphan()] })
    await h.svc.tick()
    h.w.sessions = [{ id: 'replacement', harness: 'claude', role: 'leader', alive: true, cwd: '/r', worktree: false, taskId: 't1' }]
    h.w.wakeOk = false
    h.advance(31 * 60_000)
    expect((await h.svc.tick()).actions).toEqual(['wake-failed s9'])
    expect(h.calls.session.at(-1)!.id).toBe('replacement')
    expect((await h.svc.get('s9'))!.leaderSessionId).toBe('replacement')
    const tried = h.calls.session.length
    for (let i = 0; i < 5; i++) { h.advance(60_000); expect((await h.svc.tick()).actions).toEqual([]) }
    expect(h.calls.session).toHaveLength(tried)
    h.w.wakeOk = true
    h.advance(30 * 60_000)
    expect((await h.svc.tick()).actions).toEqual(['wake s9'])
  })

  test('4 · with a dead leader and no replacement the wake is still tried (once per cadence)', async () => {
    const h = harness({ blocked: [orphan()] })
    await h.svc.tick()
    h.w.sessions = []
    h.w.wakeOk = false
    h.advance(31 * 60_000)
    expect((await h.svc.tick()).actions).toEqual(['wake-failed s9'])
    h.advance(60_000)
    expect((await h.svc.tick()).actions).toEqual([])
  })

  test('5 · a deferral takes the piece OUT of Bloqueado: back to fila, next batch, the block kept as history, the board follows, one wake', async () => {
    const h = harness({ blocked: [orphan({ title: 'peça antiga', reason: 'esperando o token' })] })
    await h.svc.tick()
    const woken = h.calls.session.length
    h.advance(121 * 60_000)
    expect((await h.svc.tick()).actions).toEqual(['defer s9'])
    expect(await h.svc.get('s9')).toMatchObject({ phase: 'fila', versionTarget: 'next', block: { text: 'esperando o token', deferredAt: expect.any(String) } })
    expect((await h.svc.get('s9'))!.origin).toBeUndefined()
    expect(h.calls.status).toContainEqual({ id: 's9', phase: 'fila' })
    expect(h.calls.comments.some(c => /adiada para o próximo lote \(bloqueio de 2 h: esperando o token\)/.test(c))).toBe(true)
    expect(h.calls.session).toHaveLength(woken + 1)
    // Out of Bloqueado, nobody chases it again, and the board still listing it blocked does not re-adopt it.
    h.advance(3 * 3600_000)
    expect((await h.svc.tick()).actions).toEqual([])
    expect(h.calls.session).toHaveLength(woken + 1)
  })

  test('5 · the same rule holds for a FLOW piece blocked inside the flow', async () => {
    const h = harness()
    await h.svc.configure('s1', { leaderSessionId: 'leader' }, 'owner')
    expect((await h.svc.transition('s1', 'executando', {}, 'leader')).ok).toBe(true)
    expect((await h.svc.block('s1', 'externo', 'o CI está fora do ar', 'leader')).ok).toBe(true)
    h.advance(121 * 60_000)
    const t = await h.svc.tick()
    expect(t.actions).toContain('defer s1')
    expect(await h.svc.get('s1')).toMatchObject({ phase: 'fila', versionTarget: 'next' })
    expect(h.calls.status.at(-1)).toEqual({ id: 's1', phase: 'fila' })
  })

  test('5 · a deferred adopted piece the board blocks AGAIN later is chased afresh', async () => {
    const h = harness({ blocked: [orphan({ since: '2026-11-07T01:00:00Z' })] })
    await h.svc.tick()
    h.advance(3 * 3600_000)
    await h.svc.tick()
    expect((await h.svc.get('s9'))!.phase).toBe('fila')
    h.w.blocked = [orphan({ since: new Date(Date.parse('2026-11-07T02:00:00Z') + 3.5 * 3600_000).toISOString() })]
    h.advance(3600_000)
    expect((await h.svc.tick()).actions).toContain('adopt s9')
    expect((await h.svc.get('s9'))!.phase).toBe('bloqueado')
  })

  test('6 · a group member is never adopted as its own delivery', async () => {
    const h = harness({ blocked: [orphan({ id: 's5', groupMember: true }), orphan({ id: 's6' })] })
    const t = await h.svc.tick()
    expect(t.actions.filter(a => a.startsWith('adopt'))).toEqual(['adopt s6'])
    expect(await h.svc.get('s5')).toBeNull()
  })

  test('6 · a blocked member counts for its GROUP piece (the Live card), and a closed group is not chased', () => {
    const s = (id: string, status: string, over: Record<string, unknown> = {}) => ({ id, taskId: 't1', title: id, status, updatedAt: '2026-11-02T00:00:00Z', ...over })
    const out = blockedPiecesOf({
      tasks: [],
      subtasks: [
        s('g1', 'in_progress', { isGroup: true }), s('m1', 'blocked', { parentGroupId: 'g1', updatedAt: '2026-11-03T00:00:00Z' }), s('m2', 'blocked', { parentGroupId: 'g1', updatedAt: '2026-11-01T00:00:00Z' }),
        s('g2', 'done', { isGroup: true }), s('m3', 'blocked', { parentGroupId: 'g2' }),
      ],
    })
    expect(out.map(p => p.id)).toEqual(['g1'])
    expect(out[0]).toMatchObject({ groupMember: false, since: '2026-11-01T00:00:00Z' })
  })

  // ------------------------------------------------------------------------------------------------ r3 (re-QA findings)

  test('r3 · 1 · an adopted piece that entered the real flow keeps its record when the board later reads done', async () => {
    const h = harness({ blocked: [orphan({ id: 's1' })] })
    await h.svc.tick()
    expect((await h.svc.get('s1'))!.adopted).toBe('board')
    expect((await h.svc.unblock('s1', 'leader')).ok).toBe(true)
    await walkToQa(h.svc) // fila → executando → qa: head sha + gate evidence
    expect((await h.svc.block('s1', 'externo', 'o CI está fora do ar', 'leader')).ok).toBe(true)
    h.w.blocked = []
    h.w.status = 'done'
    await h.svc.tick()
    const rec = (await h.svc.get('s1'))!
    expect(rec).not.toBeNull()
    expect(rec.headSha).toBe('abc123')
    expect(rec.adopted).toBeUndefined()
    expect(rec.history.map(x => x.to)).toContain('qa')
    expect(rec.phase).toBe('bloqueado')
  })

  test('r3 · 1 · a record that still carries the adoption marker but has real history is never dropped, and loses the marker', async () => {
    const h = harness({ blocked: [orphan({ id: 's1' })] })
    await h.svc.tick()
    expect((await h.svc.unblock('s1', 'leader')).ok).toBe(true)
    await walkToQa(h.svc)
    expect((await h.svc.block('s1', 'externo', 'preso', 'leader')).ok).toBe(true)
    // a record written by an older build: the flow history is real, the marker was never cleared
    await createDeliveryStore(join(dir, 'deliveries.json')).update(d => { d.deliveries.s1!.adopted = 'board' })
    h.w.blocked = []
    h.w.status = 'abandoned'
    await h.svc.tick()
    const rec = (await h.svc.get('s1'))!
    expect(rec).not.toBeNull()
    expect(rec.headSha).toBe('abc123')
    expect(rec.adopted).toBeUndefined()
  })

  test('r3 · 2 · a failed board write on a deferral is retried on the next tick — silently, once per tick — until it lands', async () => {
    const h = harness({ blocked: [orphan({ id: 't7', taskId: 't7', title: 'tarefa sozinha', since: '2026-11-07T01:00:00Z' })], sessions: [{ id: 'leader', harness: 'claude', role: 'leader', alive: true, cwd: '/r', worktree: false, taskId: 't7' }] })
    await h.svc.tick()
    h.w.boardWriteFails = true
    h.advance(2 * 3600_000)
    expect((await h.svc.tick()).actions).toEqual(['defer t7'])
    expect((await h.svc.get('t7'))!.phase).toBe('fila')
    const writes = h.calls.status.length, comments = h.calls.comments.length, wakes = h.calls.session.length
    h.advance(60_000)
    expect((await h.svc.tick()).actions).toEqual([]) // refused again: still pending, nothing said
    expect(h.calls.status.length).toBe(writes + 1)
    expect(h.calls.comments.length).toBe(comments)
    expect(h.calls.session.length).toBe(wakes)
    h.w.boardWriteFails = false
    h.advance(60_000)
    expect((await h.svc.tick()).actions).toEqual(['requeue t7'])
    expect(h.calls.status.at(-1)).toEqual({ id: 't7', phase: 'fila' })
    const after = h.calls.status.length
    h.advance(60_000)
    expect((await h.svc.tick()).actions).toEqual([])
    expect(h.calls.status.length).toBe(after) // landed: no more writes
    expect(h.calls.comments.length).toBe(comments)
    expect(h.calls.session.length).toBe(wakes)
  })

  test('r4 · a board move the board keeps refusing is retried a capped number of ticks, then dropped with ONE notice (no loop)', async () => {
    const h = harness({ blocked: [orphan({ id: 't7', taskId: 't7', title: 'tarefa sozinha', since: '2026-11-07T01:00:00Z' })], sessions: [{ id: 'leader', harness: 'claude', role: 'leader', alive: true, cwd: '/r', worktree: false, taskId: 't7' }] })
    await h.svc.tick()
    h.w.boardWriteFails = true
    h.advance(2 * 3600_000)
    expect((await h.svc.tick()).actions).toEqual(['defer t7'])
    const wakes = h.calls.session.length, comments = h.calls.comments.length
    let gaveUp = 0
    for (let i = 0; i < 30; i++) {
      h.advance(60_000)
      gaveUp += (await h.svc.tick()).actions.filter(a => a === 'requeue-gave-up t7').length
    }
    expect(gaveUp).toBe(1)
    expect((await h.svc.get('t7'))!.block!.boardMovePending).toBeUndefined()
    expect(h.calls.session.length).toBe(wakes + 1) // exactly one notice to the leader
    expect(h.calls.comments.length).toBe(comments)
    const writes = h.calls.status.length
    h.advance(60_000)
    await h.svc.tick()
    expect(h.calls.status.length).toBe(writes) // no more writes after the cap
  })

  test('r4 · a pure adoption the board releases to In review is dropped, and a later board block is adopted afresh', async () => {
    const h = harness({ blocked: [orphan({ id: 's1' })] })
    await h.svc.tick()
    h.w.blocked = []
    h.w.status = 'in_review'
    h.advance(60_000)
    expect((await h.svc.tick()).actions).toEqual(['released s1'])
    expect(await h.svc.get('s1')).toBeNull()
  })

  test('r3 · 3 · a blocked task keeps its blockedBy: discovery carries it, and adoption waits for the dependency instead of waking the leader', async () => {
    const t = { id: 't7', title: 't7', status: 'blocked', updatedAt: '2026-11-07T01:50:00Z', blockedBy: ['t0'] }
    const [piece] = blockedPiecesOf({ tasks: [t], subtasks: [] })
    expect(piece).toMatchObject({ id: 't7', blockedBy: ['t0'] })
    const h = harness({ blocked: [piece!], sessions: [{ id: 'leader', harness: 'claude', role: 'leader', alive: true, cwd: '/r', worktree: false, taskId: 't7' }] })
    expect((await h.svc.tick()).actions).toEqual(['adopt t7'])
    expect((await h.svc.get('t7'))!.block).toMatchObject({ reason: 'dependencia', unlocker: 'self' })
    expect(h.calls.session).toEqual([])
    // the dependency finishes: the completed-dependency reconciliation unblocks the task-level record by itself
    h.w.finished = ['t0']
    h.advance(60_000)
    expect((await h.svc.tick()).actions).toContain('unblock t7')
    expect((await h.svc.get('t7'))!.phase).toBe('fila')
  })
})

describe('HOSTILE r3 re-QA (Opus) — BLOQUEIO.ORFAO', () => {
  const orphan = (over: Partial<BlockedSubtaskFact> = {}): BlockedSubtaskFact => ({ id: 's9', taskId: 't1', title: 'peça antiga', blockedBy: [], groupMember: false, since: '2026-11-07T01:50:00Z', ...over })

  test('HQ1 · a real flow block whose board piece the person CLOSED is never reopened on the board by the 2 h deferral', async () => {
    const h = harness()
    await walkToQa(h.svc)
    expect((await h.svc.block('s1', 'externo', 'CI fora do ar', 'leader')).ok).toBe(true)
    h.w.status = 'done' // the person closed it on the board
    const before = h.calls.status.length
    h.advance(2 * 3600_000 + 60_000)
    await h.svc.tick()
    expect(h.calls.status.slice(before).filter(s => s.id === 's1')).toEqual([])
  })

  test('HQ1b · same through adoption: adopt → unblock → real flow → block → board done → deferral must not reopen it', async () => {
    const h = harness({ blocked: [orphan({ id: 's1' })] })
    await h.svc.tick()
    expect((await h.svc.unblock('s1', 'leader')).ok).toBe(true)
    await walkToQa(h.svc)
    expect((await h.svc.block('s1', 'externo', 'preso', 'leader')).ok).toBe(true)
    h.w.blocked = []
    h.w.status = 'done'
    await h.svc.tick()
    expect(await h.svc.get('s1')).not.toBeNull() // r3 fix holds: real history kept
    const before = h.calls.status.length
    h.advance(2 * 3600_000 + 60_000)
    await h.svc.tick()
    expect((await h.svc.get('s1'))!.headSha).toBe('abc123')
    expect(h.calls.status.slice(before).filter(s => s.id === 's1')).toEqual([])
  })

  test('HQ2 · a pure adoption released by the board, then blocked on the board AGAIN, is chased afresh', async () => {
    const h = harness({ blocked: [orphan({ id: 's1' })] })
    await h.svc.tick()
    h.w.blocked = []
    h.w.status = 'todo'
    h.advance(60_000)
    expect((await h.svc.tick()).actions).toEqual(['released s1'])
    h.advance(3600_000) // 03:01
    h.w.status = 'blocked'
    h.w.blocked = [orphan({ id: 's1', since: '2026-11-07T03:00:00Z' })]
    const t = await h.svc.tick()
    expect(t.actions).toContain('adopt s1')
    expect((await h.svc.get('s1'))!.phase).toBe('bloqueado')
  })

  test('HQ3 · boardMovePending: the board piece goes done meanwhile → the flag clears, no write, nothing said (expected to pass)', async () => {
    const h = harness({ blocked: [orphan({ id: 't7', taskId: 't7', title: 'tarefa sozinha', since: '2026-11-07T01:00:00Z' })], sessions: [{ id: 'leader', harness: 'claude', role: 'leader', alive: true, cwd: '/r', worktree: false, taskId: 't7' }] })
    await h.svc.tick()
    h.w.boardWriteFails = true
    h.advance(2 * 3600_000)
    expect((await h.svc.tick()).actions).toEqual(['defer t7'])
    expect((await h.svc.get('t7'))!.block!.boardMovePending).toBe(true)
    const writes = h.calls.status.length, comments = h.calls.comments.length, wakes = h.calls.session.length
    h.w.blocked = [] // closed on the board
    h.advance(60_000)
    expect((await h.svc.tick()).actions).toEqual([])
    expect((await h.svc.get('t7'))!.block!.boardMovePending).toBeUndefined()
    expect(h.calls.status.length).toBe(writes)
    expect(h.calls.comments.length).toBe(comments)
    expect(h.calls.session.length).toBe(wakes)
  })

  test('HQ4 · pure → real → defers again → board done: record kept, no adoption marker, never dropped (expected to pass)', async () => {
    const h = harness({ blocked: [orphan({ id: 's1' })] })
    await h.svc.tick()
    expect((await h.svc.unblock('s1', 'leader')).ok).toBe(true)
    await walkToQa(h.svc)
    expect((await h.svc.block('s1', 'externo', 'preso', 'leader')).ok).toBe(true)
    h.w.blocked = []
    h.advance(2 * 3600_000 + 60_000)
    expect((await h.svc.tick()).actions).toContain('defer s1')
    const r = (await h.svc.get('s1'))!
    expect(r).toMatchObject({ phase: 'fila', versionTarget: 'next', headSha: 'abc123' })
    expect(r.adopted).toBeUndefined()
    h.w.status = 'done'
    h.advance(60_000)
    await h.svc.tick()
    expect(await h.svc.get('s1')).not.toBeNull()
  })

  // LOW-2 (r3 re-QA): a dependency-blocked adoption deferred after 2 h. Leader decision r4: leave as is (the deferral rule predates
  // this branch); the pre-dispatch gap is documented, not fixed here.
  test.skip('HQ5 · a piece adopted on an UNFINISHED dependency is not put back in the queue (board To do) while that dependency is open', async () => {
    const h = harness({ blocked: [orphan({ id: 's2', blockedBy: ['s1'], since: '2026-10-25T12:00:00Z' })] })
    await h.svc.tick()
    expect(h.calls.status.filter(s => s.id === 's2')).toEqual([])
    expect((await h.svc.get('s2'))!.phase).toBe('bloqueado')
  })
})
