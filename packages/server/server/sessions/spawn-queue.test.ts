import { describe, expect, test } from 'bun:test'
import { createSpawnQueue, nextToStart, positionOf, QUEUE_MAX, type QueuedSpawn } from './spawn-queue'

describe('spawn queue', () => {
  test('oldest first; positions are 1-based', () => {
    const q: QueuedSpawn[] = [
      { id: 'b', sinceMs: 20, label: 'b', request: null },
      { id: 'a', sinceMs: 10, label: 'a', request: null },
    ]
    expect(nextToStart(q)?.id).toBe('a')
    expect(positionOf(q, 'b')).toBe(2)
    expect(positionOf(q, 'zzz')).toBe(0)
    expect(nextToStart([])).toBeNull()
  })

  test('starts ONE per tick, only when the gate admits, and announces it', async () => {
    let room = false
    const started: string[] = []
    const notes: string[] = []
    let t = 0
    const q = createSpawnQueue<string>({
      admit: async () => room,
      start: async r => { started.push(r); return { ok: true, message: 'ok' } },
      notify: n => notes.push(n.code),
    }, () => (t += 1000))
    q.enqueue('claude · /a', 'A')
    q.enqueue('claude · /b', 'B')
    await q.tick()
    expect(started).toEqual([])               // no room: nothing starts
    room = true
    await q.tick()
    expect(started).toEqual(['A'])            // one per tick, oldest first
    expect(q.list().map(x => [x.label, x.position])).toEqual([['claude · /b', 1]])
    await q.tick()
    expect(started).toEqual(['A', 'B'])
    expect(notes).toEqual(['hardware.spawn_started', 'hardware.spawn_started'])
  })

  test('a failed start is announced, not retried forever', async () => {
    const notes: Array<[string, unknown]> = []
    const q = createSpawnQueue<string>({
      admit: async () => true,
      start: async () => ({ ok: false, message: 'claude is not on PATH' }),
      notify: n => notes.push([n.code, n.meta.reason]),
    })
    q.enqueue('claude · /a', 'A')
    await q.tick()
    expect(notes).toEqual([['hardware.spawn_failed', 'claude is not on PATH']])
    expect(q.list()).toEqual([])
  })

  test('bounded, and cancelable', () => {
    const q = createSpawnQueue<number>({ admit: async () => false, start: async () => ({ ok: true, message: '' }), notify: () => {} })
    const ids = Array.from({ length: QUEUE_MAX }, (_, i) => q.enqueue(`s${i}`, i)!.id)
    expect(q.enqueue('one too many', 99)).toBeNull()
    expect(q.cancel(ids[0]!)).toBe(true)
    expect(q.cancel('nope')).toBe(false)
    expect(q.list()).toHaveLength(QUEUE_MAX - 1)
    for (const id of ids.slice(1)) q.cancel(id)
  })
})
