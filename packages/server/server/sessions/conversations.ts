/**
 * conversations.ts — every conversation this machine knows about, running or not.
 *
 * The session manager alone can only see what it started. But a conversation you closed an hour ago
 * is exactly the thing you want back, and an assistant someone opened by hand is exactly the one
 * that gets lost — so the fleet screen has to be able to name both, and reopening either is the same
 * act: `<harness> --resume <id>` in the directory it belongs to.
 *
 * Read from the LOCAL consolidate store, cached, for the same reason `project-source.ts` is: the
 * control center must work with the server stopped.
 */

import type { HarnessId, SessionMeta } from '@agentistics/core'
import { resolveContextWindow, sessionCostUSD, sessionLabel } from '@agentistics/core'
import { loadConsolidated } from '../consolidate'
import { sessionAtCwd } from '../live-sessions'
import { SPAWN_SPECS } from './spawn-spec'

/** One conversation, as the fleet screen needs it. */
export interface Conversation {
  /** The id the STORE keys this conversation by. For every harness but gemini it is also what a resume takes. */
  sessionId: string
  /**
   * The id the harness CLI itself takes (`--resume`) and was handed at spawn (`--session-id`), when it
   * is not `sessionId` — gemini, whose store key is the synthetic `<project>/<file>`. Read through
   * `resumeIdOf` / `findConversation`, never compared by hand.
   */
  nativeId?: string
  harness: HarnessId
  cwd: string
  /** `sessionLabel()`: the user's own name, else the harness title, else the opening prompt. */
  title: string
  lastActivityMs: number
  /**
   * Epoch ms the conversation BEGAN.
   *
   * Distinct from `lastActivityMs`, which moves every turn: the first-sighting claim
   * (`task-attribution.ts`) is anchored on when a conversation started, relative to a spawn.
   * `0` when the session recorded no usable start time — which no claim can ever match, since it
   * must be strictly LATER than the spawn.
   */
  startedMs: number
  /**
   * Whether this harness can reopen a conversation by id AT ALL.
   *
   * False when the harness has no resume-by-id, or when THIS conversation has no id the CLI accepts
   * (a gemini chat whose header carries no `sessionId`). A row that cannot be resumed still LISTS — it is part of the history — it just offers no verb.
   */
  resumable: boolean
  /** The opening prompt, kept for search. Never rendered as a title — `sessionLabel` does that. */
  firstPrompt: string
  /** Total tokens, when the harness records them. Absent is NOT zero — see HARNESS_CAPABILITIES. */
  tokens?: number
  /** SS-05: the four counters one by one — a counter the harness did not record is ABSENT, not 0. */
  tokenParts?: TokenParts
  /** SS-05: how many turns the person took (`user_message_count`), when recorded. */
  turns?: number
  costUSD?: number
  /**
   * How full the context window was on the last turn, and out of how much — the gauge's two halves.
   *
   * `contextWindow` is resolved HERE rather than on the row, because it is the one place that holds
   * both the harness's own answer (codex writes `model_context_window` per session) and the model
   * id a table lookup needs. A row further downstream has neither. Both absent together: a
   * measurement with no window cannot be drawn, and a window with no measurement is not a reading.
   */
  contextTokens?: number
  contextWindow?: number
  /** Epoch ms of the person's last message (`user_message_timestamps`); absent when unknown. */
  lastUserMessageMs?: number
}

/** The four token counters of one conversation (SS-05). */
export interface TokenParts { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }

/** The id a RESUME must be given: the harness's own when the store key is not it. */
export function resumeIdOf(c: Pick<Conversation, 'sessionId' | 'nativeId'>): string {
  return c.nativeId ?? c.sessionId
}

/**
 * The conversation an id names, whichever of its two ids that is — the store key, or the harness's
 * own (`nativeId`). A row's recorded `conversationId` is the second for a gemini session agentop
 * assigned an id to at spawn, and the first for everything else; looking up by the key alone made
 * that row look like a conversation the store had never seen.
 */
export function findConversation<C extends Pick<Conversation, 'sessionId' | 'nativeId'>>(
  pool: readonly C[],
  id: string,
): C | undefined {
  return pool.find(c => c.sessionId === id) ?? pool.find(c => c.nativeId === id)
}

const CACHE_TTL_MS = 30_000
let cache: { at: number; list: Conversation[] } | null = null

/** Epoch ms of the last thing that happened in a conversation. */
function lastActivityOf(s: SessionMeta): number {
  for (const candidate of [s.end_time, s.user_message_timestamps?.at(-1), s.start_time]) {
    if (!candidate) continue
    const t = Date.parse(candidate)
    if (Number.isFinite(t)) return t
  }
  return 0
}

