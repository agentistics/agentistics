import { describe, expect, test } from 'bun:test'
import {
  CRITICAL_SNOOZE_MS, RESTORE_TTL_MS, SNOOZE_MS, decodeRestore, encodeRestore, isNewer, parseSnooze,
  safeAppUrl, shouldShowToast, snapshotRestore, snoozeActive, snoozeFor, type VersionAnswer,
  UPDATE_NOTICE_CODE, promptExit, promptTimeoutMs,
  VERSION_POLL_MS, VERSION_FOCUS_MIN_MS, versionRefetchDue, promptDismissedFor,
} from './updateToast'

const info = (o: Partial<VersionAnswer> = {}): VersionAnswer =>
  ({ current: '2.30.0', latest: '2.31.0', hasUpdate: true, critical: false, upgradable: null, ...o })
const NOW = 1_700_000_000_000

describe('version order', () => {
  test('newer, equal, older, junk', () => {
    expect(isNewer('2.31.0', '2.30.9')).toBe(true)
    expect(isNewer('v2.31.0', '2.31.0')).toBe(false)
    expect(isNewer('2.9.0', '2.10.0')).toBe(false)
    expect(isNewer('abc', '2.0.0')).toBe(false)
  })
})

describe('when the toast shows', () => {
  const base = { snooze: null, now: NOW, central: false }
  test('a newer installable version shows', () => expect(shouldShowToast({ ...base, info: info() })).toEqual({ show: true }))
  test('no update / no answer', () => {
    expect(shouldShowToast({ ...base, info: info({ hasUpdate: false }) })).toEqual({ show: false, why: 'no-update' })
    expect(shouldShowToast({ ...base, info: null })).toEqual({ show: false, why: 'no-update' })
    expect(shouldShowToast({ ...base, info: info({ latest: '2.30.0' }) })).toEqual({ show: false, why: 'no-update' })
  })
  test('a central never shows it', () => expect(shouldShowToast({ ...base, central: true, info: info() })).toEqual({ show: false, why: 'central' }))
  test('every gate refusal hides it', () => {
    for (const r of ['container', 'no-capability', 'central', 'not-a-binary'])
      expect(shouldShowToast({ ...base, info: info({ upgradable: r }) })).toEqual({ show: false, why: 'not-installable' })
  })
  test('a server that does not say is not offered a button the route may refuse', () => {
    expect(shouldShowToast({ ...base, info: info({ upgradable: undefined }) })).toEqual({ show: false, why: 'not-installable' })
  })
})

describe('remind me later', () => {
  test('a normal update is snoozed for a day, a critical one briefly', () => {
    expect(snoozeFor('2.31.0', false, NOW).until).toBe(NOW + SNOOZE_MS)
    expect(snoozeFor('2.31.0', true, NOW).until).toBe(NOW + CRITICAL_SNOOZE_MS)
    expect(CRITICAL_SNOOZE_MS).toBeLessThan(SNOOZE_MS)
  })
  test('silences until it expires', () => {
    const s = snoozeFor('2.31.0', false, NOW)
    expect(shouldShowToast({ info: info(), snooze: s, now: NOW + 1, central: false })).toEqual({ show: false, why: 'snoozed' })
    expect(shouldShowToast({ info: info(), snooze: s, now: NOW + SNOOZE_MS, central: false })).toEqual({ show: true })
  })
  test('a newer version re-shows it', () => {
    const s = snoozeFor('2.31.0', false, NOW)
    expect(snoozeActive(s, '2.32.0', NOW + 1)).toBe(false)
  })
  test('parse is total', () => {
    expect(parseSnooze(null)).toBeNull()
    expect(parseSnooze({ version: '1', until: 'x' })).toBeNull()
    expect(parseSnooze({ version: '', until: 1 })).toBeNull()
    expect(parseSnooze({ version: '2.31.0', until: 5 })).toEqual({ version: '2.31.0', until: 5 })
  })
})

