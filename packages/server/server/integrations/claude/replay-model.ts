/**
 * integrations/claude/replay-model.ts — PURE. One `model.invoked` + `model.completed` per billed
 * response in a Claude Code transcript, keyed on `message.id` (O-8), plus one `model.failed` per
 * client-visible API failure.
 *
 * ## One billed response is emitted ONCE, with its FINAL usage
 *
 * Claude Code writes one response as SEVERAL consecutive assistant lines when its content has
 * several blocks (text, then a `tool_use`, …), and every one of those lines repeats the SAME
 * `message.usage` (`usage-dedupe.ts` — measured: 148 usage lines over 79 distinct ids on one real
 * session, every repeat byte-identical). `usage-dedupe.ts`'s in-memory `Map` keeps the FIRST row it
 * meets per id and lets a later one overwrite it (last wins), which is fine for a one-shot reduce —
 * but a REPLAY that must emit each event exactly once as it becomes provably final cannot answer
 * "is this the last line of this id" without reading ahead. So a response is HELD (not emitted)
 * until something PROVES it is closed: the START OF A DIFFERENT RESPONSE — an assistant line carrying
 * usage (or an API-error line) under another `message.id`, or with none. One agent's transcript
 * holds one response at a time, so the next one beginning is the proof the previous one finished.
 * `finishModelFold(final: true)` is the other way a held response closes, for the tail of a
 * transcript with nothing after it. `finishModelFold(final: false)` — the LIVE case — leaves it held,
 * because the very next line appended to the file could still be another part of the same response.
 *
 * **A user line, an attachment or a system line does NOT close it — measured, 2026-09-25.** The
 * first version of this fold closed on ANY other record and emitted one response twice: Claude Code
 * interleaves the results of a response's parallel tool calls (and attachments) BETWEEN that
 * response's own lines, so the same `message.id` resumes after them. Counted over the 60 most recent
 * transcripts on this machine, 211 such resumptions in 15 of them. Each one was a second
 * `model.completed` under the same provider-keyed event id — a duplicate row the journal would drop
 * and a projection summing the batch would count.
 *
 * **An id is emitted AT MOST ONCE** (`emittedIds`), whatever the order its lines arrive in: a line
 * whose id was already emitted is the same billing event and adds nothing. That is `countUsage`'s
 * own rule, so the four counters summed over these events equal the legacy walk's exactly (pinned
 * by `replay-fixture.test.ts` over a real transcript's structure). The usage emitted is the LAST
 * read before the response closed; every repeat measured so far is byte-identical, and a repeat that
 * arrives after the close could only be kept by emitting early partials, which the journal's
 * first-row-wins rule would then preserve.
 *
 * ## API error lines — measured, not guessed
 *
 * `isApiErrorMessage: true` marks an assistant line Claude Code injects itself when a call could not
 * be completed. Measured on this machine, 2026-09-25: 263 such lines across 8 real sessions (of 96
 * carrying the flag at all), spanning exactly six `error` values — `rate_limit`, `server_error`,
 * `invalid_request`, `authentication_failed`, `oauth_org_not_allowed`, `model_not_found` — every one
 * a plain top-level STRING (never a structured object), and every one of the 263 lines had
 * `message.model === '<synthetic>'`, all-zero usage, and a `message.id`. Every occurrence represents
 * a call that did not complete, so each becomes a `model.failed`. A DIFFERENT, more common shape was
 * also measured and is NOT a failure: `message.model === '<synthetic>'` with `isApiErrorMessage`
 * absent or `false` and NO `error` field at all (e.g. the text "No response requested.") — a benign
 * synthetic notice, all-zero usage, nothing billed and nothing that failed. Cross-checked over 134
 * `<synthetic>`-model lines: every `isApiErrorMessage: false` line carried no `error` field, and
 * every `error`-bearing line carried `isApiErrorMessage: true` — the two are exactly aligned, so the
 * flag alone is a safe discriminator.
 *
 * A `<synthetic>` line names no real model, so `model.failed` cannot say what was asked for from the
 * line itself. `state.lastRealModel` — the last non-`<synthetic>` `message.model` this walk has
 * folded — stands in ("the requested model if known" per the spec this module was built against);
 * a transcript that has not yet seen a real model reports nothing rather than a guess with no basis
 * (`'<synthetic>'` itself is explicitly not an acceptable substitute).
 *
 * ## No conversation text
 *
 * `errorClass` is the `error` field's own short code, verbatim — never the human-readable message
 * text beside it (`"You've hit your session limit · resets …"`, `"Prompt is too long"`, …). Nothing
 * else in this module reads `message.content` at all.
 */
