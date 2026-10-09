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
    detail?: string
    writes?: string[]
    opaqueWrite?: boolean
    ref?: string
  }>
  thinking?: string
  pending?: boolean
  task?: { label: string; running: boolean }
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
