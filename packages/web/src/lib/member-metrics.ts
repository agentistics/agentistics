// packages/web/src/lib/member-metrics.ts
//
// B7 — per-member / per-machine metrics (browser copy).
//
// MIRROR of `packages/server/server/member-metrics.ts`, which is the canonical copy and carries
// the unit tests (`member-metrics.test.ts`). The web bundle must never import from
// `packages/server/*` (Vite would try to bundle Bun/Node APIs), and the shape is too
// dashboard-specific to belong in `@agentistics/core`, so the pure logic is duplicated here.
// Any change to the aggregation must be applied to BOTH files.
//
// PURE aggregation over `SessionMeta[]`: no Mongo, no auth, no filesystem. The caller decides
// which sessions are visible — the page feeds it `/api/data`, which the central already scopes
// per signed-in principal.

import { calcCost, sessionCostUSD as sessionCostByModel, type SurfaceHarnessId, type SessionMeta, type StatsCache } from '@agentistics/core'
import { format, parseISO } from 'date-fns'

/** How rows are grouped: one row per person (`user`) or one row per machine (`memberId`). */
export type MemberGroupBy = 'user' | 'machine'

/** Bucket key used when a session carries neither a `user` nor a `memberId` (solo / local data). */
export const LOCAL_KEY = '__local__'

export interface TopEntry<K extends string = string> {
  key: K
  sessions: number
}

/** The busiest "project" of a member — a git repo or a plain folder, whichever has more sessions.
 *  `kind` tells the UI which label to render (repo short name vs. folder path). */
export interface TopProject extends TopEntry {
  kind: 'repo' | 'folder'
}

/** One machine's slice of a member row. `key` is the `memberId` (the machine's stable id). */
export interface MachineUsage {
  key: string
  sessions: number
  costUSD: number
  totalTokens: number
}

export interface MemberMetrics {
  /** Stable row identity: the `memberId` (machine grouping) or the `user` (user grouping). */
  key: string
  /** Display name of the owning user. Empty when the sessions carry no user (solo machine). */
  user: string
  /** The machine identity when the row maps to exactly one machine, else null. */
  memberId: string | null
  /** Distinct machines contributing to this row (always 1 when grouping by machine). */
  machineCount: number
  /** Per-machine breakdown of this row, ranked by cost desc (the page's primary metric), then
   *  sessions desc, then key asc. One entry when grouping by machine; the member's whole fleet
   *  when grouping by user — which is the only place the reader can see WHERE the work happened.
   *  Sums the same visible sessions as every other field on the row, so the parts always add up
   *  to the whole; it is NOT the deep statsCache history. */
  machines: MachineUsage[]
  /** True when this row's headline totals were replaced by the statsCache history rather than
   *  summed from the visible sessions. The per-machine `machines` breakdown is ALWAYS the visible
   *  sessions, so when this is set the parts legitimately add up to less than the whole and the UI
   *  must say so — silently showing chips that do not close is how a reader stops trusting both. */
  totalsFromCache?: boolean
  sessions: number
  costUSD: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** input + output + cache read + cache write. */
  totalTokens: number
  /** ISO timestamp of the earliest session start, or null when no session had a usable date. */
  firstActivity: string | null
  /** ISO timestamp of the latest session end (falling back to its start). */
  lastActivity: string | null
  /** All harnesses seen, ordered by session count desc then id asc. */
  harnesses: SurfaceHarnessId[]
  topProject: TopProject | null
  topModel: TopEntry | null
  topHarness: TopEntry<SurfaceHarnessId> | null
}

/** Cost of a single session. Always via `calcCost` — never an inline pricing formula.
 *  Sessions with no `model` fall through to `getModelPrice`'s default blend. */
export function sessionCostUSD(s: SessionMeta): number {
  // Per-model when the session spans several models (an Antigravity parent with its subagent
  // children folded in carries a `model_usage` breakdown); single-model otherwise.
  const byModel = sessionCostByModel(s)
  if (byModel !== null) return byModel
  return calcCost(
    {
      inputTokens: s.input_tokens ?? 0,
      outputTokens: s.output_tokens ?? 0,
      cacheReadInputTokens: s.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: s.cache_creation_input_tokens ?? 0,
      webSearchRequests: 0,
      costUSD: 0,
    },
    '',
  )
}

