import { describe, expect, test } from 'bun:test'
import { IdleSwap, RequestLeases } from './helper-hotswap'

describe('idle helper replacement', () => {
  function setup() {
    let version = 'old', now = 0
    const closed: string[] = [], logs: unknown[] = []
    let prepare = async () => 'new'
    const swap = new IdleSwap('old', version, {
      now: () => now, version: () => version, prepare: () => prepare(),
      close: w => { closed.push(w) }, log: e => { logs.push(e) }, usable: w => w !== 'dead',
    })
    return { swap, closed, logs, advance: (ms: number) => { now += ms }, change: (v = 'new') => { version = v }, prepare: (fn: typeof prepare) => { prepare = fn } }
  }
  test('changed executable swaps only after every request has flushed', async () => {
    const s = setup()
    const first = s.swap.enter(), second = s.swap.enter()
    s.change(); await s.swap.check()
    expect(s.swap.current).toBe('old')
    first(); first() // completion is idempotent
    expect(s.swap.current).toBe('old')
    second()
    expect(s.swap.current).toBe('new')
    expect(s.closed).toEqual(['old'])
  })
  test('same executable is untouched; an idle helper swaps immediately', async () => {
    const s = setup()
    await s.swap.check(); expect(s.closed).toEqual([])
    s.change(); await s.swap.check()
    expect(s.swap.current).toBe('new')
  })
  test('failed preparation logs, preserves current worker, and retries', async () => {
    const s = setup()
    s.change(); s.prepare(async () => { throw new Error('bad binary') })
    await s.swap.check()
    expect(s.swap.current).toBe('old'); expect(s.closed).toEqual([]); expect(s.logs).toHaveLength(1)
    s.prepare(async () => 'new'); s.advance(5000); await s.swap.check()
    expect(s.swap.current).toBe('new')
  })
  test('replacement dies while waiting for idle: keep current worker', async () => {
    const s = setup(), leave = s.swap.enter()
    s.change(); s.prepare(async () => 'dead'); await s.swap.check(); leave()
    expect(s.swap.current).toBe('old'); expect(s.closed).toEqual(['dead']); expect(s.logs).toHaveLength(1)
  })
  test('shutdown during preparation disposes candidate instead of reviving helper', async () => {
    const s = setup()
    let complete!: (s: string) => void
    s.prepare(() => new Promise(resolve => { complete = resolve }))
    s.change(); const check = s.swap.check(); s.swap.close(); complete('new'); await check
    expect(s.closed).toEqual(['old', 'new'])
  })
})

test('broken candidate backs off exponentially, caps at ten minutes, and resets on disk change', async () => {
  let now = 0, version = 'bad', attempts = 0
  const swap = new IdleSwap('old', 'old', {
    now: () => now, version: () => version,
    prepare: async () => { attempts++; throw new Error('broken') }, close: () => {}, log: () => {},
  })
  for (let n = 0; n < 10; n++) {
    await swap.check(); expect(attempts).toBe(n + 1)
    const delay = Math.min(600_000, 5000 * 2 ** n)
    now += delay - 1; await swap.check(); expect(attempts).toBe(n + 1)
    now++
  }
  version = 'another'; await swap.check(); expect(attempts).toBe(11)
})

test('dead active worker is replaced from disk even at the same version and with an outstanding lease', async () => {
  const dead = { healthy: false }, fresh = { healthy: true }, closed: unknown[] = []
  const swap = new IdleSwap(dead, 'v1', {
    version: () => 'v1', prepare: async () => fresh, usable: w => w.healthy,
    close: w => { closed.push(w) }, log: () => {},
  })
  swap.enter()
  await swap.recover()
  expect(swap.current).toBe(fresh); expect(closed).toEqual([dead])
  swap.close()
})

test('cancelled and expired requests release idle; other active requests still hold the swap', async () => {
  let version = 'old', now = 0
  const swap = new IdleSwap('old', 'old', {
    version: () => version, prepare: async () => 'new', close: () => {}, log: () => {},
  })
  const requests = new RequestLeases(() => swap.enter(), () => now)
  requests.start('client:cancelled'); requests.start('server:lost')
  version = 'new'; await swap.check()
  requests.finish('client:cancelled'); expect(swap.current).toBe('old')
  now = 299_999; requests.expire(); expect(swap.current).toBe('old')
  now++; requests.expire(); expect(swap.current).toBe('new')
  requests.finish('server:lost')
})
