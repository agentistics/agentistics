import { describe, expect, test } from 'bun:test'
import { handOverDetached } from './server-restart-io'

/** A fake process table: pids that exit after N polls, and a lock held while any of them lives. */
function world(exitAfterPolls: Record<number, number | 'never' | 'on-kill'>) {
  const killed: Array<[number, string]> = []
  const polls: Record<number, number> = {}
  const dead = new Set<number>()
  let spawned = 0
  return {
    killed, get spawned() { return spawned },
    deps: {
      kill: (pid: number, sig: NodeJS.Signals) => { killed.push([pid, sig]); if (sig === 'SIGKILL' && exitAfterPolls[pid] === 'on-kill') dead.add(pid) },
      isAlive: (pid: number) => {
        if (dead.has(pid)) return false
        const rule = exitAfterPolls[pid]
        if (typeof rule !== 'number') return true
        polls[pid] = (polls[pid] ?? 0) + 1
        return polls[pid]! <= rule
      },
      lockHolder: async () => null,
      spawnServer: () => { spawned++ },
      sleep: async () => {},
      termMs: 1_000,
      killMs: 500,
    },
  }
}

describe('handOverDetached — a replacement is started only once the old one is gone', () => {
  test('a server that exits on SIGTERM is replaced, with no SIGKILL', async () => {
    const w = world({ 7: 2 })
    expect(await handOverDetached([7], '/nope', w.deps)).toEqual({ ok: true })
    expect(w.killed).toEqual([[7, 'SIGTERM']])
    expect(w.spawned).toBe(1)
  })

  test('one that ignores SIGTERM gets SIGKILL, then is replaced', async () => {
    const w = world({ 8: 'on-kill' })
    expect(await handOverDetached([8], '/nope', w.deps)).toEqual({ ok: true })
    expect(w.killed).toEqual([[8, 'SIGTERM'], [8, 'SIGKILL']])
    expect(w.spawned).toBe(1)
  })

  test('one that will not die: NOTHING is spawned, and the reason says so', async () => {
    const w = world({ 9: 'never' })
    const r = await handOverDetached([9], '/nope', w.deps)
    expect(r.ok).toBe(false)
    expect(w.spawned).toBe(0)
  })

  test('a data-dir lock still held after the process left: nothing is spawned', async () => {
    const w = world({ 10: 0 })
    const r = await handOverDetached([10], '/nope', { ...w.deps, lockHolder: async () => 4242 })
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('4242') })
    expect(w.spawned).toBe(0)
  })
})