function bump(m: Map<string, number>, key: string): void {
  m.set(key, (m.get(key) ?? 0) + 1)
}

/** Highest count wins; ties break on the ascending key so the result never depends on Map order. */
function topOf(m: Map<string, number>): TopEntry | null {
  let best: TopEntry | null = null
  for (const [key, sessions] of m) {
    if (!best || sessions > best.sessions || (sessions === best.sessions && key < best.key)) {
      best = { key, sessions }
    }
  }
  return best
}

/** Millisecond value of an ISO-ish timestamp, or null when unparseable. */
function ms(value: string | undefined): number | null {
  if (!value) return null
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : null
}

interface Acc {
  key: string
  users: Map<string, number>
  /** memberId → that machine's slice of this row. Also the machine count (its size). */
  memberIds: Map<string, { sessions: number; costUSD: number; totalTokens: number }>
  sessions: number
  costUSD: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  firstAt: number | null
  firstIso: string | null
  lastAt: number | null
  lastIso: string | null
  repos: Map<string, number>
  folders: Map<string, number>
  models: Map<string, number>
  harnesses: Map<string, number>
}

/**
 * Aggregate sessions into one row per member (`groupBy: 'user'`) or per machine
 * (`groupBy: 'machine'`, the default).
 *
 * Rows are sorted by session count desc, then cost desc, then key asc — fully deterministic.
 */
export function aggregateMemberMetrics(
  sessions: SessionMeta[],
  groupBy: MemberGroupBy = 'machine',
): MemberMetrics[] {
  const acc = new Map<string, Acc>()

  for (const s of sessions) {
    const user = (s.user ?? '').trim()
    const memberId = (s.memberId ?? '').trim()
    const key = groupBy === 'machine'
      ? (memberId || user || LOCAL_KEY)
      : (user || LOCAL_KEY)

    let a = acc.get(key)
    if (!a) {
      a = {
        key,
        users: new Map(),
        memberIds: new Map(),
        sessions: 0,
        costUSD: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        firstAt: null,
        firstIso: null,
        lastAt: null,
        lastIso: null,
        repos: new Map(),
        folders: new Map(),
        models: new Map(),
        harnesses: new Map(),
      }
      acc.set(key, a)
    }

    const cost = sessionCostUSD(s)
    a.sessions++
    a.costUSD += cost
    a.inputTokens += s.input_tokens ?? 0
    a.outputTokens += s.output_tokens ?? 0
    a.cacheReadTokens += s.cache_read_input_tokens ?? 0
    a.cacheWriteTokens += s.cache_creation_input_tokens ?? 0

    if (user) bump(a.users, user)
    if (memberId) {
      // The machine's slice is accumulated from the SAME session totals used above, so the
      // per-machine numbers always sum back to the row's own numbers.
      const slice = a.memberIds.get(memberId)
        ?? { sessions: 0, costUSD: 0, totalTokens: 0 }
      slice.sessions++
      slice.costUSD += cost
      slice.totalTokens += (s.input_tokens ?? 0) + (s.output_tokens ?? 0)
        + (s.cache_read_input_tokens ?? 0) + (s.cache_creation_input_tokens ?? 0)
      a.memberIds.set(memberId, slice)
    }

    const startAt = ms(s.start_time)
    if (startAt !== null && (a.firstAt === null || startAt < a.firstAt)) {
      a.firstAt = startAt
      a.firstIso = s.start_time
    }
    const endIso = s.end_time || s.start_time
    const endAt = ms(endIso)
    if (endAt !== null && (a.lastAt === null || endAt > a.lastAt)) {
      a.lastAt = endAt
      a.lastIso = endIso
    }

    const remote = (s.git_remote ?? '').trim()
    if (remote) bump(a.repos, remote)
    const folder = (s.project_path ?? '').trim()
    if (folder) bump(a.folders, folder)

    const model = (s.model ?? '').trim()
    if (model) bump(a.models, model)
    const harness = (s.harness ?? '').trim()
    if (harness) bump(a.harnesses, harness)
  }

  const rows: MemberMetrics[] = []
  for (const a of acc.values()) {
    const topRepo = topOf(a.repos)
    const topFolder = topOf(a.folders)
    // "Whichever is higher" (ROADMAP B7). On an exact tie the repo wins: it is the stable
    // cross-machine identity, while a folder path is local to one checkout.
    let topProject: TopProject | null = null
    if (topRepo && (!topFolder || topRepo.sessions >= topFolder.sessions)) {
      topProject = { kind: 'repo', key: topRepo.key, sessions: topRepo.sessions }
    } else if (topFolder) {
      topProject = { kind: 'folder', key: topFolder.key, sessions: topFolder.sessions }
    }

    const topHarness = topOf(a.harnesses)
    const harnessList = [...a.harnesses.entries()]
      .sort((x, y) => (y[1] - x[1]) || x[0].localeCompare(y[0]))
      .map(([id]) => id as SurfaceHarnessId)

    const topUser = topOf(a.users)
    rows.push({
      key: a.key,
      user: topUser?.key ?? '',
      memberId: a.memberIds.size === 1 ? [...a.memberIds.keys()][0]! : null,
      machineCount: a.memberIds.size,
      machines: [...a.memberIds.entries()]
        .map(([key, v]) => ({ key, sessions: v.sessions, costUSD: v.costUSD, totalTokens: v.totalTokens }))
        .sort((x, y) => (y.costUSD - x.costUSD) || (y.sessions - x.sessions) || x.key.localeCompare(y.key)),
      sessions: a.sessions,
      costUSD: a.costUSD,
      inputTokens: a.inputTokens,
      outputTokens: a.outputTokens,
      cacheReadTokens: a.cacheReadTokens,
      cacheWriteTokens: a.cacheWriteTokens,
      totalTokens: a.inputTokens + a.outputTokens + a.cacheReadTokens + a.cacheWriteTokens,
      firstActivity: a.firstIso,
      lastActivity: a.lastIso,
      harnesses: harnessList,
      topProject,
      topModel: topOf(a.models),
      topHarness: topHarness ? { key: topHarness.key as SurfaceHarnessId, sessions: topHarness.sessions } : null,
    })
  }

  rows.sort((a, b) => (b.sessions - a.sessions) || (b.costUSD - a.costUSD) || a.key.localeCompare(b.key))
  return rows
}

