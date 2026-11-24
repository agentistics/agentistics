import { expect, test } from 'bun:test'
import { FLOCK_BUSY_CODE, heavyAttempts, heavyFlockArgs, heavyWaitLine, mergeHeavyJobs, queuePosition } from './heavy'

test('runHeavy argv probes without waiting and blocks only on the final slot-zero attempt', () => {
  const attempts = heavyAttempts(1, 2)
  expect(attempts.map(attempt => heavyFlockArgs(attempt, ['echo', 'ok'], '/private'))).toEqual([
    ['-n', '-E', String(FLOCK_BUSY_CODE), '/private/agentistics-heavy.lock', 'echo', 'ok'],
    ['-n', '-E', String(FLOCK_BUSY_CODE), '/private/agentistics-heavy.1.lock', 'echo', 'ok'],
    ['/private/agentistics-heavy.lock', 'echo', 'ok'],
  ])
})

test('only the head tries slots, then joins blocking flock on slot zero', () => {
  expect(heavyAttempts(1, 2)).toEqual([
    { slot: 0, blocking: false }, { slot: 1, blocking: false }, { slot: 0, blocking: true },
  ])
  expect(heavyAttempts(2, 2)).toEqual([])
})

test('manual waiters do not prevent the agentop head joining the kernel queue', () => {
  expect(queuePosition([
    { pid: 1, sinceMs: 1, command: 'manual', manual: true },
    { pid: 2, sinceMs: 2, command: 'agentop' },
  ], 2, () => true)).toEqual({ position: 1, of: 1 })
})

test('waiting status names the manual holder and counts manual waiters', () => {
  expect(heavyWaitLine({ slots: 1, availableBytes: null,
    running: [{ command: 'git commit', manual: true }], waiting: [{ manual: true }, { manual: true }],
  }, 1, 1)).toBe('agentop heavy: waiting — position 1 of 1, 1 running in 1 slot(s), ? available (manual running: git commit), 2 manual waiter(s)')
})

test('a blocking child stays queued once, then becomes an owned running job on acquisition', () => {
  const parent = { pid: 2, sinceMs: 2, command: 'agentop job', flockPid: 3 }
  const child = { pid: 3, sinceMs: 3, command: 'flock job', slot: 0, usedBytes: null, manual: true }
  expect(mergeHeavyJobs([], [parent], { running: [], waiting: [child] })).toEqual({ running: [], waiting: [parent] })
  expect(mergeHeavyJobs([], [parent], { running: [child], waiting: [] })).toEqual({
    running: [{ ...child, sinceMs: 2, command: 'agentop job', manual: false }], waiting: [],
  })
})
