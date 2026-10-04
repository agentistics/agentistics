import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { version as CURRENT_VERSION } from '../../../package.json'
import { AGENTISTICS_DATA_DIR } from './config.ts'
import { fetchFirstOk, releasesApiUrls } from './release-source.ts'

export { CURRENT_VERSION }


// ---------------------------------------------------------------------------
// On-disk version cache
//
// `agentop check-update` runs from a shell rc hook on EVERY terminal that opens, and each
// run is a brand new process — so the in-process cache below never helps it: every shell
// paid a live GitHub call (up to the 6s timeout) before the prompt appeared. The verdict is
// therefore persisted to disk and shared by every process on the machine, and the shell hook
// answers from that file only (the refresh happens in a detached process — see bin/cli.ts).
//
// The verdict (`hasUpdate`/`critical`) is relative to the INSTALLED version, so the entry
// records which version it was computed for: after an upgrade the entry no longer applies
// and is ignored rather than claiming a phantom update.
// ---------------------------------------------------------------------------

/** Shared across processes: ~/.agentistics/version-cache.json */
export const VERSION_CACHE_FILE = join(AGENTISTICS_DATA_DIR, 'version-cache.json')
/** How long a successful check stays authoritative before a refresh is due. */
export const VERSION_CACHE_TTL_MS = 3 * 60 * 60 * 1000 // 3 hours
/**
 * How long a "you are up to date" verdict stays authoritative.
 *
 * **The two verdicts are not equally safe to cache, and that is the whole point of this constant.**
 * A stale `hasUpdate: true` costs nothing: the release it names still exists, the banner keeps
 * saying the same true thing, and it clears itself the moment the user upgrades. A stale
 * `hasUpdate: false` is the opposite — it is the machine actively telling someone they are current
 * while a release sits there, and it does it in the SILENT direction, so nobody can tell the
 * difference between "checked, nothing new" and "not checked".
 *
 * Measured, and this is the bug it fixes: a machine on 1.13.7 checked at 21:51 and cached
 * `latest: 1.13.7`. v1.14.0 shipped at 00:52. For the rest of the 3-hour window `check-update`
 * printed NOTHING, and the release looked like it had never been published — including to the
 * person who had just published it.
 *
 * Bounded, not free: the refresh is detached and additionally spaced by `VERSION_RETRY_MS`, so a
 * shorter negative TTL can never turn into hammering — at most one attempt per retry window per
 * machine, and never in front of a shell prompt.
 */
export const VERSION_NEGATIVE_TTL_MS = 10 * 60 * 1000 // 10 minutes (UPD.NOTIFY: a release is noticed within minutes)
/** Minimum spacing between refresh ATTEMPTS — stops 20 shells opening at once (or an
 *  offline machine) from firing 20 GitHub calls. */
export const VERSION_RETRY_MS = 5 * 60 * 1000 // 5 minutes

/**
 * The TTL that applies to THIS entry — PURE.
 *
 * One function so the read path (`isVersionCacheFresh`) and the refresh path
 * (`shouldRefreshVersionCache`) can never disagree about how long an answer lasts. They did not
 * disagree before only because there was a single number; the moment there are two, one place
 * deciding is the difference between a fix and a new bug.
 */
export function ttlFor(entry: VersionCacheEntry, ttlMs: number, negativeTtlMs: number): number {
  return entry.hasUpdate ? ttlMs : Math.min(ttlMs, negativeTtlMs)
}

export interface VersionCacheEntry {
  /** The installed version this verdict was computed against. */
  current: string
  latest: string
  hasUpdate: boolean
  critical: boolean
  /** Last SUCCESSFUL fetch (0 = never succeeded). */
  fetchedAt: number
  /** Last attempt, successful or not — drives the retry spacing. */
  attemptedAt?: number
}

let _cache: VersionCacheEntry | null = null

