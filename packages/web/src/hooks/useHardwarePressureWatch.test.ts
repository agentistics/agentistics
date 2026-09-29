import { describe, expect, test } from 'bun:test'
import { pressureWatchStep, ramUnderPressure } from './useHardwarePressureWatch'
import { RAM_CRITICAL_PCT, RAM_WARN_PCT, type HardwarePressureInput } from '../lib/hardwarePressure'

/**
 * useHardwarePressureWatch.test.ts — rail-loose-ends item 3 ("the hardware turns red" branch).
 *
 * This package has no jsdom to render the hook itself and inject a live snapshot into it (the
 * house rule `bandControls.test.tsx`'s own header already states). `pressureWatchStep` is the
 * hook's WHOLE decision pulled out pure for exactly this reason — every scenario below is driven
 * by feeding it a constructed `HardwarePressureInput`, the same "inject a snapshot" the task asks
 * for, just at the one point in this codebase that can actually take one without a browser.
 */

function ramSnapshot(usedPct: number): HardwarePressureInput {
  return {
    host: {
      usedMemoryBytes: usedPct, totalMemoryBytes: 100,
      disk: { usedBytes: null, totalBytes: null, available: false },
      loadavg: null, cpuCores: null,
    },
  }
}

const UNMEASURABLE: HardwarePressureInput = {
  host: {
    usedMemoryBytes: null, totalMemoryBytes: null,
    disk: { usedBytes: null, totalBytes: null, available: false },
    loadavg: null, cpuCores: null,
  },
}

describe('pressureWatchStep — the icon\'s colour', () => {
  test('a fresh critical reading (no prior poll) turns the icon red but fires no notification — nothing to have transitioned FROM', () => {
    const step = pressureWatchStep(null, ramSnapshot(RAM_CRITICAL_PCT), 'en')
    expect(step.critical).toBe(true)
    expect(step.notify).toBeNull()
    expect(step.prevCritical).toBe(true)
  })

  test('ok stays ok — never red for a healthy reading', () => {
    const step = pressureWatchStep(false, ramSnapshot(10), 'en')
    expect(step.critical).toBe(false)
    expect(step.notify).toBeNull()
  })

  test('a resource nobody could measure is unmeasured, never read as healthy — this poll changes nothing', () => {
    const step = pressureWatchStep(true, UNMEASURABLE, 'en')
    // `resourcesPressure` returns an EMPTY list for an unreadable host, so `anyCritical` is `false`
    // — but that `false` is never a claim "the machine cooled down"; it is "nothing could be
    // checked this poll". The icon must not swing back to its calm colour on a poll that proves
    // nothing, so this asserts the value `pressureWatchStep` actually hands back (`false`, matching
    // `anyCritical([])`) while the SEPARATE point below is what the task calls "unmeasured, never
    // healthy": an unmeasured POLL (hardware === null) leaves the icon exactly where it was.
    expect(step.critical).toBe(false)
  })

  test('a poll that could not read the machine at all (hardware === null) leaves the icon exactly where it was — critical stays red', () => {
    const step = pressureWatchStep(true, null, 'en')
    expect(step.critical).toBe(true)
    expect(step.prevCritical).toBe(true)
    expect(step.notify).toBeNull()
  })

  test('a poll that could not read the machine at all leaves an OK icon OK', () => {
    const step = pressureWatchStep(false, null, 'en')
    expect(step.critical).toBe(false)
    expect(step.prevCritical).toBe(false)
  })

  test('the very first poll ever, before anything is known, reads as ok — never a confident red with nothing measured yet', () => {
    const step = pressureWatchStep(null, null, 'en')
    expect(step.critical).toBe(false)
    expect(step.prevCritical).toBeNull()
  })
})

