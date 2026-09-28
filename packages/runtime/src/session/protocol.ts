/**
 * session/protocol.ts — the versioned wire frames a surface reads and writes (spec
 * docs/superpowers/specs/2026-09-27-runtime-b4-sessions.md §5, B4.3).
 *
 * PURE. No IO, no clock, no hub state — this file only shapes the two directions of traffic and
 * validates the untrusted one.
 *
 * ## Two directions
 *
 * OUTBOUND (hub → watcher, `OutboundFrame`) is produced by `hub.ts` and never invented anywhere
 * else — a surface trusts it because exactly one place mints it. There is no parser for it:
 * nothing outside this process reads it as untrusted input.
 *
 * INBOUND (watcher → hub, `InboundFrame`) is exactly the opposite: it arrives as a raw string over
 * whatever transport the integrator wires up (a WebSocket message, most likely), and it is
 * ADVERSARIAL input by construction — a browser tab, not this process, decided its bytes.
 * `parseInboundFrame` is therefore the ONLY way an `InboundFrame` comes into existence: every
 * field is bounded (`MAX_*` below), every unknown `kind` is refused rather than passed through,
 * and a malformed body is a stable `InboundReason`, never a thrown exception — the same shape
 * `input-protocol.ts`'s `parseInputMessage` already uses for the terminal's write channel, and for
 * the same reason (a malformed message from a browser is an ordinary outcome to answer, not a
 * defect to crash on).
 *
 * ## What a `delta` frame carries
 *
 * `delta` is TEXT ONLY — the model's growing answer, not a raw `ProviderStreamEvent`. A stream
 * carries far more than that (tool-call deltas, usage snapshots, block indices) and none of it is
 * this frame's job; `textDeltaFromProviderEvent` is the one place that narrows a live provider
 * event down to the string a watcher is shown, so the hub never has to know the provider's event
 * shape at all — it only ever receives a plain string to broadcast.
 */

import type { AgentisticsEvent } from '@agentistics/core'
import type { PersonQuestion } from '../tools/contract.ts'
import type { ProviderStreamEvent } from '../provider/client.ts'

/** Bumped on any breaking change to the frame shapes below. Carried on `hello` so a surface can
 *  refuse to speak to a hub whose version it does not understand, rather than misreading a frame. */
export const PROTOCOL_VERSION = 1 as const

/** How the last question this session asked was resolved. */
export type AskOutcome = 'answered' | 'cancelled' | 'timeout'

/** Why an input was refused, echoed on its `ack`. Exactly the three the spec names — a fourth
 *  reason is a widening of the vocabulary, not a value some caller invents inline. */
export type InputRefusalCode = 'queue-full' | 'session-closed' | 'not-driver'

// ── OUTBOUND: hub → watcher ─────────────────────────────────────────────────────────────────────

/** The first frame a watcher ever receives — states the protocol it is about to speak and the
 *  cursor it is resuming from (see `hub.ts`'s `watch()` for exactly what `cursor` means). */
export interface HelloFrame {
  kind: 'hello'
  sessionId: string
  cursor: number
  protocol: number
}

/** A canonical fact, exactly as the runtime journaled it. Carries a per-session `seq`. */
export interface EventFrame {
  kind: 'event'
  seq: number
  event: AgentisticsEvent
}

/** A piece of the model's answer as it streams in. Ephemeral in spirit (a later `event` carries
 *  the durable turn) but still `seq`-numbered and replayable, so a watcher that reconnects mid-turn
 *  is not left staring at a blank pane until the turn ends. */
export interface DeltaFrame {
  kind: 'delta'
  seq: number
  runId?: string
  text: string
}

/** A question — from the policy or from the model — broadcast to every watcher at once. */
export interface AskFrame {
  kind: 'ask'
  seq: number
  question: PersonQuestion
}

/** The question named by `questionId` is no longer open. Always follows an `ask` with the same id. */
export interface AskClosedFrame {
  kind: 'ask-closed'
  seq: number
  questionId: string
  outcome: AskOutcome
}

/** The delivery status of one submitted input — broadcast to EVERY watcher (not only the one that
 *  sent it), so every screen open on this session sees the same thing happened. */
export interface AckFrame {
  kind: 'ack'
  /** Absent when the input was refused before it could be assigned one. */
  inputSeq?: number
  clientRef: string
  status: 'queued' | 'refused'
  code?: InputRefusalCode
  sentence?: string
}

/** Sent to ONE watcher whose own queue could not keep up (or whose requested replay window has
 *  partly or wholly fallen out of the ring) — never broadcast, because it describes what THAT
 *  reader missed. `resumeAt` is the seq of the next frame this watcher will actually receive. */
export interface GapFrame {
  kind: 'gap'
  missed: number
  resumeAt: number
}

/** The session is over. The terminal frame — nothing follows it for this watcher. */
export interface ClosedFrame {
  kind: 'closed'
  reason: string
}

export type OutboundFrame =
  | HelloFrame
  | EventFrame
  | DeltaFrame
  | AskFrame
  | AskClosedFrame
  | AckFrame
  | GapFrame
  | ClosedFrame

/** The subset of frames that occupy a session-wide, monotonic `seq` and are therefore the ones
 *  stored in the replay ring. `ack`/`gap`/`closed`/`hello` are per-delivery or per-watcher and are
 *  never replayed to a reconnecting watcher. */
export type SequencedOutboundFrame = EventFrame | DeltaFrame | AskFrame | AskClosedFrame

export function isSequencedFrame(frame: OutboundFrame): frame is SequencedOutboundFrame {
  return frame.kind === 'event' || frame.kind === 'delta' || frame.kind === 'ask' || frame.kind === 'ask-closed'
}