/** Pure: parse the on-disk cache. Returns null for junk/truncated/foreign content. */
export function parseVersionCache(raw: string): VersionCacheEntry | null {
  try {
    const o = JSON.parse(raw) as Partial<VersionCacheEntry>
    if (!o || typeof o.current !== 'string' || typeof o.latest !== 'string') return null
    if (typeof o.fetchedAt !== 'number' || !Number.isFinite(o.fetchedAt)) return null
    return {
      current: o.current,
      latest: o.latest,
      hasUpdate: o.hasUpdate === true,
      critical: o.critical === true,
      fetchedAt: o.fetchedAt,
      attemptedAt: typeof o.attemptedAt === 'number' && Number.isFinite(o.attemptedAt)
        ? o.attemptedAt
        : undefined,
    }
  } catch {
    return null
  }
}

/**
 * Pure: may the IN-PROCESS answer still be served? The same rule as the disk cache (`ttlFor`): a known
 * update keeps the long TTL, "you are up to date" only the short negative one. The in-process layer used to
 * have its own 1-hour number, so a long-running server kept saying "up to date" for an hour after a release.
 */
export function isInProcessFresh(entry: VersionCacheEntry | null, now: number, current: string): boolean {
  return isVersionCacheFresh(entry, now, current)
}

/** Pure: is the entry a still-authoritative answer for `current`? */
export function isVersionCacheFresh(
  entry: VersionCacheEntry | null,
  now: number,
  current: string,
  ttlMs: number = VERSION_CACHE_TTL_MS,
  negativeTtlMs: number = VERSION_NEGATIVE_TTL_MS,
): boolean {
  if (!entry || entry.current !== current || entry.fetchedAt <= 0) return false
  return now - entry.fetchedAt < ttlFor(entry, ttlMs, negativeTtlMs)
}

/**
 * Pure: the last verdict we can still stand behind, or null when there is none.
 * Deliberately age-tolerant — a stale-but-real answer is what the shell hook prints while
 * a background refresh runs; a verdict for a DIFFERENT installed version is never reused.
 */
export function cachedVersionInfo(entry: VersionCacheEntry | null, current: string): VersionInfo | null {
  if (!entry || entry.current !== current || entry.fetchedAt <= 0) return null
  return { current, latest: entry.latest, hasUpdate: entry.hasUpdate, critical: entry.critical }
}

/**
 * Pure: should a refresh run now? Never more often than VERSION_RETRY_MS (attempt spacing,
 * which also throttles a machine that is offline), and only once the entry is past its TTL.
 */
export function shouldRefreshVersionCache(
  entry: VersionCacheEntry | null,
  now: number,
  current: string,
  ttlMs: number = VERSION_CACHE_TTL_MS,
  retryMs: number = VERSION_RETRY_MS,
  negativeTtlMs: number = VERSION_NEGATIVE_TTL_MS,
): boolean {
  if (!entry || entry.current !== current) return true
  const attempted = entry.attemptedAt ?? entry.fetchedAt
  // The retry floor still applies, and it is what keeps the shorter negative TTL from becoming
  // traffic: an up-to-date verdict goes stale at 30 minutes but is re-asked at most every 15.
  if (now - attempted < retryMs) return false
  return now - entry.fetchedAt >= ttlFor(entry, ttlMs, negativeTtlMs)
}

/** Reads the shared cache file. Never throws. */
export function readVersionCache(): VersionCacheEntry | null {
  try {
    return parseVersionCache(readFileSync(VERSION_CACHE_FILE, 'utf8'))
  } catch {
    return null
  }
}

/** Writes the shared cache file. Best-effort — a read-only HOME must not break the check. */
function writeVersionCache(entry: VersionCacheEntry): void {
  try {
    mkdirSync(AGENTISTICS_DATA_DIR, { recursive: true })
    writeFileSync(VERSION_CACHE_FILE, JSON.stringify(entry))
  } catch { /* best-effort */ }
}

/** Strict semver pattern (major.minor.patch). Non-matching tags (e.g. the
 *  rolling "latest" release tag) are ignored when resolving the newest version. */
const SEMVER_RE = /^\d+\.\d+\.\d+$/

/** Normalizes a tag to a bare semver string, or null if it isn't semver. */
function toSemver(tag: string): string | null {
  const v = tag.replace(/^v/, '').trim()
  return SEMVER_RE.test(v) ? v : null
}

/** Compares two semver strings. Returns positive if a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export interface VersionInfo {
  current: string
  latest: string
  hasUpdate: boolean
  /** True when at least one release newer than `current` is flagged critical
   *  (see isCriticalRelease). Critical updates are installed without consent. */
  critical: boolean
}

