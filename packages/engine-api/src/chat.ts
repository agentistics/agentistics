/**
 * chat.ts — the chat channel (1.9): how an engine serves a conversation's turns, in-flight text and
 * state, for EVERY harness, through ONE harness-agnostic seam (ENGINE.MAP 09 §3–§4).
 *
 * Canonical events stay text-free (D5): nothing here is journaled. `HarnessChat` is a SECOND member
 * of an integration, beside `replay`/`live`, and like them it is a DECLARED absence when missing —
 * an integration says either "here is my chat" or, in one sentence, why it has none (`chatAbsent`).
 *
 * One cursor per source: `follow` reads only what a source has grown by since the last read, and an
 * engine shares that cursor between every subscriber of the same source. The text it produces lives
 * in memory for as long as somebody follows the source, never longer.
 *
 * A turn is `EngineChatTurn`, the structural mirror of `@agentistics/core`'s `ChatTurn` (this package
 * imports no platform package — `mirrors.ts`); `engine-api-mirrors.test.ts` keeps the two EQUAL.
 */
import type { HarnessId } from './mirrors'

/** Mirrors core's `ShellOutput` — must stay EQUAL. */
export interface EngineShellOutput {
  stdout: string
  stderr: string
  truncated?: boolean
}

/** Mirrors core's `ShellRun` — must stay EQUAL. */
export interface EngineShellRun {
  command: string
  summary: string
  running: boolean
  output?: EngineShellOutput
}

/**
 * Mirrors core's `ChatTurn` — must stay EQUAL (`engine-api-mirrors.test.ts`). The field meanings are
 * documented on the original (`packages/core/src/chatTurn.ts`), not restated here.
 */
export interface EngineChatTurn {
  at?: string
  role: 'user' | 'assistant'
  text: string
  composer?: boolean
  tools?: Array<{
    name: string
    canonical?: string
    failed?: boolean
    detail?: string
    writes?: string[]
    opaqueWrite?: boolean
    ref?: string
  }>
  thinking?: string
  pending?: boolean
  task?: { label: string; running: boolean; ended?: 'done' | 'stopped' | 'never-started' | 'session-ended' }
  system?: string
  systemRef?: string
  imagePaths?: string[]
  shell?: EngineShellRun
}

/** What the host knows about the conversation it wants followed. */
export interface ChatRef {
  /** The harness's own conversation id, known EXACTLY — never inferred (`harness-transcript.ts`). */
  conversationId: string
  /** The session's working directory. Some harnesses key their store on it. */
  cwd?: string
  /** Prompts this session was sent that may not be in the source yet — a fork's proof of ownership. */
  pending?: string[]
}

/** One resolved source of a conversation. Opaque to the host except for what it may show or log. */
export interface ChatSourceRef {
  harness: HarnessId
  conversationId: string
  /** Something a person can re-open: the transcript path, or the harness's own reference. */
  sourceRef: string
  /** The source this one continues (a `/login` or `/resume` fork), when it is a continuation. */
  continuesFrom?: string
}

/**
 * Who is waiting on a person, when the source itself says so (a permission request in the file, an
 * ACP `request_permission`, an app-server approval). Absent = the source says nobody is — or cannot
 * say, which the integration's `ChatDeclaration.attention` states once.
 */
export interface ChatAttention {
  /** What the source calls it: `permission`, `question`, … — never translated into a guess. */
  kind: string
  /** The one line the source shows the person, when it has one. */
  prompt?: string
  /** The options it offers, in its order, when it lists them. */
  options?: string[]
}

/**
 * What changed. A receiver keeps the last `max` turns it was asked for:
 *
 * - `window` — replace everything; `older` says the source has turns above the window.
 * - `grow`   — the LAST turn it holds changed in place (a tool call got its text, a task ended).
 * - `append` — these turns follow; then drop from the FRONT down to `max` (and `older` becomes true).
 *   A `grow` and an `append` emitted together apply in that order.
 * - `live`   — in-flight text of the turn being written, replaced (not appended) by each `live`; ended
 *   by the `grow`/`append` that lands the finished turn. Only from a source that streams.
 * - `state`  — whether the session is working, and whether it waits on a person.
 * - `fork`   — the conversation continues in another source; a `window` of that source follows.
 *
 * Named `HarnessChatDelta` because `@agentistics/core` already has a `ChatDelta` (the host's own
 * positional frame delta); the two meet in the host and must not be confused.
 */
