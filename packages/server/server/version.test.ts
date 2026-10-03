import { describe, test, expect } from 'bun:test'
import {
  compareVersions,
  isCriticalRelease,
  autoInstallAllowed,
  resolveLatestRelease,
  parseVersionCache,
  isVersionCacheFresh,
  cachedVersionInfo,
  shouldRefreshVersionCache,
  VERSION_CACHE_TTL_MS,
  VERSION_NEGATIVE_TTL_MS,
  VERSION_RETRY_MS,
  isInProcessFresh,
} from './version'
// The unattended-upgrade lock lives in upgrade.ts, but its pure helpers are part of the
// same "smart auto-update" surface, so they are covered here alongside the version logic.
import { isInstalledBinary, isUpgradeLockActive, parseUpgradeLock, UPGRADE_LOCK_TTL_MS } from './upgrade'

test('compareVersions orders semver correctly', () => {
  expect(compareVersions('1.5.4', '1.5.3')).toBeGreaterThan(0)
  expect(compareVersions('1.5.3', '1.5.4')).toBeLessThan(0)
  expect(compareVersions('1.5.4', '1.5.4')).toBe(0)
  expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0)
  expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
})

// Picking the newest semver tag from a release list, ignoring the rolling
// "latest" tag — this is the logic that drives the in-app update banner.
const SEMVER_RE = /^\d+\.\d+\.\d+$/
function pickLatest(tags: string[], current: string): string {
  return tags
    .map(t => t.replace(/^v/, '').trim())
    .filter(v => SEMVER_RE.test(v))
    .sort((a, b) => compareVersions(b, a))[0] ?? current
}

test('newest semver tag is chosen, rolling "latest" tag ignored', () => {
  expect(pickLatest(['latest', 'v1.5.4', 'v1.5.3', 'v1.5.10'], '1.5.4')).toBe('1.5.10')
  expect(pickLatest(['latest'], '1.5.4')).toBe('1.5.4') // no semver → fall back to current (no false update)
})

// --- criticality marker -----------------------------------------------------

test('isCriticalRelease requires the [critical] marker on its own line', () => {
  expect(isCriticalRelease('[critical]')).toBe(true)
  expect(isCriticalRelease('  [critical]  ')).toBe(true)          // surrounding whitespace ok
  expect(isCriticalRelease('[CRITICAL]')).toBe(true)              // case-insensitive
  expect(isCriticalRelease('[Critical]')).toBe(true)
  expect(isCriticalRelease('## Fixes\n\n[critical]\n\n- data loss on sync')).toBe(true) // inside a longer body
  expect(isCriticalRelease('- fix\r\n[critical]\r\n- more')).toBe(true) // CRLF release notes
})

test('isCriticalRelease ignores prose and inline mentions', () => {
  expect(isCriticalRelease('Fixes a critical bug in the uploader.')).toBe(false)
  expect(isCriticalRelease('This is [critical] for team mode.')).toBe(false) // inline, not its own line
  expect(isCriticalRelease('[critical-ish]')).toBe(false)
  expect(isCriticalRelease('[ critical ]')).toBe(false)           // exact bracket form only
  expect(isCriticalRelease('')).toBe(false)
  expect(isCriticalRelease(null)).toBe(false)
  expect(isCriticalRelease(undefined)).toBe(false)
})

test('isCriticalRelease ignores markers inside code fences', () => {
  // Release notes that DOCUMENT the mechanism must not flag themselves — that single false
  // positive would force an unattended install onto every machine that opens a terminal.
  expect(isCriticalRelease('To force an install, add:\n\n```\n[critical]\n```\n')).toBe(false)
  expect(isCriticalRelease('```markdown\n[critical]\n```')).toBe(false)   // fence with an info string
  expect(isCriticalRelease('~~~\n[critical]\n~~~')).toBe(false)           // tilde fence
  expect(isCriticalRelease('````\n```\n[critical]\n```\n````')).toBe(false) // nested/longer fence
  expect(isCriticalRelease('    [critical]')).toBe(false)                // 4-space indented code block
  // An unterminated fence swallows the rest of the body rather than re-opening it.
  expect(isCriticalRelease('```\n[critical]')).toBe(false)
  // ...but a marker OUTSIDE the fence still counts, before or after it.
  expect(isCriticalRelease('[critical]\n\n```\nsome code\n```')).toBe(true)
  expect(isCriticalRelease('```\nsome code\n```\n\n[critical]')).toBe(true)
  expect(isCriticalRelease('```js\nconst x = 1\n```\n[critical]\nfixes data loss')).toBe(true)
})

