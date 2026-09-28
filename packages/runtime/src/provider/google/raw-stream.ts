/**
 * google/raw-stream.ts — PURE. Reads Gemini's `streamGenerateContent?alt=sse` body (the RAW bytes the
 * capturing fetch tees off the wire) into the live `ProviderStreamEvent`s and, when the body is over,
 * into the terminal verdict of the attempt. No fs, no fetch, no clock. Spec: master §22 ("Streaming
 * differs in ways a shared reader must know"), B1 spec §4.1, §4.3.
 *
 * The grammar is the simplest of the three vendors': every SSE `data:` line is a complete
 * `GenerateContentResponse` JSON object (research 12 §3.3) — no event names, no `[DONE]` sentinel.
 * The SSE framing itself is `../anthropic/raw-stream.ts`'s decoder, reused (the WHATWG rules are not
 * vendor-specific).
 *
 * ## The rules this module holds
 *
 * - **`usageMetadata` is taken from the LAST chunk that carries it — never summed.** The Gemini
 *   reference (https://ai.google.dev/api/generate-content, read 2026-09-28) defines `usageMetadata`
 *   but says NOTHING about how it is distributed across a stream. Two readings are consistent with
 *   that silence and only one is safe: if the figure is cumulative (Anthropic's `message_delta`), the
 *   last one IS the total; if it appears only on the final chunk, the last one is the only one.
 *   Summing would double-count under the first and be a no-op under the second. Whether it is on
 *   every chunk is the one thing a live stream must confirm (B5b.2) — until then the reader RECORDS
 *   the evidence instead of guessing: `usage-on-multiple-chunks` when more than one chunk carried it,
 *   and `usage-not-monotonic` when a later chunk's counter is LOWER than an earlier one's (which
 *   would mean the chunks are not cumulative and "the last" is wrong).
 * - **HTTP 200 is not success.** An in-band `error` object on any chunk ends the attempt `failed`
 *   with `usageOutcome: 'unknown'` (the response was accepted and may have billed) — never
 *   `completed`, however much text streamed first. So does a body that ends with no `finishReason`
 *   (the connection dropped or was cut): `failed` / network / unknown. There is no half-completed
 *   `completed`.
 * - **A chunk this reader cannot parse makes the response unreadable.** A skipped chunk could have
 *   been the one carrying the usage, so the attempt fails `response-unreadable` rather than
 *   completing with numbers read around a hole.
 * - **Reading continues after `finishReason`.** The chunk that finishes the answer may not be the one
 *   that carries the final usage; only an error, a hole, or the end of the body stops the reader.
 *
 * ## Tool calls
 *
 * `functionCall.args` arrives as an already-parsed OBJECT (master §22), so there is no partial JSON to
 * accumulate and no `tool-call-delta` to emit. The object is still driven through the shared
 * assembler (`../tool-call-stream.ts`) — serialised once and fed as a single fragment — so the rules
 * about what counts as a valid call (an object, a declared tool) live in ONE place for every vendor.
 * A call that fails to assemble is a `tool-call-failed` event and a `ToolCallFailure` on the result,
 * carried in `content` as `{type:'other', rawType:'functionCall'}` and never as a `tool_use`, so
 * nothing downstream can execute it. It does not fail the attempt: the response was billed.
 *
 * A NON-holder of the provider key: it only ever sees the response side.
 */
import type { ProviderError, ProviderUsage, StopReason, UsageAnomaly, ClassifierInput } from '@agentistics/core'
import { classifyProviderError } from '@agentistics/core'
import type { ProviderContent, ProviderStreamEvent, ToolCallFailure } from '../client.ts'
import type { ToolCallAssembler } from '../tool-call-stream.ts'
import type { SseFrame, StreamBodyEnd } from '../anthropic/raw-stream.ts'
import type { CostStatement, UsageCertainty } from '../openai-compatible/usage.ts'
import { classifyGoogleInBandError, fromGoogleFinishReason, hasToolUse, isPlainObject, localCallId } from './raw.ts'
import { readGoogleUsage, type ToolUsePromptUsage } from './usage.ts'

export type StreamVerdict =
  | {
      ok: true
      messageId: ''
      servedModel: string
      usage: ProviderUsage
      usageAnomalies: UsageAnomaly[]
      usageNotes: string[]
      usageCertainty: UsageCertainty
      cost: CostStatement
      toolUsePrompt?: ToolUsePromptUsage
      stopReason: StopReason
      content: ProviderContent[]
      toolCallFailures: ToolCallFailure[]
      /** events settled only by the end of the body — the caller yields these BEFORE `end` */
      events: ProviderStreamEvent[]
    }
  | { ok: false; error: ProviderError; events: ProviderStreamEvent[] }

