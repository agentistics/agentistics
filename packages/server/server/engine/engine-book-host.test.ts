/**
 * engine-book-host.test.ts — the host's side of a book takeover (engine-api 1.26, LIVRO.SEAMS slice 2): the successor
 * starts through the fleet's own hand-off spawn (`handoff: true`, never a raw CLI), an unconfirmed one is killed, the
 * predecessor is retired the way `retirePredecessor` does, and a proof is checked with the session-identity verifier.
 */
import { describe, expect, test } from 'bun:test'
import { createBookHost, type BookHostDeps } from './engine-book-host'

const LEADER = { id: 'lead-1', harness: 'opencode' as const, cwd: '/work/repo', taskId: 't-1' }

function deps(over: Partial<BookHostDeps> = {}): BookHostDeps & { log: string[]; bodies: unknown[] } {
  const log: string[] = []
  const bodies: unknown[] = []
  return {
    log,
    bodies,
    registry: async () => [LEADER, { id: 'gone', harness: 'claude', cwd: '/x', endedAt: '2026-11-11T00:00:00Z' }],
    spawn: async body => { bodies.push(body); return { ok: true, message: 'started', id: 'succ-1' } },
    kill: async id => { log.push(`kill:${id}`); return { ok: true } },
    requestRetire: async (pred, succ) => { log.push(`retire:${pred}->${succ}`); return true },
    verify: async (id, token) => (typeof id === 'string' && token === `ok:${id}` ? id : null),
    ...over,
  }
}

const spawnReq = { predecessorId: 'lead-1', taskId: 't-1', prompt: 'take over', model: 'opencode/big-pickle' }

describe('book host', () => {
  test('the successor starts through the fleet spawn as the predecessor\'s VERIFIED hand-off, in its folder', async () => {
    const d = deps()
    const out = await createBookHost(d).spawnSuccessor(spawnReq)
    expect(out).toEqual({ ok: true, sessionId: 'succ-1' })
    expect(d.bodies).toEqual([{
      harness: 'opencode', cwd: '/work/repo', parent: 'lead-1', parentVerified: true, callerVerified: true,
      handoff: true, prompt: 'take over', model: 'opencode/big-pickle',
    }])
  })

  test('an explicit harness and account win; an unknown or ended predecessor spawns nothing', async () => {
    const d = deps()
    const host = createBookHost(d)
    await host.spawnSuccessor({ ...spawnReq, harness: 'codex', account: 'acc_1' })
    expect(d.bodies[0]).toMatchObject({ harness: 'codex', account: 'acc_1' })
    for (const predecessorId of ['nobody', 'gone']) {
      const out = await host.spawnSuccessor({ ...spawnReq, predecessorId })
      expect(out.ok).toBe(false)
    }
    expect(d.bodies).toHaveLength(1)
  })

  test('a refused or queued spawn is a refusal with the fleet\'s sentence, never a session id', async () => {
    for (const answer of [{ ok: false, message: 'memory budget' }, { ok: true, message: 'queued', queued: { id: 'q', position: 1 } }]) {
      const out = await createBookHost(deps({ spawn: async () => answer })).spawnSuccessor(spawnReq)
      expect(out).toEqual({ ok: false, sentence: answer.message })
    }
  })

  test('stop kills, retire writes the retire request (retirePredecessor), isAlive/taskOf read the registry', async () => {
    const d = deps()
    const host = createBookHost(d)
    expect(await host.stop('succ-1')).toEqual({ closed: true })
    expect(await host.retire('lead-1', 'succ-1')).toEqual({ retired: true })
    expect(d.log).toEqual(['kill:succ-1', 'retire:lead-1->succ-1'])
    expect(await host.isAlive('lead-1')).toBe(true)
    expect(await host.isAlive('gone')).toBe(false)
    expect(await host.isAlive('nobody')).toBe(false)
    expect(await host.taskOf('lead-1')).toBe('t-1')
    expect(await host.taskOf('nobody')).toBeUndefined()
  })

  test('verifySession checks a session-identity proof and never accepts another id\'s token', async () => {
    const host = createBookHost(deps())
    expect(await host.verifySession('succ-1', 'ok:succ-1')).toBe(true)
    expect(await host.verifySession('succ-1', 'ok:lead-1')).toBe(false)
    expect(await host.verifySession('succ-1', '')).toBe(false)
  })

  test('the REAL host services hand the book host to the engine (1.26), and a junk proof is refused', async () => {
    const { hostServices } = await import('./load')
    const h = await hostServices()
    expect(Object.keys(h.book ?? {}).sort()).toEqual(['isAlive', 'retire', 'spawnSuccessor', 'stop', 'taskOf', 'verifySession'])
    expect(await h.book!.verifySession('nobody', 'f'.repeat(64))).toBe(false)
  })
})