/**
 * Replace the session-summed totals with the member's / machine's authoritative statsCache.
 *
 * The session documents are only what has not been pruned — Claude Code deletes transcripts past
 * `cleanupPeriodDays`, while `stats-cache.json` is the running aggregate it never prunes. Measured
 * on live central data, one person's two machines held $17,981.82 across 783 sessions of history
 * against $11,163.39 across the 255 session documents that survived: this page reported 62% of the
 * money and 33% of the sessions, and disagreed with the dashboard for the same person.
 *
 * `caches` is keyed to match `row.key` — `userStatsCaches` for `groupBy: 'user'`,
 * `machineStatsCaches` for `'machine'`. Pass `undefined` when a filter the caches cannot represent
 * is active (project / repo / tag / model / date / harness): they are all-time Claude-only totals,
 * so under such a filter the per-session sum is the only source that can answer at all.
 *
 * Mirrors `useDerivedStats` so the pages agree: a non-Claude session adds its full cost, tokens and
 * count (statsCache is Claude-only, so that spend is in NO cache), while a Claude session on a day
 * the cache has not computed yet adds only its COUNT — its money is already inside `modelUsage`.
 * A row with no cache is returned untouched; its sessions are all the history there is.
 *
 * Only the totals are overlaid. `topProject` / `topModel` / `topHarness` and the activity window
 * stay session-derived — the cache has no such breakdown, so those keep describing the surviving
 * sessions rather than the whole history.
 */