describe('restore-state codec', () => {
  const snap = snapshotRestore({ pathname: '/sessions/ab12', search: '?tab=chat', hash: '#x' }, 340, '2.31.0', NOW)
  test('round-trips', () => {
    expect(decodeRestore(encodeRestore(snap), NOW + 1000, '2.31.0')).toEqual(snap)
  })
  test('garbage, expiry and wrong target yield null', () => {
    expect(decodeRestore(null, NOW, '2.31.0')).toBeNull()
    expect(decodeRestore('{nope', NOW, '2.31.0')).toBeNull()
    expect(decodeRestore(encodeRestore(snap), NOW + RESTORE_TTL_MS + 1, '2.31.0')).toBeNull()
    expect(decodeRestore(encodeRestore(snap), NOW, '2.30.0')).toBeNull() // still the old bundle
    expect(decodeRestore(encodeRestore(snap), NOW, '2.32.0')?.url).toBe('/sessions/ab12?tab=chat#x')
  })
  test('an unsafe url is never restored', () => {
    for (const u of ['//evil.com', 'https://evil.com', 'javascript:1', '/a\\b'])
      expect(decodeRestore(JSON.stringify({ ...snap, url: u }), NOW, '2.31.0')).toBeNull()
    expect(safeAppUrl('/tasks')).toBe('/tasks')
  })
  test('bad scroll falls back to 0', () => {
    expect(decodeRestore(JSON.stringify({ ...snap, scrollY: -4 }), NOW, '2.31.0')?.scrollY).toBe(0)
  })
})

describe('the popup hands itself to the bell', () => {
  const v = { current: '2.30.0', latest: '2.31.0', critical: false }
  test('install starts the flow and leaves no bell entry', () => {
    expect(promptExit('install', v, NOW)).toEqual({ install: true, snooze: null, bell: null })
  })
  test('closing or timing out leaves the news in the bell, without snoozing', () => {
    for (const exit of ['close', 'timeout'] as const) {
      const o = promptExit(exit, v, NOW)
      expect(o.install).toBe(false)
      expect(o.snooze).toBeNull()
      expect(o.bell).toEqual({ type: 'info', code: UPDATE_NOTICE_CODE, meta: { version: '2.31.0', from: '2.30.0', critical: false } })
    }
  })
  test('remind me later snoozes per version AND leaves the bell entry', () => {
    const o = promptExit('later', v, NOW)
    expect(o.snooze).toEqual({ version: '2.31.0', until: NOW + SNOOZE_MS })
    expect(o.bell?.code).toBe(UPDATE_NOTICE_CODE)
  })
  test('a critical update is a warning in the bell and snoozes briefly', () => {
    const o = promptExit('later', { ...v, critical: true }, NOW)
    expect(o.bell?.type).toBe('warning')
    expect(o.snooze?.until).toBe(NOW + CRITICAL_SNOOZE_MS)
  })
  test('a critical popup stays up longer before leaving', () => {
    expect(promptTimeoutMs(true)).toBeGreaterThan(promptTimeoutMs(false))
  })
  test('the bell code is the one the existing bell entry already uses', () => {
    expect(UPDATE_NOTICE_CODE).toBe('app.update_available')
  })
})


// UPD.NOTIFY — the page read /api/version ONCE, so a tab open when a release shipped never heard of it.
describe('UPD.NOTIFY: the page keeps asking, and a snooze is bounded', () => {
  const T = 1_000_000
  test('an interval check is due every 5 minutes while the tab is visible, never while hidden', () => {
    expect(VERSION_POLL_MS).toBe(5 * 60_000)
    expect(versionRefetchDue({ now: T + VERSION_POLL_MS - 1, lastAt: T, trigger: 'interval', visible: true })).toBe(false)
    expect(versionRefetchDue({ now: T + VERSION_POLL_MS, lastAt: T, trigger: 'interval', visible: true })).toBe(true)
    expect(versionRefetchDue({ now: T + 10 * VERSION_POLL_MS, lastAt: T, trigger: 'interval', visible: false })).toBe(false)
  })
  test('regaining focus checks again after 30 s (not on every alt-tab); the first check always runs', () => {
    expect(versionRefetchDue({ now: T + VERSION_FOCUS_MIN_MS - 1, lastAt: T, trigger: 'focus', visible: true })).toBe(false)
    expect(versionRefetchDue({ now: T + VERSION_FOCUS_MIN_MS, lastAt: T, trigger: 'focus', visible: true })).toBe(true)
    expect(versionRefetchDue({ now: T, lastAt: null, trigger: 'focus', visible: true })).toBe(true)
  })
  test('"remind me later" lasts a bounded few hours (a day was long enough to forget a release), critical sooner', () => {
    expect(SNOOZE_MS).toBe(4 * 60 * 60_000)
    expect(SNOOZE_MS).toBeLessThanOrEqual(24 * 60 * 60_000)
    expect(CRITICAL_SNOOZE_MS).toBe(60 * 60_000)
  })
  test('closing the popup hides ONE version: a newer release shows it again without a reload', () => {
    expect(promptDismissedFor('2.101.1', '2.101.1')).toBe(true)
    expect(promptDismissedFor('2.101.1', '2.102.0')).toBe(false)
    expect(promptDismissedFor(null, '2.102.0')).toBe(false)
  })
})
