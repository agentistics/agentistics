/**
 * tags-resolve.ts — PURE resolution of a tag's sources to the sessions they cover.
 *
 * A tag's sources are an OR union: a session belongs to the tag if it matches ANY source.
 * Resolution returns a SET of sessions, which is what makes the aggregate dedupe-correct —
 * a session matching two sources is present once, never summed twice.
 *
 * No I/O — unit-tested with plain objects.
 */
import type { SessionMeta } from '@agentistics/core'
import { canonicalProjectPath } from '@agentistics/core'

export const TAG_SOURCE_TYPES = ['repo', 'project', 'machine', 'harness', 'model'] as const
export type TagSourceType = typeof TAG_SOURCE_TYPES[number]

export interface TagSource {
  type: TagSourceType
  /** repo → normalized git remote; project → project path; machine → memberId;
   *  harness → HarnessId ('claude'|'codex'|...); model → the bare model id as stored on the
   *  session. */
  value: string
}

/**
 * An optional period the tag is pinned to — `yyyy-MM-dd`, both ends INCLUSIVE, each side
 * independently optional (`start` alone = "from then on", `end` alone = "up to then").
 *
 * This is what turns a tag from "these sources" into "these sources, during that experiment":
 * "I ran harness X through the API on this project from the 4th to the 18th — how much did that
 * cost?". Without it the same question needs the global date filter, which is transient and is not
 * carried by the tag, so the number changes the moment someone else opens the page.
 */
export interface TagWindow {
  start?: string
  end?: string
}

/**
 * Day a session is filed under.
 *
 * Deliberately the SAME rule as `dayOf` in tags-detail.ts (the leading 10 characters of the
 * timestamp), because the window is read against that module's daily series and activity window.
 * A local-clock day would be more correct in isolation and WRONG here: at UTC-3 a session started
 * at 23:00 would fall inside the window while being plotted on the next day's bar of the tag's own
 * chart. The two rules must be one rule; when tags-detail changes, this changes with it.
 */
export function tagSessionDay(s: SessionMeta): string | null {
  const raw = s.start_time
  if (!raw) return null
  const d = raw.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null
}

/** Is a session inside the tag's period? No window (or neither end set) accepts everything. */
export function sessionInWindow(s: SessionMeta, window?: TagWindow): boolean {
  if (!window || (!window.start && !window.end)) return true
  const day = tagSessionDay(s)
  // A session with no usable date cannot be shown to belong to the period. Admitting it would put
  // undated rows in EVERY window, which is the one outcome a frozen cost must not have.
  if (!day) return false
  if (window.start && day < window.start) return false
  if (window.end && day > window.end) return false
  return true
}

/** Does a session match one source? The building block for both the union and the filters. */
function matchesSource(s: SessionMeta, src: TagSource): boolean {
  switch (src.type) {
    case 'repo': return !!s.git_remote && s.git_remote === src.value
    // Compared canonically so a worktree counts as the project it belongs to, and so a tag written
    // against a worktree path still resolves after the picker stopped offering them.
    case 'project': return canonicalProjectPath(s.project_path) === canonicalProjectPath(src.value)
    case 'machine': return !!s.memberId && s.memberId === src.value
    // Session ATTRIBUTES, not identity.
    case 'harness': return (s.harness ?? 'claude') === src.value
    case 'model': return s.model === src.value
    default: return false
  }
}

/**
 * Filters narrow the union without widening it: grouped by type, OR within a type and AND across
 * types. "repo X, restricted to accounts {A,B} and projects {C,D}" is the union of X intersected
 * with (A or B) and with (C or D) — which is what "only these people, only in these folders" means.
 *
 * Grouping by type is what makes that read naturally. Flat AND over every filter would be
 * unsatisfiable the moment two values of the same type are listed, since one session cannot sit in
 * two projects at once. A type nobody filtered on places no constraint at all.
 */
export function sessionPassesFilters(s: SessionMeta, filters: TagSource[]): boolean {
  if (filters.length === 0) return true
  const byType = new Map<TagSourceType, TagSource[]>()
  for (const f of filters) {
    const list = byType.get(f.type)
    if (list) list.push(f)
    else byType.set(f.type, [f])
  }
  for (const group of byType.values()) {
    if (!group.some(f => matchesSource(s, f))) return false
  }
  return true
}

/**
 * The full rule, in one place so no caller can apply half of it: (ANY source) AND (all filter
 * groups) AND (inside the period). The window is an AND on top of the union for the same reason
 * the filters are — it narrows, never widens, so it can never turn a tag into a way of reaching
 * something its sources did not already cover.
 */
export function sessionMatchesTag(
  s: SessionMeta,
  sources: TagSource[],
  filters: TagSource[] = [],
  window?: TagWindow,
): boolean {
  return sources.some(src => matchesSource(s, src))
    && sessionPassesFilters(s, filters)
    && sessionInWindow(s, window)
}

export function resolveTagSessions(
  sessions: SessionMeta[],
  sources: TagSource[],
  filters: TagSource[] = [],
  window?: TagWindow,
): SessionMeta[] {
  if (sources.length === 0) return []
  return sessions.filter(s => sessionMatchesTag(s, sources, filters, window))
}
