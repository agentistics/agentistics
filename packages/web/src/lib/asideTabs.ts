/**
 * asideTabs.ts — PURE. How the sessions aside splits the fleet into its three tabs.
 *
 * The owner chose "A + C + D" (2026-10-23, clickable prototype `lista-sessoes-redesign/interativo.html`):
 *
 * - **Ativas** is one card per LEADER with its team under it; a live session that names no live
 *   leader as its parent sits under "Sem líder". A PINNED session sorts to the top of its own list
 *   (leaders among leaders, members inside their team) — it is never drawn a second time anywhere.
 * - **Grupos** is the user's folders (drawn by the aside itself; nothing to decide here).
 * - **Encerradas** is what is not running: what FELL (the machine's own crash grouping, never
 *   re-derived here), what is SLEEPING (pinned or leader sessions that stopped — the ones somebody
 *   meant to come back to), what FINISHED TODAY, and the rest of the history behind "see all".
 *
 * Both the open aside and the 64px rail read this module, so the two can never disagree about which
 * session belongs to which team or which section.
 */

import type { SessionState } from '@agentistics/tui/control/session-fleet'

export type AsideTab = 'active' | 'groups' | 'ended'
export const ASIDE_TABS: readonly AsideTab[] = ['active', 'groups', 'ended']

export function isAsideTab(v: unknown): v is AsideTab {
  return typeof v === 'string' && (ASIDE_TABS as readonly string[]).includes(v)
}

/** The fields this module reads off a fleet row. */
export interface TeamRow {
  id: string
  conversationId?: string
  state: SessionState
  title: string
  parentSessionId?: string
  parentConversationId?: string
  startedAt?: number
  endedAt?: number
  lastUserMessageAt?: number
}

const LIVE: ReadonlySet<SessionState> = new Set<SessionState>(['working', 'waiting', 'waiting-approval', 'unknown'])

export function isLive(state: SessionState): boolean { return LIVE.has(state) }
export function isWaitingState(state: SessionState): boolean { return state === 'waiting' || state === 'waiting-approval' }

export interface Team<R> {
  /** The leader's identity key — what a fold is stored under, so it survives a reopen. */
  key: string
  leader: R
  members: R[]
}

/** Pinned first, otherwise the caller's order (already sorted by the person's chosen sort). */
function pinnedFirst<R>(rows: readonly R[], pinned: (r: R) => boolean): R[] {
  return [...rows.filter(pinned), ...rows.filter(r => !pinned(r))]
}

/** Does `row` name `leader` as its parent — by managed id or by the conversation id that survives a reopen. */
export function isChildOf(row: TeamRow, leader: TeamRow): boolean {
  if (row.id === leader.id) return false
  const hit = (v?: string) => v !== undefined && v !== '' && (v === leader.id || (!!leader.conversationId && v === leader.conversationId))
  return hit(row.parentConversationId) || hit(row.parentSessionId)
}

/**
 * The Ativas tab: one team per live leader, and the live sessions no live leader claims.
 *
 * `rows` must already be the LIVE rows the tab draws, in the person's chosen order. A leader started
 * by another leader is its own team (teams do not nest — a leader card inside a leader card is the
 * tree this design was chosen over); a member is any non-leader whose parent is that leader.
 */
export function buildTeams<R extends TeamRow>(rows: readonly R[], o: {
  isLeader: (r: R) => boolean
  pinned: (r: R) => boolean
  keyOf: (r: R) => string
}): { teams: Team<R>[]; loose: R[] } {
  const leaders = pinnedFirst(rows.filter(o.isLeader), o.pinned)
  const claimed = new Set<string>()
  const teams = leaders.map(leader => {
    const members = rows.filter(r => !o.isLeader(r) && !claimed.has(r.id) && isChildOf(r, leader))
    for (const m of members) claimed.add(m.id)
    return { key: o.keyOf(leader), leader, members: pinnedFirst(members, o.pinned) }
  })
  const loose = pinnedFirst(rows.filter(r => !o.isLeader(r) && !claimed.has(r.id)), o.pinned)
  return { teams, loose }
}

/** "3 na equipe · 1 esperando você" — the folded leader row's summary. */
export function teamSummary(members: readonly TeamRow[], pt: boolean): string {
  const n = members.length
  const w = members.filter(m => isWaitingState(m.state)).length
  const head = pt ? `${n} na equipe` : `${n} in the team`
  return w ? `${head} · ${pt ? `${w} esperando você` : `${w} waiting on you`}` : head
}

/**
 * The fold rule's second half: a folded team UNFOLDS on its own when one of its members STARTS
 * waiting on the person (a transition, never the level — a member that was already waiting when the
 * person folded the team does not undo their fold on the next poll).
 *
 * Returns the new folded list, or the same array when nothing changed (so a caller can skip a write).
 */
export function autoUnfold<R extends TeamRow>(
  folded: readonly string[],
  teams: readonly Team<R>[],
  wasWaiting: ReadonlySet<string>,
): readonly string[] {
  if (folded.length === 0) return folded
  const open = new Set<string>()
  for (const t of teams) {
    if (!folded.includes(t.key)) continue
    if (t.members.some(m => isWaitingState(m.state) && !wasWaiting.has(m.id))) open.add(t.key)
  }
  return open.size === 0 ? folded : folded.filter(k => !open.has(k))
}

