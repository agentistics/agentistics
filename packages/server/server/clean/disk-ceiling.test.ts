import { describe, expect, test } from 'bun:test'
import { ceilingBytes, diskNoticeText, evaluateDiskCeiling, isWsl, NOTICE_EVERY_MS, resolveCeiling } from './disk-ceiling'

const GiB = 1024 ** 3

describe('ceiling', () => {
  test('is the larger of 15% and 30 GB, and both are configurable', () => {
    expect(ceilingBytes(100 * GiB, resolveCeiling(undefined))).toBe(30 * GiB)
    expect(ceilingBytes(1000 * GiB, resolveCeiling(undefined))).toBe(150 * GiB)
    expect(ceilingBytes(1000 * GiB, resolveCeiling({ freePct: 5, freeGB: 10 }))).toBe(50 * GiB)
  })
  test('junk configuration falls back to the defaults', () => {
    expect(resolveCeiling({ freePct: -1, freeGB: Number.NaN })).toEqual({ freePct: 15, freeGB: 30 })
    expect(resolveCeiling({ freePct: 0, freeGB: 0 })).toEqual({ freePct: 0, freeGB: 0 })
  })
})

describe('evaluateDiskCeiling', () => {
  const cfg = resolveCeiling(undefined)
  const at = (freeGB: number, lastNoticeMs: number | null, nowMs = 10 * NOTICE_EVERY_MS) =>
    evaluateDiskCeiling({ freeBytes: freeGB * GiB, totalBytes: 100 * GiB, cfg, lastNoticeMs, nowMs })
  test('notifies on the first time under, then at most once a day', () => {
    expect(at(10, null)).toEqual({ low: true, notify: true, lastNoticeMs: 10 * NOTICE_EVERY_MS })
    expect(at(10, 10 * NOTICE_EVERY_MS - 1).notify).toBe(false)
    expect(at(10, 9 * NOTICE_EVERY_MS).notify).toBe(true)
  })
  test('a real recovery re-arms the notice; hovering just above the line does not', () => {
    expect(at(60, 123)).toEqual({ low: false, notify: false, lastNoticeMs: null })
    expect(at(31, 123)).toEqual({ low: false, notify: false, lastNoticeMs: 123 })
  })
})

describe('the notice', () => {
  const base = { freeBytes: 10 * GiB, thresholdBytes: 30 * GiB, freeableBytes: 5 * GiB, count: 4 }
  test('says how much cleanup would free and offers the action without telling anyone to run a command', () => {
    for (const lang of ['en', 'pt'] as const) {
      const t = diskNoticeText({ ...base, lang, wsl: false })
      expect(t).toContain('10.0 GB')
      expect(t).toContain('5.0 GB')
      expect(t).not.toContain('agentop')
    }
  })
  test('the WSL sentence appears only when asked for', () => {
    expect(diskNoticeText({ ...base, lang: 'en', wsl: true })).toContain('set-sparse true')
    expect(diskNoticeText({ ...base, lang: 'en', wsl: false })).not.toContain('set-sparse')
  })
  test('WSL is detected from the kernel version or the distro name', () => {
    expect(isWsl('Linux version 5.15-microsoft-standard-WSL2', {})).toBe(true)
    expect(isWsl('Linux version 6.8-generic', { WSL_DISTRO_NAME: 'Ubuntu' })).toBe(true)
    expect(isWsl('Linux version 6.8-generic', {})).toBe(false)
  })
})
