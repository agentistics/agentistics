import { describe, expect, test } from 'bun:test'
import {
  budgetFromEnv, decideSelfGuard, exeWasReplaced, parseProcStatusMemory,
  RELOAD_COOLDOWN_MS, SELF_BUDGET_BYTES, type SelfSample,
} from './self-guard'
import { compareVersions } from './version'

const MB = 1024 * 1024
const base: SelfSample = {
  usedBytes: 200 * MB, rssBytes: 200 * MB, swapBytes: 0,
  exeReplaced: false, ownVersion: '2.101.2', serverVersion: '2.101.2',
}
const decide = (sample: Partial<SelfSample>, lastReloadMs: number | null = null, nowMs = 10_000_000) =>
  decideSelfGuard({ sample: { ...base, ...sample }, lastReloadMs, nowMs, compare: compareVersions })

describe('decideSelfGuard', () => {
  test('a healthy, current process is left alone', () => {
    expect(decide({})).toEqual({ action: 'none' })
  })

  test('the incident: replaced binary at 1.7 GB RSS + 6.5 GB swap restarts (not reload)', () => {
    const d = decide({ exeReplaced: true, rssBytes: 1700 * MB, swapBytes: 6500 * MB, usedBytes: 8200 * MB, serverVersion: '2.101.2', ownVersion: '2.99.0' })
    expect(d).toEqual({ action: 'restart', reason: 'replaced', ownVersion: '2.99.0', serverVersion: '2.101.2' })
  })

  test('swap counts toward the budget — RSS alone hid the incident', () => {
    const d = decide({ rssBytes: 300 * MB, swapBytes: 700 * MB, usedBytes: 1000 * MB })
    expect(d.action).toBe('reload')
  })

  test('a second overrun inside the cooldown alerts instead of looping', () => {
    const now = 10_000_000
    expect(decide({ usedBytes: 2000 * MB }, now - 60_000, now)).toMatchObject({ action: 'alert', reason: 'memory' })
    expect(decide({ usedBytes: 2000 * MB }, now - RELOAD_COOLDOWN_MS - 1, now).action).toBe('reload')
  })

  test('a newer server with our binary intact is an alert, never a restart onto the same file', () => {
    expect(decide({ serverVersion: '2.102.0' })).toEqual({
      action: 'alert', reason: 'outdated', ownVersion: '2.101.2', serverVersion: '2.102.0',
    })
    expect(decide({ serverVersion: '2.100.0' })).toEqual({ action: 'none' })
  })

  test('an unmeasurable process makes no memory decision', () => {
    expect(decide({ usedBytes: null, rssBytes: null, swapBytes: null })).toEqual({ action: 'none' })
  })
})

describe('readers', () => {
  test('parseProcStatusMemory reads VmRSS and VmSwap', () => {
    const text = 'Name:\tagentop\nVmRSS:\t 1782412 kB\nVmSwap:\t 6815744 kB\n'
    expect(parseProcStatusMemory(text)).toEqual({ rssBytes: 1782412 * 1024, swapBytes: 6815744 * 1024 })
    expect(parseProcStatusMemory('Name: x\n')).toEqual({ rssBytes: null, swapBytes: null })
  })

  test('exeWasReplaced reads the kernel marker', () => {
    expect(exeWasReplaced('/home/u/.local/bin/agentop.bak (deleted)')).toBe(true)
    expect(exeWasReplaced('/home/u/.local/bin/agentop')).toBe(false)
    expect(exeWasReplaced(null)).toBe(false)
  })

  test('budgetFromEnv refuses nonsense', () => {
    expect(budgetFromEnv('1024')).toBe(1024 * MB)
    expect(budgetFromEnv('12')).toBe(SELF_BUDGET_BYTES)
    expect(budgetFromEnv('abc')).toBe(SELF_BUDGET_BYTES)
    expect(budgetFromEnv(undefined)).toBe(SELF_BUDGET_BYTES)
  })
})