/** The shape we read from the GitHub releases API (only the fields we use). */
export interface ReleaseLike {
  tag_name: string
  body?: string | null
  draft?: boolean
  prerelease?: boolean
}

/** Opening/closing fence of a markdown code block (``` or ~~~, up to 3 spaces of indent). */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
/**
 * The marker owning its line. At most 3 leading spaces: 4+ spaces is an INDENTED code
 * block in markdown, i.e. documentation of the marker rather than the marker itself.
 */
const MARKER_RE = /^ {0,3}\[critical\][ \t]*$/i

/**
 * A release is CRITICAL when its body contains a `[critical]` marker on a line of
 * its own (case-insensitive, surrounding whitespace allowed) OUTSIDE any code block.
 *
 * The marker deliberately lives in the release BODY, never in the tag: the tag must
 * stay pure semver or the highest-semver selection above would stop recognizing it.
 * Requiring the marker to own its line keeps prose such as "fixes a critical bug"
 * or "[critical] only when X" from triggering an unattended upgrade.
 *
 * Fenced (``` / ~~~) and indented regions are skipped: release notes that DOCUMENT the
 * mechanism ("mark a release critical with:\n```\n[critical]\n```") would otherwise flag
 * themselves and force an unattended install onto every machine that opens a terminal.
 * Closing a fence requires the same character, at least the opening length, and nothing
 * but whitespace after it — so a fence never silently "ends" on a content line.
 */
export function isCriticalRelease(body: string | null | undefined): boolean {
  if (!body) return false
  let openChar = ''
  let openLen = 0
  for (const line of body.split(/\r?\n/)) {
    const fence = line.match(FENCE_RE)
    if (fence) {
      const ticks = fence[1]!
      const rest = fence[2] ?? ''
      if (!openChar) {
        openChar = ticks[0]!
        openLen = ticks.length
        continue
      }
      if (ticks[0] === openChar && ticks.length >= openLen && rest.trim() === '') {
        openChar = ''
        openLen = 0
      }
      continue // still inside the block (a non-matching fence line is just content)
    }
    if (openChar) continue // inside a fenced block — markers there are documentation
    if (MARKER_RE.test(line)) return true
  }
  return false
}

/**
 * Whether a critical release may install itself with no consent.
 *
 * STILL OPT-IN. The install path itself is now hardened — platform/arch gated, unique temp file,
 * lock held across the whole install, download verified (size + executable magic + the new
 * binary's own `--version`), previous binary backed up and restored on failure, restart failures
 * surfaced, and a persisted backoff so a permanently-failing update stops re-downloading. Flipping
 * the default to opt-out is a separate, reviewed change: a wrong default here does not inconvenience
 * one user, it reaches every install that opens a terminal.
 */
export function autoInstallAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.AGENTISTICS_AUTO_UPGRADE === '1'
}

/**
 * Pure resolution of a GitHub release list against the installed version.
 *
 * Drafts and prereleases are ignored, as are non-semver tags (the repo also publishes a
 * rolling "latest" release). `critical` looks at EVERY release newer than the installed
 * one — not just the newest — so a critical fix released before a later optional one is
 * still installed automatically.
 */
export function resolveLatestRelease(
  releases: ReleaseLike[],
  current: string,
): { latest: string; hasUpdate: boolean; critical: boolean } {
  const published = releases
    .filter(r => !r.draft && !r.prerelease)
    .map(r => ({ version: toSemver(r.tag_name), body: r.body ?? null }))
    .filter((r): r is { version: string; body: string | null } => r.version !== null)

  const latest = published
    .map(r => r.version)
    .sort((a, b) => compareVersions(b, a))[0]
    ?? current
  const hasUpdate = compareVersions(latest, current) > 0
  const critical = hasUpdate && published.some(
    r => compareVersions(r.version, current) > 0 && isCriticalRelease(r.body),
  )
  return { latest, hasUpdate, critical }
}

/**
 * Fetches the latest GitHub release and compares with the current version.
 *
 * Answers from the in-process cache (1h), then the shared on-disk cache (VERSION_CACHE_TTL_MS),
 * and only then hits the network. On network failure the last known verdict is returned when we
 * have one (better than pretending there is no update), otherwise "no update".
 *
 * `force: true` skips both caches — used by the detached refresh that keeps the disk cache warm.
 */
