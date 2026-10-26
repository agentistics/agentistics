import { describe, expect, test } from 'bun:test'
import {
  ALARM_REARM_BYTES, HARD_FLOOR_BYTES, insideHeavyLock, memoryAlarmStep, runMinAvailableBytes,
  runWaitMaxMs, shouldAnnounceWait, shouldWaitForMemory, shouldWrapHeavy,
} from './mem-guard'

const GiB = 1024 ** 3

describe('shouldWaitForMemory', () => {
  test('waits below 3 GiB, goes at or above, never waits unmeasured', () => {
    expect(shouldWaitForMemory(2.9 * GiB)).toBe(true)
    expect(shouldWaitForMemory(3 * GiB)).toBe(false)
    expect(shouldWaitForMemory(null)).toBe(false)
  })
  test('env override, nonsense ignored', () => {
    expect(runMinAvailableBytes({ AGENTISTICS_RUN_MIN_AVAILABLE_MB: '4096' })).toBe(4 * GiB)
    expect(runMinAvailableBytes({ AGENTISTICS_RUN_MIN_AVAILABLE_MB: '5' })).toBe(3 * GiB)
    expect(runMinAvailableBytes({})).toBe(3 * GiB)
  })
})

describe('insideHeavyLock / shouldWrapHeavy', () => {
  test('env marker or a flock ancestor on the heavy lock', () => {
    expect(insideHeavyLock({ AGENTISTICS_HEAVY_JOB: '1' }, [])).toBe(true)
    expect(insideHeavyLock({}, ['bash -c x', 'flock /tmp/agentistics-heavy.lock agentop run --rm -- bun test'])).toBe(true)
    expect(insideHeavyLock({}, ['flock /tmp/agentistics-heavy.2.lock x'])).toBe(true)
    expect(insideHeavyLock({}, ['flock /tmp/other.lock x', 'bun test'])).toBe(false)
  })
  test('wraps only a real command on linux with flock and outside the lock', () => {
    const base = { hasCommand: true, linux: true, hasFlock: true, inside: false }
    expect(shouldWrapHeavy(base)).toBe(true)
    expect(shouldWrapHeavy({ ...base, hasCommand: false })).toBe(false)
    expect(shouldWrapHeavy({ ...base, linux: false })).toBe(false)
    expect(shouldWrapHeavy({ ...base, hasFlock: false })).toBe(false)
    expect(shouldWrapHeavy({ ...base, inside: true })).toBe(false)
  })
})

describe('memoryAlarmStep', () => {
  test('raises once, stays quiet while low, re-arms only after recovery', () => {
    let s = { raised: false }
    let r = memoryAlarmStep(s, 1.5 * GiB); expect(r.raise).toBe(true); s = r.state
    r = memoryAlarmStep(s, 1.0 * GiB); expect(r.raise).toBe(false); s = r.state
    r = memoryAlarmStep(s, 2.5 * GiB); expect(r.raise).toBe(false); expect(r.state.raised).toBe(true); s = r.state
    r = memoryAlarmStep(s, 1.9 * GiB); expect(r.raise).toBe(false)
    r = memoryAlarmStep(s, ALARM_REARM_BYTES); expect(r.state.raised).toBe(false); s = r.state
    r = memoryAlarmStep(s, HARD_FLOOR_BYTES - 1); expect(r.raise).toBe(true)
  })
  test('unmeasured changes nothing', () => {
    expect(memoryAlarmStep({ raised: true }, null)).toEqual({ state: { raised: true }, raise: false })
  })
})

describe('run --rm wait: ceiling and announce throttle', () => {
  test('ceiling is 10 min by default, env override in seconds, nonsense ignored', () => {
    expect(runWaitMaxMs({})).toBe(600_000)
    expect(runWaitMaxMs({ AGENTISTICS_RUN_WAIT_MAX_SEC: '90' })).toBe(90_000)
    expect(runWaitMaxMs({ AGENTISTICS_RUN_WAIT_MAX_SEC: 'x' })).toBe(600_000)
  })
  test('announces first, then only on a changed rounded GB AND after 30 s', () => {
    expect(shouldAnnounceWait(null, 2.5 * GiB, 0)).toBe(true)
    const prev = { gb: '2.5', at: 0 }
    expect(shouldAnnounceWait(prev, 2.4 * GiB, 31_000)).toBe(true)
    expect(shouldAnnounceWait(prev, 2.4 * GiB, 10_000)).toBe(false)
    expect(shouldAnnounceWait(prev, 2.5 * GiB, 60_000)).toBe(false)
  })
})