// --- resolveLatestRelease ---------------------------------------------------

test('resolveLatestRelease picks the newest published semver and flags criticality', () => {
  const releases = [
    { tag_name: 'latest', body: '[critical]' },       // rolling tag — never a version
    { tag_name: 'v1.6.0', body: 'routine polish' },
    { tag_name: 'v1.5.9', body: '[critical]\nfixes data loss' },
    { tag_name: 'v1.5.8', body: 'nothing to see' },
  ]
  // A critical release BETWEEN current and latest still forces the upgrade.
  expect(resolveLatestRelease(releases, '1.5.8')).toEqual({ latest: '1.6.0', hasUpdate: true, critical: true })
  // Already past the critical one → newer release is optional.
  expect(resolveLatestRelease(releases, '1.5.9')).toEqual({ latest: '1.6.0', hasUpdate: true, critical: false })
  // Up to date → never critical, never an update.
  expect(resolveLatestRelease(releases, '1.6.0')).toEqual({ latest: '1.6.0', hasUpdate: false, critical: false })
})

test('resolveLatestRelease ignores drafts and prereleases', () => {
  const releases = [
    { tag_name: 'v2.0.0', body: '[critical]', draft: true },
    { tag_name: 'v1.9.0', body: '[critical]', prerelease: true },
    { tag_name: 'v1.6.0', body: 'stable' },
  ]
  expect(resolveLatestRelease(releases, '1.5.0')).toEqual({ latest: '1.6.0', hasUpdate: true, critical: false })
  // No usable release at all → fall back to current, no false update.
  expect(resolveLatestRelease([], '1.5.0')).toEqual({ latest: '1.5.0', hasUpdate: false, critical: false })
})

// --- shared on-disk version cache -------------------------------------------
// The shell rc hook runs `agentop check-update` in a NEW process on every terminal, so the
// in-process cache never helped it. These helpers decide what that process may answer from
// disk and when a (detached) refresh is due.

const entry = (over: Partial<ReturnType<typeof parseVersionCache>> = {}) => ({
  current: '1.7.0', latest: '1.8.0', hasUpdate: true, critical: false, fetchedAt: 1_700_000_000_000,
  ...(over as object),
}) as NonNullable<ReturnType<typeof parseVersionCache>>

test('parseVersionCache accepts a valid entry and rejects junk', () => {
  expect(parseVersionCache('{"current":"1.7.0","latest":"1.8.0","hasUpdate":true,"critical":true,"fetchedAt":5}'))
    .toEqual({ current: '1.7.0', latest: '1.8.0', hasUpdate: true, critical: true, fetchedAt: 5, attemptedAt: undefined })
  expect(parseVersionCache('nope')).toBeNull()
  expect(parseVersionCache('{"latest":"1.8.0","fetchedAt":5}')).toBeNull()      // no `current`
  expect(parseVersionCache('{"current":"1.7.0","latest":"1.8.0"}')).toBeNull()  // no timestamp
})

test('a cached verdict is only reused for the version it was computed against', () => {
  const now = entry().fetchedAt + 1000
  expect(isVersionCacheFresh(entry(), now, '1.7.0')).toBe(true)
  // After the upgrade landed, the old "1.8.0 is available" verdict is meaningless.
  expect(isVersionCacheFresh(entry(), now, '1.8.0')).toBe(false)
  expect(cachedVersionInfo(entry(), '1.8.0')).toBeNull()
  expect(cachedVersionInfo(entry(), '1.7.0'))
    .toEqual({ current: '1.7.0', latest: '1.8.0', hasUpdate: true, critical: false })
  // A failure-only entry (attempt stamped, never a successful fetch) is not an answer.
  expect(cachedVersionInfo(entry({ fetchedAt: 0, attemptedAt: now }), '1.7.0')).toBeNull()
  expect(isVersionCacheFresh(null, now, '1.7.0')).toBe(false)
})

