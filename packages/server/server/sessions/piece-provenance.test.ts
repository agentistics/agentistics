/**
 * LIVE.COLUNAS-PRESAS (flow side) — the piece learns where its work lives while its worker is still registered, so the proof
 * of publication never depends on the live registry (fechar-entregue ends the worker right after its handback).
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeProvenance, recordPieceProvenance, type ProvenanceDeps } from './piece-provenance'
import { createTaskStore } from './task-store'
import { unattributedContext } from '../delivery/guard'
import { deliveredShasIn } from './task-live'
import { existsSync } from 'node:fs'
import type { Subtask, SubtaskProvenance } from './task-model'

const HEAD = 'b'.repeat(40)
const DECLARED = '8acbd8cd82f9d75dd1c7e3142cb94358ab2bfb52'
const sub = (extra: Partial<Subtask> = {}): Subtask => ({ id: 's-1', taskId: 't-1', title: 'piece', done: false, status: 'in_review', createdAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z', ...extra })

function deps(over: Partial<ProvenanceDeps> = {}, store: { written?: SubtaskProvenance; sub?: Subtask } = {}): ProvenanceDeps {
  return {
    git: async (_cwd, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'fix/navegador-s6'
      if (args.join(' ') === 'rev-parse HEAD') return HEAD
      if (args.includes('origin/main') && args[0] === 'rev-parse') return 'c'.repeat(40)
      if (args[0] === 'merge-base') return null // the tip is NOT on the release line yet
      if (args[0] === 'rev-parse' && args.at(-1) === '8acbd8cd8^{commit}') return DECLARED
      return null
    },
    exists: existsSync,
    declared: deliveredShasIn,
    repoOf: async () => 'agentistics/agentistics',
    subtask: async () => store.sub ?? sub(),
    handbacks: async () => ['Entrega S6. Commit 8acbd8cd8, testes 264/0.'],
    write: async (_id, p) => { store.written = p },
    now: () => '2026-11-23T12:00:00.000Z',
    ...over,
  }
}

describe('recordPieceProvenance', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'prov-'))
  test('a worker filed on a piece stamps repo, branch, its own tip and the declared commit (resolved to the full id)', async () => {
    const box: { written?: SubtaskProvenance } = {}
    await recordPieceProvenance({ id: 'w1', subtaskId: 's-1', cwd }, deps({}, box))
    expect(box.written).toEqual({ repos: ['agentistics/agentistics'], branches: ['fix/navegador-s6'], commits: [HEAD, DECLARED], at: '2026-11-23T12:00:00.000Z' })
  })
  test('the spawn record names the repository even when the checkout is gone', async () => {
    const box: { written?: SubtaskProvenance } = {}
    await recordPieceProvenance({ id: 'w1', subtaskId: 's-1', cwd: join(cwd, 'removed'), repo: { repo: 'agentistics/agentistics' } }, deps({}, box))
    expect(box.written?.repos).toEqual(['agentistics/agentistics'])
    expect(box.written?.commits).toEqual([])
  })
  test('a leader, a row with no piece, or nothing new writes nothing; a failing store never throws', async () => {
    const box: { written?: SubtaskProvenance } = {}
    expect(await recordPieceProvenance({ id: 'l', subtaskId: 's-1', cwd, role: 'leader' }, deps({}, box))).toBeNull()
    expect(await recordPieceProvenance({ id: 'w', cwd }, deps({}, box))).toBeNull()
    const already = { repos: ['agentistics/agentistics'], branches: ['fix/navegador-s6'], commits: [HEAD, DECLARED], at: 'x' }
    expect(await recordPieceProvenance({ id: 'w', subtaskId: 's-1', cwd }, deps({}, { sub: sub({ provenance: already }) }))).toBeNull()
    expect(box.written).toBeUndefined()
    expect(await recordPieceProvenance({ id: 'w', subtaskId: 's-1', cwd }, deps({ write: async () => { throw new Error('locked') } }))).toBeNull()
  })
  test('a tip already on the release line is not the piece\'s work', async () => {
    const box: { written?: SubtaskProvenance } = {}
    await recordPieceProvenance({ id: 'w1', subtaskId: 's-1', cwd }, deps({ handbacks: async () => [], git: async (_c, args) => args[0] === 'merge-base' ? '' : args.join(' ') === 'rev-parse HEAD' ? HEAD : args.includes('origin/main') ? 'c'.repeat(40) : null }, box))
    expect(box.written?.commits ?? []).toEqual([])
  })
  test('mergeProvenance keeps the newest, without duplicates, bounded', () => {
    const p = mergeProvenance({ repos: ['a/b'], branches: [], commits: [HEAD], at: 'x' }, { repos: ['a/b'], branches: ['f'], commits: [HEAD, DECLARED] }, 'y')
    expect(p).toEqual({ repos: ['a/b'], branches: ['f'], commits: [HEAD, DECLARED], at: 'y' })
  })
  test('the board store keeps the stamp across a read (the subtask whitelist carries it)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prov-store-'))
    try {
      const store = createTaskStore(join(dir, 'tasks.json'))
      await store.upsertTask({ id: 't-1', title: 'task', status: 'in_progress', createdAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z' } as never, unattributedContext())
      await store.upsertSubtask(sub({ provenance: { repos: ['agentistics/agentistics'], branches: ['fix/x'], commits: [DECLARED, 'not-a-sha'], at: 'z' } }), unattributedContext())
      expect((await store.read()).subtasks[0]?.provenance).toEqual({ repos: ['agentistics/agentistics'], branches: ['fix/x'], commits: [DECLARED], at: 'z' })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  afterAll(() => rmSync(cwd, { recursive: true, force: true }))
})