export function encodeOutboundFrame(frame: OutboundFrame): string {
  return JSON.stringify(frame)
}

/**
 * Narrow a live provider stream event down to the text a `delta` frame carries. Everything that is
 * not a `text-delta` (tool-call deltas, `started`, `usage`, `end`, …) is not text a watcher reads as
 * the model's growing answer, so it yields `null` rather than an empty or synthesized string.
 */
export function textDeltaFromProviderEvent(e: ProviderStreamEvent): string | null {
  return e.type === 'text-delta' ? e.text : null
}

// ── INBOUND: watcher → hub (UNTRUSTED) ──────────────────────────────────────────────────────────

export type InboundFrame =
  | { kind: 'input'; clientRef: string; text: string }
  | { kind: 'answer'; questionId: string; choice?: number; text?: string }
  | { kind: 'cancel'; runId?: string }

/** Every stable rejection an inbound frame can fail with — a code the integrator can log or map,
 *  never the raw parse exception. */
export type InboundReason =
  | 'oversized'
  | 'bad-json'
  | 'bad-frame'
  | 'unknown-kind'
  | 'missing-client-ref'
  | 'client-ref-too-long'
  | 'empty-text'
  | 'text-too-long'
  | 'missing-question-id'
  | 'question-id-too-long'
  | 'bad-choice'
  | 'answer-text-too-long'
  | 'run-id-too-long'

export type InboundParseResult =
  | { ok: true; frame: InboundFrame }
  | { ok: false; reason: InboundReason }

/** A raw message longer than this is refused before it is even `JSON.parse`d — the size bound the
 *  build note asks for, applied before any other work is spent on the bytes. */
export const MAX_INBOUND_FRAME_BYTES = 131_072

/** A `clientRef` is the surface's own idempotency key for one submitted input — small by nature. */
export const MAX_CLIENT_REF_LEN = 128

/** An `input`'s text — a chat message, not a file. Generous (a long pasted prompt) and still
 *  bounded, so one frame cannot be used to make the hub buffer an unbounded string. */
export const MAX_INPUT_TEXT_LEN = 65_536

export const MAX_QUESTION_ID_LEN = 200

/** `answer.text` — the free-text half of an answer, when the question allows it. */
export const MAX_ANSWER_TEXT_LEN = 8_192

/** An option index cannot sanely exceed this — `PersonQuestion.options` is itself capped at a
 *  handful of entries (`ask-user.ts`'s `MAX_OPTIONS`); this is a defensive outer bound, not the
 *  real limit, which the asker itself enforces against the question it actually asked. */
export const MAX_CHOICE = 1000

export const MAX_RUN_ID_LEN = 100

function isPlainRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/**
 * Validate one raw message from a watcher into a typed `InboundFrame`, or a stable rejection.
 *
 * Never throws — malformed input from a browser (or a stale/adversarial client) is an ordinary
 * outcome, not a defect the caller must guard against separately.
 */
export function parseInboundFrame(raw: string): InboundParseResult {
  if (raw.length > MAX_INBOUND_FRAME_BYTES) return { ok: false, reason: 'oversized' }

  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'bad-json' }
  }
  if (!isPlainRecord(obj)) return { ok: false, reason: 'bad-frame' }

  const kind = obj.kind

  if (kind === 'input') {
    const clientRef = obj.clientRef
    const text = obj.text
    if (typeof clientRef !== 'string' || clientRef.length === 0) return { ok: false, reason: 'missing-client-ref' }
    if (clientRef.length > MAX_CLIENT_REF_LEN) return { ok: false, reason: 'client-ref-too-long' }
    if (typeof text !== 'string' || text.length === 0) return { ok: false, reason: 'empty-text' }
    if (text.length > MAX_INPUT_TEXT_LEN) return { ok: false, reason: 'text-too-long' }
    return { ok: true, frame: { kind: 'input', clientRef, text } }
  }

  if (kind === 'answer') {
    const questionId = obj.questionId
    const rawChoice = obj.choice
    const rawText = obj.text
    if (typeof questionId !== 'string' || questionId.length === 0) return { ok: false, reason: 'missing-question-id' }
    if (questionId.length > MAX_QUESTION_ID_LEN) return { ok: false, reason: 'question-id-too-long' }

    let choice: number | undefined
    if (rawChoice !== undefined) {
      if (typeof rawChoice !== 'number' || !Number.isInteger(rawChoice) || rawChoice < 0 || rawChoice > MAX_CHOICE) {
        return { ok: false, reason: 'bad-choice' }
      }
      choice = rawChoice
    }

    let text: string | undefined
    if (rawText !== undefined) {
      if (typeof rawText !== 'string') return { ok: false, reason: 'bad-frame' }
      if (rawText.length > MAX_ANSWER_TEXT_LEN) return { ok: false, reason: 'answer-text-too-long' }
      text = rawText
    }

    const frame: InboundFrame = { kind: 'answer', questionId, ...(choice !== undefined ? { choice } : {}), ...(text !== undefined ? { text } : {}) }
    return { ok: true, frame }
  }

  if (kind === 'cancel') {
    const rawRunId = obj.runId
    if (rawRunId === undefined) return { ok: true, frame: { kind: 'cancel' } }
    if (typeof rawRunId !== 'string') return { ok: false, reason: 'bad-frame' }
    if (rawRunId.length > MAX_RUN_ID_LEN) return { ok: false, reason: 'run-id-too-long' }
    return { ok: true, frame: { kind: 'cancel', runId: rawRunId } }
  }

  return { ok: false, reason: 'unknown-kind' }
}
