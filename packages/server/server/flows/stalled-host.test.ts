import { expect, test } from 'bun:test'
import { stalledHostOps, type StalledHostDeps } from './stalled-host'
import type { ManagedSession } from '../sessions/types'

function fixture() {
  let now = 1_800_000
  const rows = [
    { id: 'worker', cwd: '/Users/fixture/work tree', parentSessionId: 'old', taskId: 'task', subtaskId: 'sub' },
    { id: 'old', cwd: '/Users/fixture', endedAt: 'retired', handoffTo: 'leader' },
    { id: 'leader', cwd: '/Users/fixture' },
  ] as ManagedSession[]
  const notices: unknown[] = []
  const d: StalledHostDeps = {
    registry: async () => rows,
    snapshot: async () => ({ polledAtMs: now, sessions: [{ id: 'worker', cwd: rows[0]!.cwd, status: 'running', activity: 'waiting', attached: false, lastLines: ['waiting'], chatTurns: [{ role: 'assistant', text: 'Ready for next phase', at: '2026-11-06T00:00:00Z' }] }] }),
    role: async r => r.id === 'worker' ? 'worker' : 'leader',
    dirty: async () => true,
    message: async (...args) => { notices.push(args); return { ok: true } },
    now: () => now,
  }
  return { d, rows, notices, advance: (ms: number) => { now += ms } }
}

test('observes worker and current leader, bounded transcript text, dirty state and unknown account limit on macOS paths', async () => {
  const { d } = fixture()
  expect(await stalledHostOps(d)['observar-sessao-parada']({ sessionId: 'worker' })).toMatchObject({ ok: true, leaderId: 'leader', state: 'waiting', lastText: 'Ready for next phase', dirty: true, accountLimit: null, taskId: 'task', subtaskId: 'sub' })
})

test('refuses unknown, ended and leader targets; stale, failed and missing activity observations', async () => {
  const { d, rows } = fixture()
  const op = stalledHostOps(d)['observar-sessao-parada']
  for (const id of ['', 'unknown', 'leader']) expect(await op({ sessionId: id })).toMatchObject({ refused: true })
  rows[0]!.endedAt = 'ended'
  expect(await op({ sessionId: 'worker' })).toMatchObject({ refused: true })
  delete rows[0]!.endedAt
  d.snapshot = async () => ({ polledAtMs: 1, sessions: [] })
  expect(await op({ sessionId: 'worker' })).toMatchObject({ refused: true })
  d.snapshot = async () => ({ polledAtMs: d.now(), sessions: [], unavailable: 'poll failed' })
  expect(await op({ sessionId: 'worker' })).toMatchObject({ refused: true })
  d.snapshot = async () => ({ polledAtMs: d.now(), sessions: [] })
  expect(await op({ sessionId: 'worker' })).toMatchObject({ refused: true })
})

test('notices are block messages to freshly resolved parent, delivery refusal is preserved', async () => {
  const { d, rows, notices } = fixture()
  const op = stalledHostOps(d)['avisar-sessao-parada']
  rows[2]!.handoffTo = 'successor'
  rows.push({ id: 'successor', cwd: '/Users/fixture' } as ManagedSession)
  expect(await op({ sessionId: 'worker', body: 'Choose resume or save and close.' })).toEqual({ ok: true, to: 'successor' })
  expect(notices).toEqual([['worker', 'successor', 'Choose resume or save and close.']])
  d.message = async () => ({ ok: false, code: 'target_blocked', message: 'approval open' })
  expect(await op({ sessionId: 'worker', body: 'retry' })).toMatchObject({ refused: true, code: 'target_blocked' })
})
