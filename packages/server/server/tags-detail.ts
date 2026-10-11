/**
 * tags-detail.ts — PURE deep aggregation for a tag's detail page.
 *
 * `tags-aggregate.ts` answers "what are this tag's headline numbers". This module answers
 * "what is inside it": distributions (projects / models / harnesses / repositories / members),
 * a daily series, and the activity window.
 *
 * Rule 2 still holds — everything here is a COUNT or a SUM. No session ids, no prompts, no
 * timestamps of individual sessions. A caller may render these numbers without ever gaining
 * access to the rows behind them.
 *
 * No Mongo, no auth, no I/O.
 */
import { calcCost, sessionCostUSD, sessionTokenTotal, type SessionMeta } from '@agentistics/core'

export interface TagBucket {
  key: string
  sessions: number
  costUSD: number
  tokens: number
}

export interface TagDayPoint {
  date: string
  sessions: number
  costUSD: number
  tokens: number
}

export interface TagDetailStats {
  projects: TagBucket[]
  models: TagBucket[]
  harnesses: TagBucket[]
  repos: TagBucket[]
  /** Contributing machines, keyed by the session's memberId (token hash). Display names are
   *  resolved by the caller, which knows the machine registry. */
  members: TagBucket[]
  /** Contributing PEOPLE, keyed by the session's `user`. A person may drive several machines, so
   *  this is not the same ranking as `members` — it answers "who worked on this", not "from where". */
  users: TagBucket[]
  daily: TagDayPoint[]
  /** How many distinct people and machines contributed. Plain counts, so unlike the bucket KEYS
   *  they need no redaction — and they must be computed BEFORE redaction, otherwise collapsing
   *  several unseeable machines into one "other" bucket would undercount them. */
  distinctMembers: number
  distinctMachines: number
  firstSessionDate: string | null
  lastSessionDate: string | null
  /** Sessions carrying no model id — they still count in totals but cannot be attributed. */
  sessionsWithoutModel: number
}

function sessionCost(s: SessionMeta): number {
  // Per-model when the session spans several models; otherwise its single `model`.
  const byModel = sessionCostUSD(s)
  if (byModel !== null) return byModel
  return calcCost({
    inputTokens: s.input_tokens ?? 0,
    outputTokens: s.output_tokens ?? 0,
    cacheReadInputTokens: s.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: s.cache_creation_input_tokens ?? 0,
    webSearchRequests: 0,
    costUSD: 0,
  }, '')
}

/** Every billed counter — the buckets this feeds are labelled "tokens" on the tag detail page. */
function tokensOf(s: SessionMeta): number | undefined { return sessionTokenTotal(s) }

/** Accumulate one session into a keyed bucket map. Empty keys are skipped by the caller. */
function bump(map: Map<string, TagBucket>, key: string, s: SessionMeta): void {
  if (s.tokens_unavailable) return
  let b = map.get(key)
  if (!b) { b = { key, sessions: 0, costUSD: 0, tokens: 0 }; map.set(key, b) }
  b.sessions += 1
  b.costUSD += sessionCost(s)
  const tokens = tokensOf(s)
  if (tokens !== undefined) b.tokens += tokens
}

/** Highest cost first, then most sessions — the order a reader scans for "where did it go". */
function ranked(map: Map<string, TagBucket>): TagBucket[] {
  return [...map.values()].sort((a, b) => b.costUSD - a.costUSD || b.sessions - a.sessions)
}

/** Day key from an ISO timestamp, without pulling in a date library. */
function dayOf(iso: string): string | null {
  const d = iso.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null
}

export function aggregateTagDetail(sessions: SessionMeta[]): TagDetailStats {
  const projects = new Map<string, TagBucket>()
  const models = new Map<string, TagBucket>()
  const harnesses = new Map<string, TagBucket>()
  const repos = new Map<string, TagBucket>()
  const members = new Map<string, TagBucket>()
  const users = new Map<string, TagBucket>()
  const days = new Map<string, TagDayPoint>()
  const distinctUsers = new Set<string>()
  let sessionsWithoutModel = 0
  let first: string | null = null
  let last: string | null = null

  for (const s of sessions) {
    if (s.project_path) bump(projects, s.project_path, s)
    if (s.model) bump(models, s.model, s); else sessionsWithoutModel += 1
    if (s.harness) bump(harnesses, s.harness, s)
    if (s.git_remote) bump(repos, s.git_remote, s)
    if (s.memberId) bump(members, s.memberId, s)
    if (s.user) { distinctUsers.add(s.user); bump(users, s.user, s) }

    const day = s.start_time ? dayOf(s.start_time) : null
    if (day) {
      let p = days.get(day)
      if (!p) { p = { date: day, sessions: 0, costUSD: 0, tokens: 0 }; days.set(day, p) }
      p.sessions += 1
      if (!s.tokens_unavailable) {
        p.costUSD += sessionCost(s)
        const tokens = tokensOf(s)
        if (tokens !== undefined) p.tokens += tokens
      }
      if (!first || day < first) first = day
      if (!last || day > last) last = day
    }
  }

  return {
    projects: ranked(projects),
    models: ranked(models),
    harnesses: ranked(harnesses),
    repos: ranked(repos),
    members: ranked(members),
    users: ranked(users),
    daily: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    distinctMembers: distinctUsers.size,
    distinctMachines: members.size,
    firstSessionDate: first,
    lastSessionDate: last,
    sessionsWithoutModel,
  }
}
