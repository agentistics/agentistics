import { expect, test } from 'bun:test'
import { workerCapacity } from './host-ops'
import { parseSessionArgs } from '../sessions/cli-parse'

const budget = (harness: string, fiveHourPct: number, extra: Record<string, unknown> = {}) => ({
  harness, plan: 'max', fiveHourPct, weekPct: 10, weekResetsAt: Date.now() + 5 * 86_400_000, daysToWeekReset: 5, dailyBudgetPct: 20,
  status: 'ok', updatedAt: Date.now(), stale: false, spawnable: true, ...extra,
}) as never

const lead = (harness = 'claude', account = 'acc_a') => async () => ({ harness, account })

test('ORQ.H4 capacity: the cadence and 5-hour window of the leader\'s own account; no reading → refused', async () => {
  const cap = await workerCapacity(async () => [budget('claude', 30, { account: 'acc_a' })], lead())
  expect(cap).toMatchObject({ fiveHourPct: 30 })
  expect(typeof (cap as { parallel: number }).parallel).toBe('number')
  expect(await workerCapacity(async () => [], lead())).toMatchObject({ refused: true })
  expect(await workerCapacity(async () => { throw new Error('no store') }, lead())).toMatchObject({ refused: true })
})

test('QA F4: a stale reading, another account\'s reading or an unknown leader is UNKNOWN capacity — never a vacancy', async () => {
  const old = Date.now() - 3 * 86_400_000
  expect(await workerCapacity(async () => [budget('claude', 5, { account: 'acc_a', stale: true, updatedAt: old })], lead())).toMatchObject({ refused: true })
  // the same account, a stale 5 % row listed before a fresh 92 % row → the fresh one
  expect(await workerCapacity(async () => [budget('claude', 5, { account: 'acc_a', stale: true, updatedAt: old }), budget('claude', 92, { account: 'acc_a' })], lead()))
    .toMatchObject({ fiveHourPct: 92 })
  expect(await workerCapacity(async () => [budget('claude', 10, { account: 'acc_b' })], lead())).toMatchObject({ refused: true })
  expect(await workerCapacity(async () => [budget('codex', 10, { account: 'acc_a' })], lead())).toMatchObject({ refused: true })
  expect(await workerCapacity(async () => [budget('claude', 10, { account: 'acc_a' })])).toMatchObject({ refused: true }) // no leader
  expect(await workerCapacity(async () => [budget('claude', 10)], lead('claude', 'default'))).toMatchObject({ fiveHourPct: 10 }) // a legacy meter
})

test('--pedido is parsed for a start', () => {
  const cmd = parseSessionArgs(['codex', '--bg', '--pedido', 'p-abc', '-p', 'x'])
  if (cmd.kind !== 'start') throw new Error('not a start')
  expect(cmd.pedido).toBe('p-abc')
})