export async function getVersionInfo(opts: { force?: boolean } = {}): Promise<VersionInfo> {
  const now = Date.now()
  if (!opts.force) {
    if (isInProcessFresh(_cache, now, CURRENT_VERSION)) {
      return {
        current: CURRENT_VERSION,
        latest: _cache!.latest,
        hasUpdate: _cache!.hasUpdate,
        critical: _cache!.critical,
      }
    }
    const disk = readVersionCache()
    if (isVersionCacheFresh(disk, now, CURRENT_VERSION)) {
      _cache = disk
      return cachedVersionInfo(disk, CURRENT_VERSION)!
    }
  }

  try {
    // List releases and pick the highest *semver* tag. We can't use
    // /releases/latest because this repo also publishes a rolling "latest"
    // tagged release, which /releases/latest returns (tag_name "latest" is not
    // semver and would never compare as an update).
    // Both owners, new first — see release-source.ts for why the old one is still asked.
    const resp = await fetchFirstOk(
      releasesApiUrls(30),
      {
        headers: {
          'Accept': 'application/vnd.github+json',
          'User-Agent': `agentistics/${CURRENT_VERSION}`,
        },
        signal: AbortSignal.timeout(6000),
      },
    )
    if (!resp.ok) throw new Error(`GitHub API ${resp.status}`)
    const releases = await resp.json() as ReleaseLike[]
    const { latest, hasUpdate, critical } = resolveLatestRelease(releases, CURRENT_VERSION)
    _cache = { current: CURRENT_VERSION, latest, hasUpdate, critical, fetchedAt: now, attemptedAt: now }
    writeVersionCache(_cache)
    return { current: CURRENT_VERSION, latest, hasUpdate, critical }
  } catch {
    // Network unavailable or rate-limited. Stamp the attempt so the next shells don't retry
    // immediately (VERSION_RETRY_MS), and fall back to the last verdict we actually got.
    const prev = readVersionCache()
    const kept = prev && prev.current === CURRENT_VERSION ? prev : null
    writeVersionCache({
      current: CURRENT_VERSION,
      latest: kept?.latest ?? CURRENT_VERSION,
      hasUpdate: kept?.hasUpdate ?? false,
      critical: kept?.critical ?? false,
      fetchedAt: kept?.fetchedAt ?? 0,
      attemptedAt: now,
    })
    return cachedVersionInfo(kept, CURRENT_VERSION)
      ?? { current: CURRENT_VERSION, latest: CURRENT_VERSION, hasUpdate: false, critical: false }
  }
}

const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 hours
let _recheckTimer: ReturnType<typeof setInterval> | null = null
/** Latest version we've already broadcast, so we don't re-notify every tick. */
let _lastBroadcastVersion: string | null = null

/**
 * Starts a best-effort periodic re-check (default every 6h) so a long-running
 * daemon surfaces new releases without a page reload. Each tick refreshes the
 * cache via getVersionInfo and, when an update is newly available (a version we
 * haven't broadcast yet), pushes an SSE `app.update_available` notification to
 * connected dashboards. Idempotent — calling twice is a no-op. Never throws.
 */
export function startVersionRecheck(intervalMs: number = RECHECK_INTERVAL_MS): void {
  if (_recheckTimer) return
  const tick = async () => {
    try {
      const info = await getVersionInfo()
      if (info.hasUpdate && info.latest !== _lastBroadcastVersion) {
        _lastBroadcastVersion = info.latest
        const { broadcastNotification } = await import('./sse')
        broadcastNotification({ type: 'info', code: 'app.update_available', meta: { version: info.latest } })
      }
    } catch { /* best-effort — never crash the daemon */ }
  }
  _recheckTimer = setInterval(() => { void tick() }, intervalMs)
  // Don't keep the process alive solely for this timer.
  if (typeof _recheckTimer === 'object' && _recheckTimer && 'unref' in _recheckTimer) {
    ;(_recheckTimer as { unref: () => void }).unref()
  }
  // Kick off an initial check shortly after boot (deferred so startup isn't blocked).
  setTimeout(() => { void tick() }, 30_000)
}