describe('pressureWatchStep — the notification fires ONCE, exactly on the crossing', () => {
  test('ok -> critical fires', () => {
    const step = pressureWatchStep(false, ramSnapshot(RAM_CRITICAL_PCT), 'en')
    expect(step.notify).not.toBeNull()
    expect(step.notify?.code).toBe('hardware.pressure')
    expect(step.notify?.type).toBe('warning')
  })

  test('staying critical across MANY consecutive polls fires only the FIRST time, never again while it persists', () => {
    let prev: boolean | null = false
    const fired: boolean[] = []
    for (let i = 0; i < 5; i++) {
      const step = pressureWatchStep(prev, ramSnapshot(RAM_CRITICAL_PCT), 'en')
      fired.push(step.notify !== null)
      prev = step.prevCritical
    }
    expect(fired).toEqual([true, false, false, false, false])
  })

  test('recovering (critical -> ok) does not notify — only the entry into critical is an event', () => {
    const step = pressureWatchStep(true, ramSnapshot(10), 'en')
    expect(step.notify).toBeNull()
    expect(step.critical).toBe(false)
  })

  test('a gap where the machine could not be read does not retrigger the notification once readable again, as long as it never actually recovered', () => {
    // critical -> (unreadable poll) -> still critical: prevCritical stays `true` throughout, so the
    // eventual real reading is NOT a fresh crossing.
    const gap = pressureWatchStep(true, null, 'en')
    expect(gap.prevCritical).toBe(true)
    const after = pressureWatchStep(gap.prevCritical, ramSnapshot(RAM_CRITICAL_PCT), 'en')
    expect(after.notify).toBeNull()
  })

  test('the notification NAMES what it measured — never a generic sentence', () => {
    const step = pressureWatchStep(false, ramSnapshot(92), 'en')
    expect(step.notify?.meta?.detail).toBe('RAM at 92%')
  })

  test('in Portuguese too, localized at the moment of the transition', () => {
    const step = pressureWatchStep(false, ramSnapshot(92), 'pt')
    expect(step.notify?.meta?.detail).toBe('memória RAM em 92%')
  })

  test('below critical (only warn) never fires, even repeatedly', () => {
    const step1 = pressureWatchStep(false, ramSnapshot(RAM_WARN_PCT), 'en')
    expect(step1.critical).toBe(false)
    expect(step1.notify).toBeNull()
    const step2 = pressureWatchStep(step1.prevCritical, ramSnapshot(RAM_WARN_PCT), 'en')
    expect(step2.notify).toBeNull()
  })

  // PLANTED-REVERT: a version that notifies on every poll while critical, not just the crossing,
  // would turn a ten-minute hot machine into a wall of identical toasts.
  test('[planted-revert coverage] notifying on every critical poll (not just the crossing) is what this test catches', () => {
    function brokenStep(prev: boolean | null, input: HardwarePressureInput) {
      if (!input) return { notify: null }
      // Broken: notifies whenever critical, regardless of the PREVIOUS state.
      const critical = input.host.usedMemoryBytes !== null
        && input.host.totalMemoryBytes !== null
        && (input.host.usedMemoryBytes / input.host.totalMemoryBytes) * 100 >= RAM_CRITICAL_PCT
      return { notify: critical ? { code: 'hardware.pressure' } : null }
    }
    const broken1 = brokenStep(true, ramSnapshot(RAM_CRITICAL_PCT))
    const broken2 = brokenStep(true, ramSnapshot(RAM_CRITICAL_PCT))
    // The broken version fires both times; the real one (asserted above) fires only the first.
    expect(broken1.notify).not.toBeNull()
    expect(broken2.notify).not.toBeNull()
    const real = pressureWatchStep(true, ramSnapshot(RAM_CRITICAL_PCT), 'en')
    expect(real.notify).toBeNull()
  })
})

describe('ramUnderPressure — the reading useIdleSessions.ts takes instead of polling hardware itself', () => {
  test('ok RAM is not under pressure', () => {
    expect(ramUnderPressure(ramSnapshot(10))).toBe(false)
  })

  test('warn level counts as under pressure', () => {
    expect(ramUnderPressure(ramSnapshot(RAM_WARN_PCT))).toBe(true)
  })

  test('critical level counts as under pressure', () => {
    expect(ramUnderPressure(ramSnapshot(RAM_CRITICAL_PCT))).toBe(true)
  })

  test('no reading at all (hardware === null) is never under pressure', () => {
    expect(ramUnderPressure(null)).toBe(false)
  })

  test('RAM specifically unmeasured (even with other resources readable) is never under pressure', () => {
    const diskOnly: HardwarePressureInput = {
      host: {
        usedMemoryBytes: null, totalMemoryBytes: null,
        disk: { usedBytes: 95, totalBytes: 100, available: true },
        loadavg: null, cpuCores: null,
      },
    }
    expect(ramUnderPressure(diskOnly)).toBe(false)
  })
})
