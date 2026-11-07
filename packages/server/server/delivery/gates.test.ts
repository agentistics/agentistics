import { expect, test } from 'bun:test'
import { judgeVaga, runningSessionIds, type SessionFact } from './gates'
import type { BackendSession, ManagedSession } from '../sessions/types'

test('lost rows without endedAt and exited/closed rows do not consume vacancy', () => {
  const registry = [...Array.from({ length: 79 }, (_, i) => ({ id: `lost${i}` })),
    { id: 'working' }, { id: 'waiting' }, { id: 'approval' }, { id: 'exited' }, { id: 'closed', endedAt: '2026-11-07T00:00:00Z' },
  ] as ManagedSession[]
  const backend = ['working', 'waiting', 'approval', 'closed', 'exited'].map(id => ({ id, alive: id !== 'exited' })) as BackendSession[]
  const running = runningSessionIds(registry, backend)
  expect([...running]).toEqual(['working', 'waiting', 'approval'])
  const sessions = registry.map(m => ({ id: m.id, role: 'worker', alive: running.has(m.id), harness: 'codex', cwd: '/r', worktree: true })) as SessionFact[]
  expect(judgeVaga({ id: 's', taskId: 't', title: 's', status: 'todo', groupMember: false, blockedBy: [], staged: { harness: 'codex', account: 'default' } }, {
    sessions, budgets: [{ harness: 'codex', account: 'default', fiveHourPct: 10, weekPct: 10, stale: false }], memoryBytes: 8 * 1024 ** 3, topCap: 1,
  }).ok).toBe(true)
})