import { contextOfUsage } from '../../jsonl'
import type { ModelCompletedData, ModelFailedData, ModelInvokedData } from '@agentistics/core'
import { type ClaudeReplayContext, type EmitEvent, lineRef, makeEvent, num, str } from './replay-core'

/** `message.usage`, flattened to primitives at read time — see the header on `cloneModelFold`. */
interface RawUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  /** Whether `usage.cache_creation` existed AT ALL — `cacheWriteByTtl` is gated on this, not on the two fields being non-zero. */
  hasCacheCreation: boolean
  ephemeral5m: number
  ephemeral1h: number
}

function messageOf(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  const m = entry.message
  return m && typeof m === 'object' ? (m as Record<string, unknown>) : undefined
}

function extractUsage(msg: Record<string, unknown> | undefined): RawUsage | undefined {
  const usage = msg?.usage
  if (!usage || typeof usage !== 'object') return undefined
  const u = usage as Record<string, unknown>
  const cc = u.cache_creation
  const hasCacheCreation = !!cc && typeof cc === 'object'
  const ccObj = hasCacheCreation ? (cc as Record<string, unknown>) : undefined
  return {
    input_tokens: num(u.input_tokens),
    output_tokens: num(u.output_tokens),
    cache_read_input_tokens: num(u.cache_read_input_tokens),
    cache_creation_input_tokens: num(u.cache_creation_input_tokens),
    hasCacheCreation,
    ephemeral5m: hasCacheCreation ? num(ccObj!.ephemeral_5m_input_tokens) : 0,
    ephemeral1h: hasCacheCreation ? num(ccObj!.ephemeral_1h_input_tokens) : 0,
  }
}

/** One response still being assembled across its several transcript lines — see the module header. */
interface HeldResponse {
  id: string
  /** The line of the FIRST record of this id — `sourceRef`, and the `occurredAt` fallback, read from it. */
  firstLineNo: number
  model: string
  firstTs: string | undefined
  lastTs: string | undefined
  harnessVersion: string | undefined
  /** The MOST RECENT usage record read for this id — usage-dedupe's "last wins", one line at a time. */
  usage: RawUsage
}

export interface ModelFoldState {
  held: HeldResponse | undefined
  /** Every `message.id` already emitted — a later line of one of them is not a second response. */
  emittedIds: Set<string>
  /** The last non-`<synthetic>` `message.model` this walk has folded — see the module header. */
  lastRealModel: string | undefined
}

export function emptyModelFold(): ModelFoldState {
  return { held: undefined, emittedIds: new Set(), lastRealModel: undefined }
}

/** Deep enough that folding the clone never mutates the original — the one collection is copied. */
export function cloneModelFold(s: ModelFoldState): ModelFoldState {
  return {
    held: s.held ? { ...s.held, usage: { ...s.held.usage } } : undefined,
    emittedIds: new Set(s.emittedIds),
    lastRealModel: s.lastRealModel,
  }
}

function invokedData(model: string, providerRequestId: string | undefined): ModelInvokedData {
  const data: ModelInvokedData = { provider: 'anthropic', model }
  if (providerRequestId) data.providerRequestId = providerRequestId
  return data
}

function completedData(u: RawUsage, model: string, providerRequestId: string | undefined): ModelCompletedData {
  const data: ModelCompletedData = {
    provider: 'anthropic',
    model,
    usage: {
      input: u.input_tokens,
      output: u.output_tokens,
      cacheRead: u.cache_read_input_tokens,
      cacheWrite: u.cache_creation_input_tokens,
    },
    status: 'completed',
  }
  if (providerRequestId) data.providerRequestId = providerRequestId
  if (u.hasCacheCreation) data.cacheWriteByTtl = { ephemeral_5m: u.ephemeral5m, ephemeral_1h: u.ephemeral1h }
  const contextTokens = contextOfUsage({
    input_tokens: u.input_tokens,
    cache_creation_input_tokens: u.cache_creation_input_tokens,
    cache_read_input_tokens: u.cache_read_input_tokens,
  })
  if (contextTokens > 0) data.contextTokens = contextTokens
  return data
}

/** Emit the `model.invoked` + `model.completed` pair for one closed (or never-held) response. */
function emitResponse(
  ctx: ClaudeReplayContext, id: string | undefined, lineNo: number, model: string, occurredAt: string,
  harnessVersion: string | undefined, usage: RawUsage, emit: EmitEvent,
): void {
  const sourceRef = lineRef(ctx, lineNo)
  const opts = {
    sourceRef, occurredAt, confidence: 'exact' as const,
    ...(id ? { providerRequestId: id } : {}),
    ...(harnessVersion ? { harnessVersion } : {}),
  }
  emit(makeEvent(ctx, 'model.invoked', invokedData(model, id), opts))
  emit(makeEvent(ctx, 'model.completed', completedData(usage, model, id), opts))
}

