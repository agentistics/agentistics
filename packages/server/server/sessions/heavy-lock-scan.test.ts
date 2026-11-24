import { expect, test } from 'bun:test'
import { createHeavyLockScanner, parseHeavyLockProcs } from './heavy-lock-scan'

const PS = [
  '  100     1 /sbin/init',
  '  200   100 flock /tmp/agentistics-heavy.lock agentop run --rm -- bun test',
  '  201   200 agentop run --rm -- bun test',
  '  300   100 /usr/bin/flock /tmp/agentistics-heavy.lock env NODE_OPTIONS=x tsc',
  '  400   100 bash -c flock /tmp/agentistics-heavy.lock tsc',
  '  500   100 sh -c "/usr/bin/flock /tmp/agentistics-heavy.lock tsc"',
  '  600   100 flock /tmp/other.lock true',
  '  700   100 flock /tmp/agentistics-release.lock agentop run --rm -- x',
].join('\n')

test('a flock with a child holds the lock; one without is queued; only a flock process counts', () => {
  expect(parseHeavyLockProcs(PS)).toEqual([
    { pid: 200, holding: true },
    { pid: 300, holding: false },
    { pid: 700, holding: false },
  ])
})

function scanner(over: Partial<Parameters<typeof createHeavyLockScanner>[0]> = {}) {
  let reads = 0
  let now = 1_000
  const s = createHeavyLockScanner({
    platform: 'linux',
    ps: async () => { reads++; return PS },
    managedIdOf: pid => ({ 200: 'a', 300: 'b', 700: 'c' } as Record<number, string>)[pid] ?? null,
    now: () => now,
    ...over,
  })
  return { s, reads: () => reads, advance: (ms: number) => { now += ms } }
}

test('ONE process listing serves every session of a tick', async () => {
  const f = scanner()
  const out = await Promise.all(Array.from({ length: 10 }, (_, i) => f.s.of(i % 2 ? 'a' : 'b')))
  expect(out).toEqual(Array.from({ length: 10 }, (_, i) => (i % 2 ? 'holding' : 'waiting')))
  expect(f.reads()).toBe(1)
  expect(await f.s.of('nobody')).toBe(false)
  expect(f.reads()).toBe(1)
})

test('the listing is read again once the tick has passed, never before', async () => {
  const f = scanner()
  await f.s.of('a'); f.advance(1_000); await f.s.of('a')
  expect(f.reads()).toBe(1)
  f.advance(10_000); await f.s.of('a')
  expect(f.reads()).toBe(2)
})

test('holding wins when one session has both a waiting and a holding flock', async () => {
  const f = scanner({ managedIdOf: pid => (pid === 200 || pid === 300 ? 'same' : null) })
  expect(await f.s.of('same')).toBe('holding')
})

test('off Linux there is no heavy signal and nothing is read or thrown', async () => {
  const f = scanner({ platform: 'darwin' })
  expect(await f.s.of('a')).toBe(false)
  expect(f.reads()).toBe(0)
})

test('a failing ps means "cannot tell" (false), never a throw, and is retried next tick', async () => {
  let fail = true
  const f = scanner({ ps: async () => { if (fail) throw new Error('no ps'); return PS } })
  expect(await f.s.of('a')).toBe(false)
  fail = false; f.advance(10_000)
  expect(await f.s.of('a')).toBe('holding')
})