export type HarnessChatDelta =
  | { kind: 'window'; turns: EngineChatTurn[]; older: boolean }
  | { kind: 'append'; turns: EngineChatTurn[] }
  | { kind: 'grow'; turn: EngineChatTurn }
  | { kind: 'live'; text: string; reasoning?: string }
  | { kind: 'state'; working: boolean; attention?: ChatAttention }
  | { kind: 'fork'; to: ChatSourceRef }

/** One capability of a chat channel: where it comes from, or the one sentence why there is none. */
export type ChatFeature = { from: string; absent?: undefined } | { from?: undefined; absent: string }

/**
 * What THIS harness's `follow` can say, declared once so the host never has to assume. Every member
 * is either a source (`from`, e.g. `transcript markers`) or a declared absence with its reason —
 * the same rule as `replayAbsent`, applied per capability.
 */
export interface ChatDeclaration {
  /** `state` deltas (working / idle). */
  state: ChatFeature
  /** `state.attention` (waiting on a person). */
  attention: ChatFeature
  /** `live` deltas (in-flight text). */
  live: ChatFeature
  /** `fork` deltas (the conversation continuing in another source). */
  fork: ChatFeature
  /**
   * 1.22 — `history` / `search` / `status` (the whole conversation, paged). Optional: a 1.21 engine does not
   * say, and then serves none. An engine built against 1.22 states it for every chat entry.
   */
  history?: ChatFeature
}

export interface HarnessChat {
  /** What `follow` emits beyond turns. */
  declares: ChatDeclaration
  /**
   * The conversation's source here, or `null` when there is none YET (a harness writes its file on
   * the first message) or the id cannot be trusted. Never throws.
   */
  resolve(ref: ChatRef): Promise<ChatSourceRef | null>
  /**
   * Follow a source: first a `window` of the last `max` turns (and a `state` when declared), then
   * deltas as it grows. Returns the unsubscribe. `on` is never called after it. Never throws: a source
   * that cannot be read yields an empty `window`, and one that vanishes stays silent.
   */
  follow(src: ChatSourceRef, max: number, on: (d: HarnessChatDelta) => void): () => void
  /** 1.22, optional — see `HarnessChatHistory`. Present together or not at all (`chatHasHistory`). */
  status?: HarnessChatHistory['status']
  history?: HarnessChatHistory['history']
  search?: HarnessChatHistory['search']
}

/** PURE. The features an integration declares as present, for a report a person reads. */
export function chatFeaturesOf(d: ChatDeclaration): Array<keyof ChatDeclaration> {
  return (['state', 'attention', 'live', 'fork'] as const).filter(k => d[k].from !== undefined)
}

/**
 * PURE. What a receiver holds after `deltas`, from `prev` — the one definition of the rules above, so
 * the host, a client and the engine's own tests apply them identically. `live`, `state` and `fork`
 * do not change the turns.
 */
export function applyHarnessChatDeltas(
  prev: { turns: readonly EngineChatTurn[]; older: boolean },
  deltas: readonly HarnessChatDelta[],
  max: number,
): { turns: EngineChatTurn[]; older: boolean } {
  let turns = [...prev.turns]
  let older = prev.older
  for (const d of deltas) {
    if (d.kind === 'window') { turns = [...d.turns]; older = d.older; continue }
    if (d.kind === 'grow') { if (turns.length > 0) turns[turns.length - 1] = d.turn; else turns.push(d.turn); continue }
    if (d.kind === 'append') {
      turns.push(...d.turns)
      if (turns.length > max) { turns = turns.slice(turns.length - max); older = true }
    }
  }
  return { turns, older }
}

