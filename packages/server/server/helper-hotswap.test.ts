import { describe, expect, test } from 'bun:test'
import { IdleSwap } from './helper-hotswap'

describe('idle helper replacement', () => {
  function setup() {
    let version = 'old'
    const closed: string[] = [], logs: unknown[] = []
    let prepare = async () => 'new'
    const swap = new IdleSwap('old', version, {
      version: () => version, prepare: () => prepare(),
      close: w => { closed.push(w) }, log: e => { logs.push(e) }, usable: w => w !== 'dead',
    })
    return { swap, closed, logs, change: () => { version = 'new' }, prepare: (fn: typeof prepare) => { prepare = fn } }
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
    s.prepare(async () => 'new'); await s.swap.check()
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
