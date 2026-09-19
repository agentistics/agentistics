import { describe, expect, it } from 'bun:test'
import { attemptReopenRow, type ReopenAttemptDeps } from './reopen-attempt'
import { resetResumeLocks, withResumeLock } from './resume-lock'
import type { ManagedSession } from './types'

/**
 * A tiny SHARED, mutable "registry" two attempts can race over — exactly what a real reopen and a
 * racing one share (the real registry file, the real backend). `freshState` always reads whatever is
 * in it AT THE MOMENT it is called, which is what makes the ordering test below meaningful: if the
 * first attempt's `spawn` has already run, the second attempt's `freshState` sees its row.
 */
function sharedStore() {
  const rows: ManagedSession[] = []
  const alive = new Set<string>()
  return {
    rows,
    alive,
    freshState: async () => ({ entries: [...rows], aliveIds: new Set(alive) }),
  }
}

function makeDeps(
  store: ReturnType<typeof sharedStore>,
  newId: string,
  conversationId: string,
  onSpawn?: () => void,
): ReopenAttemptDeps {
  return {
    freshState: store.freshState,
    holderOf: async () => ({ id: 'winner-row', label: 'the one that landed first', kind: 'managed' as const }),
    spawn: async () => {
      onSpawn?.()
      store.rows.push({
        id: newId, harness: 'claude', cwd: '/repo', createdAt: '2026-08-13T10:00:00.000Z', conversationId,
      })
      store.alive.add(newId)
      return { ok: true, id: newId }
    },
    onSpawned: async () => {},
  }
}

describe('attemptReopenRow, driven through the real resume lock', () => {
  it('two concurrent attempts for the SAME conversation: exactly one spawns, the loser is held', async () => {
    // This is the seam the review asked for: a test that drives two concurrent reopens of one
    // conversation through the SAME mechanism `reopenEntries` uses (withResumeLock +
    // attemptReopenRow), rather than trusting a live replay alone.
    resetResumeLocks()
    const store = sharedStore()
    let spawnCalls = 0
    const spawn = () => { spawnCalls++ }

    const [r1, r2] = await Promise.all([
      withResumeLock('conv-1', () => attemptReopenRow('conv-1', 'old-row', makeDeps(store, 'new-1', 'conv-1', spawn))),
      withResumeLock('conv-1', () => attemptReopenRow('conv-1', 'old-row', makeDeps(store, 'new-2', 'conv-1', spawn))),
    ])

    expect(spawnCalls).toBe(1)
    expect([r1.kind, r2.kind].sort()).toEqual(['held', 'opened'])
    // And the loser names who has it — the exact shape `reopenEntries` reports into `heldElsewhere`.
    const loser = r1.kind === 'held' ? r1 : r2
    expect(loser).toEqual({ kind: 'held', holder: { id: 'winner-row', label: 'the one that landed first', kind: 'managed' } })
  })

  it('two DIFFERENT conversations never block each other', async () => {
    resetResumeLocks()
    const store = sharedStore()
    let spawnCalls = 0
    const spawn = () => { spawnCalls++ }

    const [r1, r2] = await Promise.all([
      withResumeLock('conv-a', () => attemptReopenRow('conv-a', 'old-a', makeDeps(store, 'new-a', 'conv-a', spawn))),
      withResumeLock('conv-b', () => attemptReopenRow('conv-b', 'old-b', makeDeps(store, 'new-b', 'conv-b', spawn))),
    ])

    expect(spawnCalls).toBe(2)
    expect(r1.kind).toBe('opened')
    expect(r2.kind).toBe('opened')
  })

  it('WITHOUT the lock, the exact regression: both attempts spawn into the same conversation', async () => {
    // Not a test of `reopenEntries` itself (a large I/O-orchestration function with no direct unit
    // tests, same pattern as the rest of `cli-start.ts`) — but a demonstration, through the same
    // seam, of precisely what a revert of the `withResumeLock` wrapping there would reintroduce.
    const store = sharedStore()
    let spawnCalls = 0
    const spawn = () => { spawnCalls++ }

    const [r1, r2] = await Promise.all([
      attemptReopenRow('conv-2', 'old-row', makeDeps(store, 'new-3', 'conv-2', spawn)),
      attemptReopenRow('conv-2', 'old-row', makeDeps(store, 'new-4', 'conv-2', spawn)),
    ])

    expect(spawnCalls).toBe(2)
    expect(r1.kind).toBe('opened')
    expect(r2.kind).toBe('opened')
  })
})