export function toConversation(s: SessionMeta): Conversation {
  const harness = (s.harness ?? 'claude') as HarnessId
  // The harness's OWN window outranks the table: it knows the deployment and any per-session cap,
  // which a model id cannot express. The table answers for everyone else, and answers `null` for a
  // model nobody has verified — which is what stops the gauge being drawn at all.
  const window = s.context_window ?? resolveContextWindow(s.model)?.tokens
  const total = (s.input_tokens ?? 0) + (s.output_tokens ?? 0)
    + (s.cache_read_input_tokens ?? 0) + (s.cache_creation_input_tokens ?? 0)
  // Per-model when the session spans several (an Antigravity parent with its subagent children
  // folded in carries a `model_usage` breakdown) — never one dominant model's rate applied to the
  // session's whole usage.
  const costUSD = total > 0 ? sessionCostUSD(s) : null
  return {
    sessionId: s.session_id,
    ...(s.native_session_id ? { nativeId: s.native_session_id } : {}),
    harness,
    startedMs: Date.parse(s.start_time) || 0,
    // Where the session IS: a worktree session records it as `current_cwd` while `project_path`
    // stays at the root, and reopening it should land where the work was happening.
    cwd: s.current_cwd || s.project_path || '',
    title: sessionLabel(s),
    lastActivityMs: lastActivityOf(s),
    resumable: SPAWN_SPECS[harness]?.resume !== undefined
      && (SPAWN_SPECS[harness]?.resumeIdOk?.(s.native_session_id ?? s.session_id) ?? true),
    firstPrompt: s.first_prompt ?? '',
    // Absent rather than zero when the harness records none: a confident 0 next to real numbers is
    // the same lie `HARNESS_CAPABILITIES` exists to prevent on the dashboard.
    ...(total > 0 ? { tokens: total } : {}),
    ...(total > 0 ? { tokenParts: {
      ...(s.input_tokens !== undefined ? { input: s.input_tokens } : {}),
      ...(s.output_tokens !== undefined ? { output: s.output_tokens } : {}),
      ...(s.cache_read_input_tokens !== undefined ? { cacheRead: s.cache_read_input_tokens } : {}),
      ...(s.cache_creation_input_tokens !== undefined ? { cacheWrite: s.cache_creation_input_tokens } : {}),
    } } : {}),
    ...(s.user_message_count ? { turns: s.user_message_count } : {}),
    // BOTH or NEITHER. Half a gauge is not a weaker gauge, it is an unreadable one: a measurement
    // with no window has no percentage, and a window with no measurement has no level.
    ...(s.context_tokens && window
      ? { contextTokens: s.context_tokens, contextWindow: window }
      : {}),
    // Through `sessionCostUSD`/`calcCost`, never an inline rate: CLAUDE.md makes that the single
    // source of truth, and a second arithmetic here would disagree with the dashboard the first
    // time a price changed.
    ...(costUSD !== null ? { costUSD } : {}),
    ...(() => {
      const t = Date.parse(s.user_message_timestamps?.at(-1) ?? '')
      return Number.isFinite(t) ? { lastUserMessageMs: t } : {}
    })(),
  }
}

/** Every conversation on this machine, newest first. Never throws — a store that cannot be read is
 *  a screen with no history, not a screen that fails to open. */
export async function loadConversations(): Promise<Conversation[]> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.list
  let list: Conversation[]
  try {
    list = [...(await loadConsolidated()).values()]
      .map(toConversation)
      .filter(c => c.sessionId && c.cwd)
      .sort((a, b) => b.lastActivityMs - a.lastActivityMs)
  } catch {
    list = []
  }
  cache = { at: now, list }
  return list
}

/** Drop the cache, so a session started seconds ago is findable without waiting out the TTL. */
export function forgetConversations(): void {
  cache = null
}

/**
 * The conversation an EXTERNAL process appears to be driving — PURE.
 *
 * A running assistant we did not start rarely names its conversation on the command line, so this
 * is an inference: the most recently active conversation of that harness in that directory. It is
 * offered rather than acted on, and the UI shows the conversation's own TITLE in the confirmation —
 * which is what lets the person, who knows what they were doing, judge whether it is the right one.
 * That is a better guarantee than any heuristic here could give.
 *
 * `namedId` short-circuits it: when the process DID state its conversation (an fd into the session
 * file, or `--resume <id>` in argv), that is proof and no inference happens.
 */
export function conversationForProcess(
  conversations: readonly Conversation[],
  proc: { harness: HarnessId; cwd: string; namedId?: string },
): Conversation | undefined {
  if (proc.namedId) {
    const exact = findConversation(conversations, proc.namedId)
    if (exact) return exact
    // The process named a conversation the store has never seen. Inferring a DIFFERENT one would be
    // worse than offering nothing: it would reopen something the user did not ask for.
    return undefined
  }
  return conversations.find(c =>
    c.harness === proc.harness
    && sessionAtCwd({ current_cwd: c.cwd, project_path: c.cwd }, proc.cwd))
}

/**
 * Does this conversation match what was typed? — PURE.
 *
 * Searches the NAME, the opening prompt, the directory and the harness. The opening prompt is in
 * there because it is what a person actually remembers about a conversation they closed ("the one
 * where I asked about the migration"), and it is the only conversation text available without
 * reading every transcript off disk — which the search field cannot afford to do per keystroke.
 */
export function conversationMatches(c: Conversation, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return c.title.toLowerCase().includes(q)
    || c.firstPrompt.toLowerCase().includes(q)
    || c.cwd.toLowerCase().includes(q)
    || c.harness.toLowerCase().includes(q)
}