// ── 1.22 — history, search and source status (V-CONTRATO) ───────────────────────────────────────────
//
// All OPTIONAL members of `HarnessChat`: `resolve` and `follow` above are unchanged. The engine-side note is
// `docs/superpowers/specs/2026-11-01-chat-history-contract.md` (engine repo); the rules a receiver relies on:
//  - turn indices count from the START of the conversation, so an append never shifts a page already served;
//  - a page belongs to a SNAPSHOT (the turn count when it was taken) and never holds a turn appended after it —
//    those arrive through `follow`, so paging while the source grows yields no duplicate;
//  - a rewrite (rewind, compaction, a replaced file) bumps `sourceEpoch`, and a cursor of another epoch is
//    refused `epoch-changed`: the receiver takes a new snapshot;
//  - `ready` with no turns is an EXISTING, empty conversation; `absent` is "no source", with the reason.

/** Default page size of `history`. */
export const CHAT_HISTORY_PAGE = 100
/** Hard cap of one `history` page: no receiver is ever sent the whole conversation at once. */
export const CHAT_HISTORY_MAX = 500
/** Default and hard cap of one `search` page's hits. */
export const CHAT_SEARCH_HITS = 20
export const CHAT_SEARCH_HITS_MAX = 100
/** Longest `snippet` a search hit carries. */
export const CHAT_SNIPPET_MAX = 160

/** Why a read failed. Closed: a new cause is a new minor, never a free string a host has to guess at. */
export type ChatReadErrorCode =
  /** The source exists but could not be read (permission, a busy database, a corrupt row). */
  | 'unreadable'
  /** The read did not finish in the time the engine allows it. */
  | 'timeout'
  /** The caller's `signal` aborted a `history` read (a cancelled SEARCH is not an error: `complete: false`). */
  | 'cancelled'
  /** The cursor or snapshot belongs to an older epoch of the source: take a new snapshot. */
  | 'epoch-changed'
  /** The cursor or snapshot does not parse, or `before` and `snapshot` are of different snapshots. */
  | 'bad-cursor'
  /** A search `query` with nothing to look for (empty once trimmed). */
  | 'bad-query'
  /** `accountRef` names nothing the host authorized (or the host offers no accounts). Never the default roots. */
  | 'unknown-account'
  /** The cursor was issued for another conversation or another account. */
  | 'foreign'

/**
 * The state of one conversation's source, discriminated — never inferred from an empty list.
 * `pending` is a source that does not exist YET (a harness writes its file on the first message); `absent` is
 * one that is not there and is not expected to appear; `error` is one that is there and failed.
 */
export type ChatSourceStatus =
  | { kind: 'ready' }
  | { kind: 'pending'; reason: string; retryAfterMs: number }
  | { kind: 'absent'; reason: string }
  | { kind: 'error'; code: ChatReadErrorCode; reason: string; retryable: boolean }

/** What a read answers when there is nothing to page: the status without `ready`. */
export type ChatUnavailable =
  | { status: 'pending'; reason: string; retryAfterMs: number }
  | { status: 'absent'; reason: string }
  | { status: 'error'; code: ChatReadErrorCode; reason: string; retryable: boolean }

/** A `ChatRef` plus WHOSE store to read. `accountRef` is opaque: only the host knows what it names. */
export interface ChatHistoryRef extends ChatRef {
  accountRef?: string
}

export interface ChatHistoryQuery {
  /** The cursor of the next older page (`ChatHistoryPage.before`). Absent: the newest page. */
  before?: string
  /** Turns wanted; clamped by `chatPageLimit` (default 100, at most 500). */
  limit?: number
  /** Page within this snapshot. Absent with no `before`: a NEW snapshot is taken. */
  snapshot?: string
  signal?: AbortSignal
}

export interface ChatHistoryPage {
  status: 'ready'
  /** Oldest first. Every turn is at index `[start, start + turns.length)` of the snapshot. */
  turns: EngineChatTurn[]
  /** Index of the first turn of this page, from the conversation's start. */
  start: number
  /** The cursor of the next older page; `null` = this page reaches the conversation's start. */
  before: string | null
  /** The snapshot this page belongs to — pass it back to stay in it. */
  snapshot: string
  /** Turns in the snapshot. */
  total: number
  sourceEpoch: string
}

