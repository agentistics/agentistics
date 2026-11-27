/**
 * PERF.SERVIDOR-OCIOSO — the server runs the health checks at most once a minute and never waits for them after the
 * first time: a stale result is answered and refreshed in the background, one refresh at a time.
 */
import { afterEach, expect, test } from 'bun:test'
import type { HealthIssue } from '@agentistics/core'
import { HEALTH_TTL_MS, resetHealthCache, runHealthChecksCached } from './health'

afterEach(() => resetHealthCache())

const issue = (id: string): HealthIssue => ({ id, severity: 'info', title: id, description: id })

test('reused inside a minute; past it, the old answer at once and one background refresh', async () => {
  let runs = 0
  let release: (() => void) | null = null
  const slow = () => { runs++; const n = runs; return new Promise<HealthIssue[]>(r => { release = () => r([issue(`run${n}`)]) }) }
  const t0 = 1_000_000
  const first = runHealthChecksCached(t0, slow)
  release!()
  expect((await first)[0]!.id).toBe('run1')
  expect((await runHealthChecksCached(t0 + 30_000, slow))[0]!.id).toBe('run1')
  expect(runs).toBe(1)
  // stale: answered from the previous run, without waiting for the slow refresh
  const stale = await runHealthChecksCached(t0 + HEALTH_TTL_MS, slow)
  expect(stale[0]!.id).toBe('run1')
  expect(runs).toBe(2)
  // a second stale read while the refresh runs does not start another
  await runHealthChecksCached(t0 + HEALTH_TTL_MS + 1, slow)
  expect(runs).toBe(2)
  release!()
  await Bun.sleep(5)
  expect((await runHealthChecksCached(Date.now(), slow))[0]!.id).toBe('run2')
})

test('a first run that fails is not remembered', async () => {
  let runs = 0
  const failing = async () => { runs++; throw new Error('boom') }
  await runHealthChecksCached(1, failing).catch(() => undefined)
  await Bun.sleep(1)
  await runHealthChecksCached(2, failing).catch(() => undefined)
  expect(runs).toBe(2)
})