/** The ids of every row waiting on a person right now — what `autoUnfold` compares against next poll. */
export function waitingIds(rows: readonly TeamRow[]): Set<string> {
  return new Set(rows.filter(r => isWaitingState(r.state)).map(r => r.id))
}

/** Same calendar day on the local clock — "finished TODAY" is the reader's today. */
function sameLocalDay(a: number, b: number): boolean {
  const x = new Date(a), y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

export interface EndedSections<R> {
  fell: R[]
  sleeping: R[]
  today: R[]
  /** Everything else that is not running — drawn only behind "see all finished". */
  older: R[]
}

/** Two unlinked ended rows with one title closer than this are one session's two registry rows. */
const TWIN_WINDOW_MS = 5 * 60_000

/**
 * One ended session is one row. A reopened-and-ended-again conversation leaves several ended rows
 * (a registry row per spawn, plus the store's `closed:` row): the same `conversationId` is the
 * harness's own proof they are one, so the newest-ended wins. A row with NO conversationId cannot
 * prove anything, so it is merged only with a same-title row that ended within `TWIN_WINDOW_MS` —
 * and only when one of the two is unlinked. Live rows are never touched.
 */
export function dedupeEnded<R extends TeamRow>(rows: readonly R[]): R[] {
  const end = (r: R) => r.endedAt ?? r.startedAt ?? -Infinity
  const ended = rows.filter(r => !isLive(r.state)).sort((a, b) => end(b) - end(a))
  const drop = new Set<R>()
  const kept: R[] = []
  for (const r of ended) {
    const twin = kept.find(k =>
      (r.conversationId && k.conversationId
        ? r.conversationId === k.conversationId
        : k.title === r.title && Math.abs(end(k) - end(r)) <= TWIN_WINDOW_MS))
    if (twin) drop.add(r)
    else kept.push(r)
  }
  return rows.filter(r => !drop.has(r))
}

/**
 * The Encerradas tab. Each row lands in exactly ONE section, in this precedence: fell (the machine
 * says so) → sleeping (ended and explicitly pinned) → finished today → older.
 * Rows that are live are ignored. Each section is newest-ended first.
 */
export function endedSections<R extends TeamRow>(rows: readonly R[], o: {
  fellIds: ReadonlySet<string>
  /** Whether this session is explicitly pinned; leader roles do not imply a pin. */
  keep: (r: R) => boolean
  now: number
}): EndedSections<R> {
  const out: EndedSections<R> = { fell: [], sleeping: [], today: [], older: [] }
  for (const r of dedupeEnded(rows)) {
    if (isLive(r.state)) continue
    if (o.fellIds.has(r.id)) out.fell.push(r)
    else if (o.keep(r)) out.sleeping.push(r)
    else if (r.endedAt !== undefined && sameLocalDay(r.endedAt, o.now)) out.today.push(r)
    else out.older.push(r)
  }
  const end = (r: R) => r.endedAt ?? r.startedAt ?? -Infinity
  for (const k of ['fell', 'sleeping', 'today', 'older'] as const) out[k].sort((a, b) => end(b) - end(a))
  return out
}

/** A span, short: "agora", "4 min", "2 h", "3 d". */
export function shortSpan(ms: number, pt: boolean): string {
  const min = Math.floor(Math.max(0, ms) / 60_000)
  if (min < 1) return pt ? 'agora' : 'now'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h} h`
  return `${Math.floor(h / 24)} d`
}

/**
 * The right-hand time of a LIVE row: how long since the person last wrote to it (that is what a
 * waiting session has been waiting on), or since it started when no message is known. Absent when
 * the row carries neither — never a confident "agora" invented for it.
 */
export function liveAge(row: TeamRow, now: number, pt: boolean): string | null {
  const at = row.lastUserMessageAt ?? row.startedAt
  return at === undefined ? null : shortSpan(now - at, pt)
}

/**
 * The right-hand time of an ENDED row: "14:30" when it ended today, "ontem" yesterday, otherwise a
 * span ("3 d"). Absent when nothing recorded the end.
 */
export function endedAge(row: TeamRow, now: number, pt: boolean): string | null {
  const at = row.endedAt
  if (at === undefined) return null
  if (sameLocalDay(at, now)) return new Date(at).toLocaleTimeString(pt ? 'pt-BR' : 'en-US', { hour: '2-digit', minute: '2-digit' })
  if (sameLocalDay(at, now - 86_400_000)) return pt ? 'ontem' : 'yesterday'
  return shortSpan(now - at, pt)
}

/** The time of a FALLEN row: how long ago it went down ("há 3 h") — the prototype's wording. */
export function fellAge(row: TeamRow, now: number, pt: boolean): string | null {
  if (row.endedAt === undefined) return null
  const span = shortSpan(now - row.endedAt, pt)
  return span === (pt ? 'agora' : 'now') ? span : pt ? `há ${span}` : `${span} ago`
}