export interface ChatSearchQuery {
  query: string
  /** Continue a search where its last page stopped (`ChatSearchPage.cursor`). */
  cursor?: string
  /** Hits wanted; default 20, at most 100. */
  limit?: number
  /** Search within this snapshot. Absent with no `cursor`: a new one is taken. */
  snapshot?: string
  signal?: AbortSignal
  /** How long the engine may scan before answering what it has, `complete: false`. */
  budgetMs?: number
}

export interface ChatSearchHit {
  /** The turn's index from the conversation's start. */
  index: number
  role: EngineChatTurn['role']
  at?: string
  /** At most `CHAT_SNIPPET_MAX` characters around the first match. */
  snippet: string
  /** `history({ before })` with this shows the page that ENDS at the hit. */
  before: string
}

export interface ChatSearchPage {
  status: 'ready'
  /** Newest first. */
  hits: ChatSearchHit[]
  /**
   * True only when the WHOLE snapshot was scanned down to its first turn. A receiver must never say "no
   * results" for a page that is not complete (`chatSearchVerdict`).
   */
  complete: boolean
  /** Why it stopped short, when it did. */
  stopped?: 'limit' | 'budget' | 'cancelled'
  /** Continue from here; `null` when `complete`. */
  cursor: string | null
  /** Turns scanned by this call. */
  scanned: number
  snapshot: string
  sourceEpoch: string
}

/**
 * 1.22 — the optional history members of `HarnessChat`. An integration that has them says so in
 * `declares.history` (`from`); one that has not says why (`absent`). Every member answers, never throws.
 */
export interface HarnessChatHistory {
  status(ref: ChatHistoryRef): Promise<ChatSourceStatus>
  history(ref: ChatHistoryRef, q?: ChatHistoryQuery): Promise<ChatHistoryPage | ChatUnavailable>
  search(ref: ChatHistoryRef, q: ChatSearchQuery): Promise<ChatSearchPage | ChatUnavailable>
}

/** PURE. A requested page size, clamped to `[1, CHAT_HISTORY_MAX]`; default `CHAT_HISTORY_PAGE`. */
export function chatPageLimit(limit?: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return CHAT_HISTORY_PAGE
  return Math.max(1, Math.min(CHAT_HISTORY_MAX, Math.floor(limit)))
}

/** PURE. A requested hit count, clamped to `[1, CHAT_SEARCH_HITS_MAX]`; default `CHAT_SEARCH_HITS`. */
export function chatSearchLimit(limit?: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return CHAT_SEARCH_HITS
  return Math.max(1, Math.min(CHAT_SEARCH_HITS_MAX, Math.floor(limit)))
}

/**
 * PURE. The one definition of what a receiver may SAY about a search page: `none` ("no results") only for a
 * complete scan with no hit; a scan that stopped short with nothing yet is `incomplete`, never `none`.
 */
export function chatSearchVerdict(r: ChatSearchPage | ChatUnavailable): 'hits' | 'none' | 'incomplete' | 'unavailable' {
  if (r.status !== 'ready') return 'unavailable'
  if (r.hits.length > 0) return 'hits'
  return r.complete ? 'none' : 'incomplete'
}

/** PURE. A source status from a read's answer — `ready` for any page, the rest as they are. */
export function chatStatusOf(r: ChatHistoryPage | ChatSearchPage | ChatUnavailable): ChatSourceStatus {
  switch (r.status) {
    case 'ready': return { kind: 'ready' }
    case 'pending': return { kind: 'pending', reason: r.reason, retryAfterMs: r.retryAfterMs }
    case 'absent': return { kind: 'absent', reason: r.reason }
    case 'error': return { kind: 'error', code: r.code, reason: r.reason, retryable: r.retryable }
  }
}

/** PURE. Whether a chat entry serves history (1.22): its three members are there. A declared absence is false. */
export function chatHasHistory(chat: HarnessChat): chat is HarnessChat & HarnessChatHistory {
  return typeof chat.status === 'function' && typeof chat.history === 'function' && typeof chat.search === 'function'
}
