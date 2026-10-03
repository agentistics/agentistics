/**
 * event-types.ts — the whole contract of the event channel, in one place.
 *
 * ## What an event is, and what it is deliberately not
 *
 * A `SessionEvent` records that a session CHANGED STATE. It carries facts: when, which session,
 * which task, from what to what, and — when there is one — the last few lines that were on its
 * screen. It carries **no instruction, no suggestion and no request**.
 *
 * That is a hard boundary, not a style preference. This channel exists so a Claude session
 * orchestrating other assistants knows what is happening without a person relaying it. The distance
 * between "knows what is happening" and "acts on someone's behalf" is one field: an event with an
 * `action`, a `suggest` or a `respondWith` would make the channel the thing that crosses it. So
 * there is no such field, `events-frontier.test.ts` asserts there is none, and the ONE state that
 * would most tempt one — `waiting-approval` — is reported as a fact and nothing more. Nothing in
 * this channel may approve anything for anyone.
 *
 * ## Two sources that are not equivalent
 *
 * `poll` is agentop's own five-second monitor. It reads the SCREEN, so it works for all six
 * harnesses, and it infers — it is the FLOOR, and the floor has to hold for codex, kimi and gemini
 * which have no hook to offer.
 *
 * `hook` is a Claude Code `Stop` hook. It fires when a Claude session finishes answering: exact, no
 * polling, no inference — and Claude only.
 *
 * Both report the same end of turn, so `event-dedupe.ts` decides which one the reader sees.
 */

import type { HarnessId } from '@agentistics/core'
import type { SessionActivity } from '../sessions/types'

/** The line format's version. Bumped when the SHAPE changes in a way a reader must notice. */
export const EVENT_VERSION = 1

/**
 * What kind of transition this is.
 *
 * A superset of `SessionActivity` rather than the same type: `exited` as an activity means "the
 * hosted command is no longer running", which is also what a session finishing normally looks like,
 * and `turn-end` is a thing only the hook can see (Claude stopped answering while the session lives
 * on). Keeping them distinct is what lets a subscriber ask for one without the other.
 */
export type EventKind =
  | 'working'
  | 'waiting'
  | 'waiting-approval'
  | 'exited'
  | 'turn-end'

export const EVENT_KINDS: readonly EventKind[] = [
  'working', 'waiting', 'waiting-approval', 'exited', 'turn-end',
]

/** The states a subscriber is offered by default: the ones that mean "something needs you". */
export const DEFAULT_EVENT_KINDS: readonly EventKind[] = ['waiting', 'waiting-approval', 'exited']

/**
 * `native` (H17): a native Agentistics session said so ITSELF — the runtime asked the person
 * (`policy.requested` → `waiting-approval`), finished a run (`waiting`) or started one (`working`).
 * Exact like the hook, inferred from nothing, and the only source a native session has (it has no
 * screen for the poll to read).
 */
export type EventSource = 'poll' | 'hook' | 'native'

export interface SessionEvent {
  /** The line format this was written at. A reader tolerating an older one reads this first. */
  v: number
  /** Monotonic within one inbox file, restarting at 1 after a rotation. See `event-rotate.ts`. */
  seq: number
  /** ISO. The local JSON store's correct representation, per the house rule. */
  at: string
  source: EventSource
  kind: EventKind
  /** The state this session was in before, when it was known. Absent on the first sighting. */
  from?: SessionActivity
  /** agentop's session id for a managed row, `external:…` / `closed:…` otherwise. */
  id: string
  harness?: HarnessId
  cwd: string
  /** The piece of work this session belongs to — what `--task` filters on. */
  task?: string
  /** The session's name, when it has one. */
  label?: string
  /**
   * The harness's own conversation id, when it is known exactly.
   *
   * This is the ONLY key a poll event and a hook event provably share, so it is what
   * `event-dedupe.ts` prefers. Absent for a session started fresh, because the harness creates the
   * conversation and does not report it back.
   */
  conversationId?: string
  /**
   * The last few lines of what the session had on screen.
   *
   * This is the user's own text — anything they typed can be in it. It stays in `~/.agentistics`
   * with the permissions the rest of that directory uses, and nothing in this feature sends it
   * anywhere off the machine.
   */
  lines?: string[]
}

/** What a producer knows about a session before it decides whether anything changed. */
export interface EventCandidate {
  id: string
  harness?: HarnessId
  cwd: string
  task?: string
  label?: string
  conversationId?: string
  activity?: SessionActivity
  lines?: string[]
}