function closeHeld(state: ModelFoldState, ctx: ClaudeReplayContext, emit: EmitEvent): void {
  const held = state.held
  if (!held) return
  const occurredAt = held.firstTs ?? held.lastTs ?? ctx.recordedAt
  emitResponse(ctx, held.id, held.firstLineNo, held.model, occurredAt, held.harnessVersion, held.usage, emit)
  state.emittedIds.add(held.id)
  state.held = undefined
}

export function foldModelEntry(
  state: ModelFoldState, ctx: ClaudeReplayContext, entry: Record<string, unknown>, lineNo: number, emit: EmitEvent,
): void {
  const isAssistant = entry.type === 'assistant'
  const msg = isAssistant ? messageOf(entry) : undefined
  const id = isAssistant ? str(msg?.id) : undefined

  // Only an assistant line can say anything here; every other record — the results of this
  // response's own tool calls included — is interleaved with it and proves nothing (see the header).
  if (!isAssistant) return

  // RULE 1: a DIFFERENT response starting proves the held one closed — acted on before anything
  // else about this entry. A usage-less or synthetic non-error line starts no response.
  const startsResponse = entry.isApiErrorMessage === true || messageOf(entry)?.usage !== undefined
  if (state.held && id !== state.held.id && startsResponse) closeHeld(state, ctx, emit)

  const model = str(msg?.model)
  const ts = str(entry.timestamp)
  const harnessVersion = str(entry.version)

  if (model && model !== '<synthetic>') state.lastRealModel = model

  if (entry.isApiErrorMessage === true) {
    // RULE 5 — see the module header for what was measured. `model` prefers what THIS line states
    // (already folded into `lastRealModel` above, on the rare chance it is ever non-synthetic);
    // otherwise the last real model seen earlier in the transcript; otherwise nothing is emitted.
    const failedModel = state.lastRealModel
    if (!failedModel) return
    const errorClass = str(entry.error)
    const data: ModelFailedData = { provider: 'anthropic', model: failedModel, status: 'failed' }
    if (errorClass) data.errorClass = errorClass
    emit(makeEvent(ctx, 'model.failed', data, {
      sourceRef: lineRef(ctx, lineNo),
      occurredAt: ts ?? ctx.recordedAt,
      // The FAILURE is a fact read straight off the line; the MODEL attributed to it may be a guess
      // from history rather than this line's own statement — see `Confidence`'s definition.
      confidence: state.lastRealModel === model ? 'exact' : 'inferred',
      ...(harnessVersion ? { harnessVersion } : {}),
    }))
    return
  }

  // A synthetic, non-error line (e.g. "No response requested.") — nothing billed, nothing failed.
  if (!model || model === '<synthetic>') return

  const usage = extractUsage(msg)
  if (!usage) return

  if (!id) {
    // RULE 4: a record with no `message.id` is counted ALWAYS (usage-dedupe) — it can never be
    // shown to be part of anything else, so it is emitted immediately rather than held.
    emitResponse(ctx, undefined, lineNo, model, ts ?? ctx.recordedAt, harnessVersion, usage, emit)
    return
  }

  // A line of a response already emitted: the same billing event, counted once (`countUsage`).
  if (state.emittedIds.has(id)) return

  if (state.held && state.held.id === id) {
    // A later line of the SAME response — usage-dedupe's "last wins", one line at a time.
    state.held.usage = usage
    if (!state.held.harnessVersion && harnessVersion) state.held.harnessVersion = harnessVersion
    if (ts) state.held.lastTs = ts
    return
  }

  // A NEW response starts here — any previously held one was already closed above.
  // (`startsResponse` is true on this path: `extractUsage` found usage.)
  state.held = { id, firstLineNo: lineNo, model, firstTs: ts, lastTs: ts, harnessVersion, usage }
}

export interface FinishModelOptions {
  final: boolean
}

/**
 * Flush the held response when the transcript is COMPLETE (`final: true`); otherwise leave it held,
 * because the next appended line could still belong to it. Idempotent: `closeHeld` clears
 * `state.held` on emission, so a second `final: true` call finds nothing left to close.
 */
export function finishModelFold(state: ModelFoldState, ctx: ClaudeReplayContext, final: boolean, emit: EmitEvent): void {
  if (!final) return
  closeHeld(state, ctx, emit)
}