export function withStatsCacheTotals(
  rows: MemberMetrics[],
  sessions: SessionMeta[],
  groupBy: MemberGroupBy,
  caches: Record<string, StatsCache> | undefined,
): MemberMetrics[] {
  if (!caches) return rows

  const cachedDays = new Map<string, Set<string>>()
  for (const [key, c] of Object.entries(caches)) {
    cachedDays.set(key, new Set((c.dailyActivity ?? []).map(d => d.date)))
  }

  interface Extra {
    cost: number; input: number; output: number; cacheRead: number; cacheWrite: number
    nonClaudeSessions: number; gapSessions: number
  }
  const extra = new Map<string, Extra>()
  for (const s of sessions) {
    const user = (s.user ?? '').trim()
    const memberId = (s.memberId ?? '').trim()
    const key = groupBy === 'machine' ? (memberId || user || LOCAL_KEY) : (user || LOCAL_KEY)
    if (!caches[key]) continue
    let e = extra.get(key)
    if (!e) {
      e = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, nonClaudeSessions: 0, gapSessions: 0 }
      extra.set(key, e)
    }
    if ((s.harness ?? 'claude') !== 'claude') {
      e.cost += sessionCostUSD(s)
      e.input += s.input_tokens ?? 0
      e.output += s.output_tokens ?? 0
      e.cacheRead += s.cache_read_input_tokens ?? 0
      e.cacheWrite += s.cache_creation_input_tokens ?? 0
      e.nonClaudeSessions += 1
    } else if (s.start_time && !cachedDays.get(key)!.has(format(parseISO(s.start_time), 'yyyy-MM-dd'))) {
      e.gapSessions += 1
    }
  }

  return rows.map(row => {
    const c = caches[row.key]
    if (!c) return row
    const e = extra.get(row.key)
    let cost = 0, input = 0, output = 0, cacheRead = 0, cacheWrite = 0
    for (const [model, u] of Object.entries(c.modelUsage ?? {})) {
      cost += calcCost(u, model)
      input += u.inputTokens ?? 0
      output += u.outputTokens ?? 0
      cacheRead += u.cacheReadInputTokens ?? 0
      cacheWrite += u.cacheCreationInputTokens ?? 0
    }
    const cacheSessions = (c.dailyActivity ?? []).reduce((n, d) => n + (d.sessionCount ?? 0), 0)
    cost += e?.cost ?? 0
    input += e?.input ?? 0
    output += e?.output ?? 0
    cacheRead += e?.cacheRead ?? 0
    cacheWrite += e?.cacheWrite ?? 0
    return {
      ...row,
      sessions: cacheSessions + (e?.gapSessions ?? 0) + (e?.nonClaudeSessions ?? 0),
      costUSD: cost,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      totalTokens: input + output + cacheRead + cacheWrite,
      // Flags that the headline no longer equals the sum of `machines` (which stays session-based),
      // so the card can disclose it instead of showing parts that quietly fail to close.
      totalsFromCache: true,
    }
  }).sort((a, b) => (b.sessions - a.sessions) || (b.costUSD - a.costUSD) || a.key.localeCompare(b.key))
}

/**
 * Narrows a cache map to the SAME presence scope the header total is built from
 * (`resolvePresenceScope` in `hooks/useData.ts`), before it reaches `withStatsCacheTotals`.
 *
 * Without this, a machine/member excluded from the header's total by the central's
 * "online only" default kept its own row substituted from its FULL, all-time cache — a huge,
 * unscoped number sitting beside a small "total" with nothing on screen explaining either one.
 * `withStatsCacheTotals` already leaves a row alone when its key is absent from `caches`, so
 * dropping the excluded keys here is enough: that row falls back to its session-based total,
 * which — since `presenceAllowedUsers` is resolved at the PERSON level, exactly like the
 * session-list filter upstream — is only ever non-zero when the owner is actually in scope.
 *
 * `allowedUsers: null` means "no scoping" (no presence data, or an explicit filter already
 * narrowed the session list some other way) and is a no-op.
 */
export function presenceFilterCaches(
  caches: Record<string, StatsCache> | undefined,
  groupBy: MemberGroupBy,
  allowedUsers: Set<string> | null,
  machineOwners: Record<string, { user: string; teamIds: string[] }> | undefined,
): Record<string, StatsCache> | undefined {
  if (!caches || !allowedUsers) return caches
  const out: Record<string, StatsCache> = {}
  for (const [key, cache] of Object.entries(caches)) {
    const owner = groupBy === 'machine' ? (machineOwners?.[key]?.user ?? '') : key
    if (allowedUsers.has(owner)) out[key] = cache
  }
  return out
}
