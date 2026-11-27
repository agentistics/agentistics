import { expect, test } from 'bun:test'
import { capacityPrint, envPrint, SLOT_RECHECK_MS, slotNeedsCheck, type CapacityEnv } from './queue-slot-memo'

const E: CapacityEnv = { memoryBytes: 8 * 1024 ** 3, budgets: [{ harness: 'claude', account: 'a', fiveHourPct: 10, weekPct: 10, stale: false }], topCap: 2, rule: { minFreeBytes: 3 * 1024 ** 3, fiveHourCeiling: 85, weekCeiling: 95, account: 'a' } }

const s = (id: string, alive = true) => ({ id, alive, harness: 'claude', account: 'a' })

test('the print ignores order and dead sessions, and changes when a live one starts or ends', () => {
  const a = capacityPrint([s('w1'), s('w2'), s('x', false)], [], { revision: 3 }, E)
  expect(capacityPrint([s('w2'), s('w1')], [], { revision: 3 }, E)).toBe(a)
  expect(capacityPrint([s('w1')], [], { revision: 3 }, E)).not.toBe(a)
  expect(capacityPrint([s('w1'), s('w2')], ['ask:p'], { revision: 3 }, E)).not.toBe(a)
  expect(capacityPrint([s('w1'), s('w2')], [], { revision: 4 }, E)).not.toBe(a)
  expect(capacityPrint(null, [], { revision: 3 }, E)).not.toBe(capacityPrint([], [], { revision: 3 }, E))
})

test('re-asked when absent, changed, stale, or the clock went back', () => {
  expect(slotNeedsCheck(undefined, 'p', 0)).toBe(true)
  expect(slotNeedsCheck({ print: 'p', atMs: 1000 }, 'p', 1000 + SLOT_RECHECK_MS - 1)).toBe(false)
  expect(slotNeedsCheck({ print: 'p', atMs: 1000 }, 'q', 1001)).toBe(true)
  expect(slotNeedsCheck({ print: 'p', atMs: 1000 }, 'p', 1000 + SLOT_RECHECK_MS)).toBe(true)
  expect(slotNeedsCheck({ print: 'p', atMs: 1000 }, 'p', 500)).toBe(true)
})

test('the print changes with every input judgeVaga flips on: memory band, budget ok, top cap, role, model', () => {
  const piece = { revision: 1, harness: 'claude', account: 'a', model: 'claude-opus-5-5' }
  const base = capacityPrint([s('w1')], [], piece, E)
  // memory: only crossing the 3 GB band matters
  expect(capacityPrint([s('w1')], [], piece, { ...E, memoryBytes: 7 * 1024 ** 3 })).toBe(base)
  expect(capacityPrint([s('w1')], [], piece, { ...E, memoryBytes: 1024 ** 3 })).not.toBe(base)
  expect(capacityPrint([s('w1')], [], piece, { ...E, memoryBytes: null })).not.toBe(base)
  // budget: only over/under a ceiling or a stale/absent reading
  expect(capacityPrint([s('w1')], [], piece, { ...E, budgets: [{ ...E.budgets[0]!, fiveHourPct: 50 }] })).toBe(base)
  expect(capacityPrint([s('w1')], [], piece, { ...E, budgets: [{ ...E.budgets[0]!, fiveHourPct: 90 }] })).not.toBe(base)
  expect(capacityPrint([s('w1')], [], piece, { ...E, budgets: [{ ...E.budgets[0]!, weekPct: 96 }] })).not.toBe(base)
  expect(capacityPrint([s('w1')], [], piece, { ...E, budgets: [{ ...E.budgets[0]!, stale: true }] })).not.toBe(base)
  expect(capacityPrint([s('w1')], [], piece, { ...E, topCap: 3 })).not.toBe(base)
  expect(capacityPrint([{ ...s('w1'), role: 'leader' }], [], piece, E)).not.toBe(base)
  expect(capacityPrint([{ ...s('w1'), model: 'claude-opus-5-5' }], [], piece, E)).not.toBe(base)
  expect(capacityPrint([s('w1')], [], { ...piece, model: 'claude-sonnet-5-5' }, E)).not.toBe(base)
  expect(envPrint(E, piece)).toEqual(['ok', 'ok', 2])
})
