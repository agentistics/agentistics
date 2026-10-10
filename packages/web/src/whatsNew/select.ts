/**
 * select.ts — which release notes to show, pure.
 *
 * `from` is the last version the person had seen, `to` the one running now. Every version in the
 * half-open range (from, to] that HAS an entry is returned, newest first; a version with no entry
 * contributes nothing, and a range with none yields an empty list (no notification at all).
 */
import { RELEASES, type ReleaseNotes } from './releases'

export interface ReleaseEntry extends ReleaseNotes { version: string }

const bare = (v: string | null | undefined) => (v ?? '').trim().replace(/^v/, '')

/** Numeric dotted compare; null when either side is not a plain x.y.z. */
export function compareVersions(a: string, b: string): number | null {
  const pa = bare(a).split('.').map(Number)
  const pb = bare(b).split('.').map(Number)
  if (pa.length < 1 || pb.length < 1 || [...pa, ...pb].some(n => !Number.isInteger(n) || n < 0)) return null
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

export function releasesBetween(from: string | null | undefined, to: string, table: Record<string, ReleaseNotes> = RELEASES): ReleaseEntry[] {
  const hi = bare(to)
  if (!hi) return []
  const lo = bare(from)
  const out: ReleaseEntry[] = []
  for (const [version, notes] of Object.entries(table)) {
    const vsHi = compareVersions(version, hi)
    if (vsHi === null || vsHi > 0) continue
    if (lo) {
      const vsLo = compareVersions(version, lo)
      if (vsLo === null || vsLo <= 0) continue
    }
    if (notes.features.length === 0 && notes.fixes.length === 0) continue
    out.push({ version, ...notes })
  }
  return out.sort((x, y) => compareVersions(y.version, x.version) ?? 0)
}

export const SEEN_KEY = 'ag-whats-new-seen'

/** How many releases a MANUAL open (the version label, Settings) shows when no "from" is given. */
export const MANUAL_OPEN_COUNT = 3

/**
 * Which version to remember as "last seen" after a load of `current`. It only ever moves FORWARD:
 * the value is shared by every device of the person, so a stale bundle on one (a downgrade, an
 * old PWA) must not rewind it and make the others announce the same release again. Returns null
 * when nothing should be written.
 */
export function nextSeen(current: string | null | undefined, seen: string | null | undefined): string | null {
  const cur = bare(current)
  if (!cur) return null
  const was = bare(seen)
  if (!was) return cur
  return compareVersions(was, cur) === -1 ? cur : null
}

export interface WhatsNewPlan { from: string; entries: ReleaseEntry[] }

/**
 * On a load of `current`: announce only when a previous version was seen, it is OLDER, and the
 * range holds entries. No stored version (first install) announces nothing; a downgrade neither.
 */
export function planWhatsNew(o: { current: string; seen: string | null | undefined; table?: Record<string, ReleaseNotes> }): WhatsNewPlan | null {
  const seen = bare(o.seen)
  const current = bare(o.current)
  if (!seen || !current) return null
  if (compareVersions(seen, current) !== -1) return null
  const entries = releasesBetween(seen, current, o.table)
  return entries.length ? { from: seen, entries } : null
}