test('an "up to date" verdict goes stale far sooner than an "update available" one', () => {
  // The bug, measured: a machine on 1.13.7 checked at 21:51 and cached `latest: 1.13.7`. v1.14.0
  // shipped at 00:52 — inside the 3-hour window — and `check-update` stayed SILENT for the rest of
  // it. Silence is indistinguishable from "checked, nothing new", so the release looked unpublished.
  const negative = entry({ latest: '1.7.0', hasUpdate: false })
  const justPastNegative = negative.fetchedAt + VERSION_NEGATIVE_TTL_MS + 1

  expect(isVersionCacheFresh(negative, justPastNegative, '1.7.0')).toBe(false)
  // …while the positive verdict at the very same age is still good: it names a release that still
  // exists, keeps saying the same true thing, and clears itself on upgrade.
  expect(isVersionCacheFresh(entry(), justPastNegative, '1.7.0')).toBe(true)

  // And the refresh path agrees with the read path — one `ttlFor`, so they cannot drift apart.
  const attempted = { attemptedAt: negative.fetchedAt }
  expect(shouldRefreshVersionCache({ ...negative, ...attempted }, justPastNegative, '1.7.0')).toBe(true)
  expect(shouldRefreshVersionCache({ ...entry(), ...attempted }, justPastNegative, '1.7.0')).toBe(false)
})

test('the shorter negative TTL still cannot become traffic', () => {
  // The retry floor outranks it: stale at 30 minutes, re-asked at most every 15.
  const negative = entry({ latest: '1.7.0', hasUpdate: false })
  const inRetryWindow = negative.fetchedAt + VERSION_RETRY_MS - 1
  expect(shouldRefreshVersionCache(
    { ...negative, attemptedAt: negative.fetchedAt }, inRetryWindow, '1.7.0',
  )).toBe(false)
})

test('a stale entry is past its TTL but still printable', () => {
  const stale = entry()
  const now = stale.fetchedAt + VERSION_CACHE_TTL_MS + 1
  expect(isVersionCacheFresh(stale, now, '1.7.0')).toBe(false)  // getVersionInfo would refetch
  // ...yet the shell hook still shows the last real answer instead of going silent or blocking.
  expect(cachedVersionInfo(stale, '1.7.0')?.latest).toBe('1.8.0')
})

test('refreshes are due only past the TTL and never more often than the retry window', () => {
  const base = entry()
  const t = base.fetchedAt
  expect(shouldRefreshVersionCache(base, t + 1000, '1.7.0')).toBe(false)                       // fresh
  expect(shouldRefreshVersionCache(base, t + VERSION_CACHE_TTL_MS, '1.7.0')).toBe(true)        // due
  expect(shouldRefreshVersionCache(null, t, '1.7.0')).toBe(true)                               // nothing cached
  expect(shouldRefreshVersionCache(base, t + 1000, '1.8.0')).toBe(true)                        // version changed
  // 20 shells opening at once (or an offline machine) must not fire 20 GitHub calls: the last
  // ATTEMPT — successful or not — throttles the next one.
  const failed = entry({ fetchedAt: 0, attemptedAt: t })
  expect(shouldRefreshVersionCache(failed, t + VERSION_RETRY_MS - 1, '1.7.0')).toBe(false)
  expect(shouldRefreshVersionCache(failed, t + VERSION_RETRY_MS, '1.7.0')).toBe(true)
})

// --- unattended-upgrade lock ------------------------------------------------

test('parseUpgradeLock accepts a valid lock and rejects junk', () => {
  expect(parseUpgradeLock('{"pid":42,"version":"1.6.0","startedAt":1000}'))
    .toEqual({ pid: 42, version: '1.6.0', startedAt: 1000 })
  expect(parseUpgradeLock('not json')).toBeNull()
  expect(parseUpgradeLock('{"version":"1.6.0"}')).toBeNull()   // no pid
  expect(parseUpgradeLock('{"pid":0}')).toBeNull()             // invalid pid
  expect(parseUpgradeLock('{"pid":"42"}')).toBeNull()
})

