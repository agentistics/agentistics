/**
 * updateToast.ts — PURE: the rules of the "new version" popup the Nay window shows, its handoff to
 * the bell, plus the codec for the page state restored after an in-place upgrade. The components
 * (`components/nay/NayUpdateCard.tsx`, `UpdateModal.tsx`) only draw and perform; every decision is
 * here so it is tested without a browser.
 *
 * There is NO second upgrade path. "Install now" — in the popup or in the bell's sheet — calls the
 * one `startUpgrade` (`upgradeFlow.ts`), which posts to `/api/upgrade` and waits with
 * `upgradeArrived` (appReload.ts); this module adds only WHEN to offer it, how long "remind me
 * later" lasts, where the popup goes when it leaves, and how to land back where the person was.
 */

export interface VersionAnswer {
  current: string
  latest: string
  hasUpdate: boolean
  critical?: boolean
  /** `null`/absent-with-hasUpdate = installable here; a string is the upgrade-gate refusal code. */
  upgradable?: string | null
}

/** A snooze belongs to ONE version: a newer release re-shows the toast whatever is stored. */
export interface Snooze { version: string; until: number }

export const SNOOZE_MS = 24 * 60 * 60_000
/** A critical update comes back sooner — it is the one a person should not forget for a day. */
export const CRITICAL_SNOOZE_MS = 60 * 60_000

const nums = (v: string) => v.replace(/^v/, '').split('.').map(n => parseInt(n, 10))

/** Is `a` strictly newer than `b`? Unparseable versions are never "newer" (no toast on a guess). */
export function isNewer(a: string, b: string): boolean {
  const x = nums(a), y = nums(b)
  if (x.some(Number.isNaN) || y.some(Number.isNaN)) return false
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return false
}

export function snoozeFor(version: string, critical: boolean, now: number): Snooze {
  return { version, until: now + (critical ? CRITICAL_SNOOZE_MS : SNOOZE_MS) }
}

/** Total: anything that is not a well-formed snooze reads as "none". */
export function parseSnooze(raw: unknown): Snooze | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.version !== 'string' || !o.version) return null
  if (typeof o.until !== 'number' || !Number.isFinite(o.until)) return null
  return { version: o.version, until: o.until }
}

/** Is this snooze still silencing `latest` at `now`? A different (newer) version never is. */
export function snoozeActive(s: Snooze | null, latest: string, now: number): boolean {
  if (!s) return false
  if (s.version.replace(/^v/, '') !== latest.replace(/^v/, '')) return false
  return now < s.until
}

export type ToastVerdict =
  | { show: true }
  | { show: false; why: 'no-update' | 'central' | 'not-installable' | 'snoozed' }

/**
 * Should the toast appear? LOCAL installs only: a central, a container, a source checkout and a
 * profile without host power never see it (the modal keeps explaining those by hand). `upgradable`
 * undefined means an older server that does not say — then the toast stays away rather than offer
 * a button the route may refuse.
 */
export function shouldShowToast(o: {
  info: VersionAnswer | null
  snooze: Snooze | null
  now: number
  central: boolean
}): ToastVerdict {
  const { info } = o
  if (o.central) return { show: false, why: 'central' }
  if (!info || !info.hasUpdate || !isNewer(info.latest, info.current)) return { show: false, why: 'no-update' }
  if (info.upgradable !== null) return { show: false, why: 'not-installable' }
  if (snoozeActive(o.snooze, info.latest, o.now)) return { show: false, why: 'snoozed' }
  return { show: true }
}

// ---- the page state carried across the upgrade ---------------------------------------------

export const RESTORE_KEY = 'agentistics-upgrade-restore'
/** A saved state older than this is not "where I was" any more. */
export const RESTORE_TTL_MS = 15 * 60_000

export interface RestoreState {
  /** pathname + search + hash — the route, which also names the open session (`/sessions/:id`). */
  url: string
  scrollY: number
  /** The version the upgrade was for, so a restore only fires on the bundle that arrived. */
  target: string
  savedAt: number
}

/** Only same-origin app paths: a stored value must never become an open redirect. */
export function safeAppUrl(u: unknown): string | null {
  if (typeof u !== 'string' || !u.startsWith('/') || u.startsWith('//') || u.includes('\\')) return null
  return u.length <= 2048 ? u : null
}

export function encodeRestore(s: RestoreState): string {
  return JSON.stringify(s)
}

/** Total: garbage, expiry, a wrong version and an unsafe URL all yield `null`. */
export function decodeRestore(raw: string | null, now: number, currentVersion: string): RestoreState | null {
  if (!raw) return null
  let o: unknown
  try { o = JSON.parse(raw) } catch { return null }
  if (!o || typeof o !== 'object') return null
  const r = o as Record<string, unknown>
  const url = safeAppUrl(r.url)
  if (!url || typeof r.target !== 'string' || typeof r.savedAt !== 'number' || !Number.isFinite(r.savedAt)) return null
  if (now - r.savedAt > RESTORE_TTL_MS || now < r.savedAt - 60_000) return null
  // Restore only on the bundle the upgrade was for (or a newer one).
  if (isNewer(r.target, currentVersion)) return null
  const scrollY = typeof r.scrollY === 'number' && Number.isFinite(r.scrollY) && r.scrollY > 0 ? r.scrollY : 0
  return { url, scrollY, target: r.target, savedAt: r.savedAt }
}

/** Where the page is now, as a `RestoreState` (the pure half; the caller reads `location`). */
export function snapshotRestore(loc: { pathname: string; search: string; hash: string }, scrollY: number, target: string, now: number): RestoreState {
  return { url: `${loc.pathname}${loc.search}${loc.hash}`, scrollY, target, savedAt: now }
}

// ---- the popup's exit, and the bell ------------------------------------------------------------

/** The bell entry's code. The popup is the live surface and the bell is its record, so the toast
 *  layer never pops this one (`NotificationToasts`): it would be the same news twice. */
export const UPDATE_NOTICE_CODE = 'app.update_available'

/** How long the popup stays before it hands itself to the bell. A critical one stays longer. */
export const PROMPT_TIMEOUT_MS = 15_000
export const CRITICAL_PROMPT_TIMEOUT_MS = 45_000

export function promptTimeoutMs(critical: boolean): number {
  return critical ? CRITICAL_PROMPT_TIMEOUT_MS : PROMPT_TIMEOUT_MS
}

export type PromptExit = 'install' | 'later' | 'close' | 'timeout'

export interface PromptOutcome {
  /** Start the one install flow. */
  install: boolean
  /** Store this per-person snooze ("remind me later" only). */
  snooze: Snooze | null
  /** Leave a bell entry — clickable, leading to the same install flow. */
  bell: { type: 'info' | 'warning'; code: string; meta: { version: string; from: string; critical: boolean } } | null
}

/**
 * What leaving the popup does. Every way out except installing leaves the news in the bell —
 * "closed" and "timed out" are not "not interested", they are "not now". Only "remind me later"
 * also snoozes, so the popup itself stops coming back for a while; closing it hides it for this
 * page only. A critical update's bell entry is a warning.
 */
export function promptExit(exit: PromptExit, info: Pick<VersionAnswer, 'current' | 'latest' | 'critical'>, now: number): PromptOutcome {
  if (exit === 'install') return { install: true, snooze: null, bell: null }
  const critical = info.critical === true
  return {
    install: false,
    snooze: exit === 'later' ? snoozeFor(info.latest, critical, now) : null,
    bell: { type: critical ? 'warning' : 'info', code: UPDATE_NOTICE_CODE, meta: { version: info.latest, from: info.current, critical } },
  }
}