export interface GoogleStreamReader {
  /** One dispatched SSE frame → the live events it produces (possibly none). Never throws. */
  accept(frame: SseFrame): ProviderStreamEvent[]
  /** The body is over. Called once. Never throws. */
  finish(end: StreamBodyEnd): StreamVerdict
}

export interface GoogleStreamReaderOptions {
  /** the id the caller asked for — `servedModel`'s fallback when no chunk stated `modelVersion` (said in the notes) */
  requestedModel: string
  /** a FRESH assembler for this attempt's tool calls */
  assembler: ToolCallAssembler
}

type Block =
  | { kind: 'text'; index: number; text: string }
  | { kind: 'thought'; index: number }
  | { kind: 'tool'; index: number; step: { ok: true; id: string; name: string; input: Record<string, unknown> } | { ok: false } }
  | { kind: 'other'; index: number; rawType: string }

const COUNTERS = ['promptTokenCount', 'cachedContentTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'toolUsePromptTokenCount'] as const

function counter(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key]
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}

const OTHER_PART_KINDS: readonly string[] = [
  'functionResponse', 'executableCode', 'codeExecutionResult', 'inlineData', 'fileData',
]

export function createGoogleStreamReader(opts: GoogleStreamReaderOptions): GoogleStreamReader {
  const { assembler } = opts
  const blocks: Block[] = []
  const failures: ToolCallFailure[] = []

  let started = false
  let servedModel: string | undefined
  let usageRaw: Record<string, unknown> | undefined
  let usageChunks = 0
  let usageDecreased = false
  let finishReasonRaw: string | undefined
  let blockReason: string | undefined
  let inBandError: unknown
  let sawInBandError = false
  let unreadable = false
  let finished = false
  let calls = 0
  let nextIndex = 0

  function last(): Block | undefined {
    return blocks[blocks.length - 1]
  }

  function onPart(part: unknown, out: ProviderStreamEvent[]): void {
    if (!isPlainObject(part)) {
      blocks.push({ kind: 'other', index: nextIndex++, rawType: 'unknown' })
      return
    }
    const call = part.functionCall
    if (isPlainObject(call) && typeof call.name === 'string') {
      const ordinal = calls++
      const id = typeof call.id === 'string' && call.id.length > 0 ? call.id : localCallId(ordinal)
      const index = nextIndex++
      assembler.start(index, id, call.name)
      assembler.append(index, JSON.stringify(call.args === undefined ? {} : call.args) ?? 'null')
      // The args object is complete by construction — there is no cut-off to declare.
      const step = assembler.stop(index)
      if (step.ok) {
        blocks.push({ kind: 'tool', index, step: { ok: true, id: step.call.id, name: step.call.name, input: step.call.input } })
        out.push({ type: 'tool-call', index, id: step.call.id, name: step.call.name, input: step.call.input })
      } else {
        blocks.push({ kind: 'tool', index, step: { ok: false } })
        failures.push(step.failure)
        out.push({ type: 'tool-call-failed', failure: step.failure })
      }
      return
    }
    if (typeof part.text === 'string') {
      if (part.thought === true) {
        // A thought SUMMARY — carried by its kind, never delivered as answer text.
        if (last()?.kind !== 'thought') blocks.push({ kind: 'thought', index: nextIndex++ })
        return
      }
      // An EMPTY text part opens nothing: Gemini commonly closes a stream with a `text: ""` chunk that
      // only carries the `finishReason`, and a block for it would append an empty text after a tool
      // call — which the non-streamed reader (`toGoogleContent`) never does for the same body.
      if (part.text.length === 0) return
      let block = last()
      if (block?.kind !== 'text') {
        block = { kind: 'text', index: nextIndex++, text: '' }
        blocks.push(block)
      }
      block.text += part.text
      out.push({ type: 'text-delta', index: block.index, text: part.text })
      return
    }
    blocks.push({ kind: 'other', index: nextIndex++, rawType: OTHER_PART_KINDS.find(k => k in part) ?? 'unknown' })
  }

  function onChunk(chunk: Record<string, unknown>, out: ProviderStreamEvent[]): void {
    if (isPlainObject(chunk.error)) {
      sawInBandError = true
      inBandError = chunk.error
      return
    }
    if (typeof chunk.modelVersion === 'string' && chunk.modelVersion.length > 0) servedModel = chunk.modelVersion
    if (!started) {
      started = true
      const s: Extract<ProviderStreamEvent, { type: 'started' }> = { type: 'started' }
      if (servedModel !== undefined) s.servedModel = servedModel
      out.push(s)
    }

    const candidate = Array.isArray(chunk.candidates) && isPlainObject(chunk.candidates[0]) ? chunk.candidates[0] : undefined
    if (candidate) {
      if (isPlainObject(candidate.content) && Array.isArray(candidate.content.parts)) {
        for (const part of candidate.content.parts) onPart(part, out)
      }
      if (typeof candidate.finishReason === 'string' && candidate.finishReason.length > 0) {
        finishReasonRaw = candidate.finishReason
      }
    }
    const feedback = isPlainObject(chunk.promptFeedback) ? chunk.promptFeedback : undefined
    if (typeof feedback?.blockReason === 'string') blockReason = feedback.blockReason

    if (isPlainObject(chunk.usageMetadata)) {
      const next = chunk.usageMetadata
      if (usageRaw !== undefined) {
        for (const key of COUNTERS) {
          const before = counter(usageRaw, key)
          const now = counter(next, key)
          if (before !== undefined && now !== undefined && now < before) usageDecreased = true
        }
      }
      usageRaw = next
      usageChunks += 1
      const soFar = counter(next, 'candidatesTokenCount')
      // Candidates only: thoughts are their own counter and the event says "output tokens so far".
      if (soFar !== undefined) out.push({ type: 'usage', outputTokensSoFar: soFar })
    }
  }

  function contentOf(): ProviderContent[] {
    return blocks.map((b): ProviderContent => {
      if (b.kind === 'text') return { type: 'text', text: b.text }
      if (b.kind === 'tool') {
        return b.step.ok
          ? { type: 'tool_use', id: b.step.id, name: b.step.name, input: b.step.input }
          : { type: 'other', rawType: 'functionCall' }
      }
      if (b.kind === 'thought') return { type: 'other', rawType: 'thought' }
      return { type: 'other', rawType: b.rawType }
    })
  }

  return {
    accept(frame: SseFrame): ProviderStreamEvent[] {
      const out: ProviderStreamEvent[] = []
      // After an error or a hole nothing more can change the verdict (the capture still holds every byte).
      if (finished || sawInBandError || unreadable) return out
      let parsed: unknown
      try {
        parsed = JSON.parse(frame.data)
      } catch {
        unreadable = true
        return out
      }
      if (!isPlainObject(parsed)) {
        unreadable = true
        return out
      }
      try {
        onChunk(parsed, out)
      } catch {
        // An injected assembler that throws is a defect there, never a throw here.
        unreadable = true
      }
      return out
    },

    finish(end: StreamBodyEnd): StreamVerdict {
      finished = true
      const fail = (input: ClassifierInput): StreamVerdict => ({ ok: false, error: classifyProviderError(input), events: [] })

      if (sawInBandError) return { ok: false, error: classifyGoogleInBandError(inBandError), events: [] }
      if (unreadable) return fail({ httpStatus: 200, responseUnreadable: true })

      const complete = finishReasonRaw !== undefined || blockReason !== undefined
      if (!complete) {
        if (end === 'aborted') return fail({ transport: 'aborted' })
        // A complete body that never even began a response is not a response at all.
        if (end === 'complete' && !started) return fail({ httpStatus: 200, responseUnreadable: true })
        // The body ended (or broke) before any `finishReason`: the provider may have generated and
        // billed output this reader never saw the end of.
        return fail({ transport: 'network', requestSent: true })
      }

      const read = readGoogleUsage(usageRaw)
      const notes = [...read.notes]
      if (usageChunks > 1) notes.push('usage-on-multiple-chunks')
      if (usageDecreased) notes.push('usage-not-monotonic')
      if (servedModel === undefined) notes.push('served-model-unstated')

      const content = contentOf()
      const stopReason: StopReason = finishReasonRaw !== undefined
        ? fromGoogleFinishReason(finishReasonRaw, hasToolUse(content))
        : { kind: 'refusal', category: blockReason }

      const verdict: StreamVerdict = {
        ok: true,
        messageId: '',
        servedModel: servedModel ?? opts.requestedModel,
        usage: read.usage,
        usageAnomalies: read.anomalies,
        usageNotes: notes,
        usageCertainty: read.certainty,
        cost: read.cost,
        stopReason,
        content,
        toolCallFailures: [...failures],
        events: [],
      }
      if (read.toolUsePrompt) verdict.toolUsePrompt = read.toolUsePrompt
      return verdict
    },
  }
}