test('unattended upgrade only runs from the installed binary, never a source checkout', () => {
  expect(isInstalledBinary('/home/u/.local/bin/agentop', undefined)).toBe(true)
  expect(isInstalledBinary('C:\\tools\\agentop.exe', undefined)).toBe(true)
  // `bun packages/server/bin/cli.ts` — execPath is the bun runtime, replacing it would
  // clobber the user's bun install.
  expect(isInstalledBinary('/home/u/.bun/bin/bun', '/repo/packages/server/bin/cli.ts')).toBe(false)
  expect(isInstalledBinary('/usr/bin/node', '/repo/dist/cli.js')).toBe(false)
  expect(isInstalledBinary('/home/u/.bun/bin/bun', undefined)).toBe(false)
})

test('a lock is active only while its process lives and it is younger than the TTL', () => {
  const alive = () => true
  const dead = () => false
  const lock = { pid: 42, version: '1.6.0', startedAt: 1_000 }
  expect(isUpgradeLockActive(lock, 2_000, alive)).toBe(true)
  expect(isUpgradeLockActive(lock, 2_000, dead)).toBe(false)               // crashed upgrade
  expect(isUpgradeLockActive(lock, 1_000 + UPGRADE_LOCK_TTL_MS, alive)).toBe(false) // abandoned
  expect(isUpgradeLockActive(null, 2_000, alive)).toBe(false)              // no lock at all
})

test('unattended install is opt-in: only an explicit AGENTISTICS_AUTO_UPGRADE=1 enables it', () => {
  // Guards the DEFAULT, not the mechanism. Flipping this back to opt-out re-arms an unverified,
  // non-atomic, arch-blind binary replacement on every shell that opens.
  expect(autoInstallAllowed({})).toBe(false)
  expect(autoInstallAllowed({ AGENTISTICS_AUTO_UPGRADE: undefined })).toBe(false)
  expect(autoInstallAllowed({ AGENTISTICS_AUTO_UPGRADE: '' })).toBe(false)
  expect(autoInstallAllowed({ AGENTISTICS_AUTO_UPGRADE: '0' })).toBe(false)
  expect(autoInstallAllowed({ AGENTISTICS_AUTO_UPGRADE: 'true' })).toBe(false)
  expect(autoInstallAllowed({ AGENTISTICS_AUTO_UPGRADE: 'yes' })).toBe(false)
  expect(autoInstallAllowed({ AGENTISTICS_AUTO_UPGRADE: '1' })).toBe(true)
})


// UPD.NOTIFY — a release must reach the popup within MINUTES. The owner never saw v2.99–v2.101.1:
// the in-process layer answered "up to date" for a full hour (it ignored the negative TTL the disk cache
// has), on top of a 30-minute negative TTL and a 15-minute retry floor.
describe('UPD.NOTIFY: how soon a release is noticed', () => {
  const upToDate = { current: '1.0.0', latest: '1.0.0', hasUpdate: false, critical: false, fetchedAt: 1_000_000 }
  const available = { ...upToDate, latest: '1.1.0', hasUpdate: true }

  test('the up-to-date verdict is stale after 10 minutes and a refresh is allowed every 5', () => {
    expect(VERSION_NEGATIVE_TTL_MS).toBe(10 * 60_000)
    expect(VERSION_RETRY_MS).toBe(5 * 60_000)
  })

  test('the in-process cache honours the SAME negative TTL as the disk cache (it used to hold "up to date" for an hour)', () => {
    expect(isInProcessFresh(upToDate, upToDate.fetchedAt + VERSION_NEGATIVE_TTL_MS - 1, '1.0.0')).toBe(true)
    expect(isInProcessFresh(upToDate, upToDate.fetchedAt + VERSION_NEGATIVE_TTL_MS, '1.0.0')).toBe(false)
  })

  test('a known update keeps the long TTL (a stale "update available" costs nothing); another installed version never applies', () => {
    expect(isInProcessFresh(available, available.fetchedAt + 60 * 60_000, '1.0.0')).toBe(true)
    expect(isInProcessFresh(upToDate, upToDate.fetchedAt + 1, '1.0.1')).toBe(false)
    expect(isInProcessFresh(null, 5, '1.0.0')).toBe(false)
  })
})
