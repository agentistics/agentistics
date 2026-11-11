/**
 * tagMatch.ts — browser-side mirror of the tag source rule.
 *
 * MUST STAY IN SYNC WITH `packages/server/server/tags-resolve.ts` (`sessionMatchesTag`).
 * The web bundle may never import from `packages/server/*` (Vite would try to bundle Bun/Node
 * APIs), which is exactly why this tiny pure predicate is duplicated here instead of shared.
 * Any change to the server rule must be reflected here and in `tagMatch.test.ts`.
 *
 * A session belongs to a tag when it matches ANY of the tag's sources (OR union) AND falls inside
 * the tag's optional period:
 *   repo → git_remote, project → project_path, machine → memberId, team → any of
 *   teamIds/teamId, account → any machine that account owns.
 *
 * Caveat: `account` sources need an accountId → memberIds map, which the browser only has when
 * the caller supplies it. Without it an `account` source matches nothing client-side — the
 * authoritative numbers always come from the server's `/api/tags` aggregate.
 */
import type { SessionMeta } from '@agentistics/core'

export type TagSourceType = 'repo' | 'project' | 'machine' | 'harness' | 'model'

export interface TagSource {
  type: TagSourceType
  value: string
}

/** Optional period a tag is pinned to — inclusive `yyyy-MM-dd`, each side independent. */
export interface TagWindow {
  start?: string
  end?: string
}

/** Minimal shape of a tag needed to filter — matches what `GET /api/tags` returns. */
export interface TagDef {
  _id: string
  name: string
  color?: string
  sources: TagSource[]
  window?: TagWindow
}

/** True when the session matches ANY of the given sources. Mirrors the server rule. */
export function sessionMatchesTagSources(
  s: SessionMeta,
  sources: TagSource[],
): boolean {
  return sources.some(src => {
    switch (src.type) {
      case 'repo': return !!s.git_remote && s.git_remote === src.value
      case 'project': return s.project_path === src.value
      case 'machine': return !!s.memberId && s.memberId === src.value
      case 'harness': return (s.harness ?? 'claude') === src.value
      case 'model': return s.model === src.value
      default: return false
    }
  })
}

/**
 * Day a session is filed under — the leading 10 characters of the timestamp.
 *
 * MUST match `tagSessionDay` in tags-resolve.ts, which in turn matches tags-detail's daily series.
 * If this used the local clock and the server used the raw slice, a tag with a period would report
 * one total on its own card (server) and a different one through the tag FILTER (here) — the same
 * class of split-source disagreement the dashboard already paid for once.
 */
function sessionDay(s: SessionMeta): string | null {
  const raw = s.start_time
  if (!raw) return null
  const d = raw.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null
}

/** Is the session inside the tag's period? No window accepts everything. Mirrors the server. */
export function sessionInTagWindow(s: SessionMeta, window?: TagWindow): boolean {
  if (!window || (!window.start && !window.end)) return true
  const day = sessionDay(s)
  // Undated sessions belong to no period — admitting them would put them in every window.
  if (!day) return false
  if (window.start && day < window.start) return false
  if (window.end && day > window.end) return false
  return true
}

/**
 * Flatten the sources of the selected tags into one OR-union list.
 * Unknown ids (a tag the viewer can no longer see) contribute nothing.
 *
 * NOTE: flattening loses which tag each source came from, so it CANNOT express per-tag periods —
 * `makeTagFilter` evaluates tag by tag instead. This stays for callers that only need the union.
 */
export function selectedTagSources(selected: string[], tags: TagDef[]): TagSource[] {
  if (selected.length === 0 || tags.length === 0) return []
  const wanted = new Set(selected)
  const out: TagSource[] = []
  for (const t of tags) {
    if (!wanted.has(t._id)) continue
    for (const src of t.sources) out.push(src)
  }
  return out
}

/**
 * Predicate for the `tags` filter dimension: keep a session when it belongs to ANY selected tag —
 * that is, it matches one of that tag's sources AND falls inside that tag's own period.
 *
 * Evaluated per tag rather than over one flattened source list, because the period is per tag: a
 * flattened union would let a session from tag A's period be admitted by tag B's sources, which is
 * neither tag's answer. Returns `null` when the filter is inert (nothing selected, or no selected
 * tag resolves to a known definition with sources) so callers skip filtering entirely instead of
 * blanking the dashboard.
 */
export function makeTagFilter(
  selected: string[],
  tags: TagDef[],
): ((s: SessionMeta) => boolean) | null {
  if (selected.length === 0 || tags.length === 0) return null
  const wanted = new Set(selected)
  const active = tags.filter(t => wanted.has(t._id) && t.sources.length > 0)
  if (active.length === 0) return null
  return (s: SessionMeta) => active.some(t =>
    sessionMatchesTagSources(s, t.sources) && sessionInTagWindow(s, t.window))
}
