/**
 * anthropic/raw-stream.ts — PURE. Reads Anthropic's server-sent-event stream (the RAW bytes the
 * capturing fetch tees off the wire) into the live `ProviderStreamEvent`s and, when the body is
 * over, into the terminal verdict of the attempt. No fs, no fetch, no clock: every fact comes from
 * the text it is handed. Spec: docs/superpowers/specs/2026-09-19-agentistics-runtime-master.md §22
 * ("Streaming differs in ways a shared reader must know"), §22.1.1, §24.2; the B1 provider spec
 * (2026-09-25-runtime-b1-provider.md) §4.1, §4.3, §4.4.
 *
 * The event grammar is Anthropic's own (https://docs.anthropic.com/en/api/messages-streaming):
 * `message_start`, then per content block `content_block_start` / `content_block_delta`* /
 * `content_block_stop`, then `message_delta` (stop reason + usage), then `message_stop`, with
 * `ping`s anywhere and, possibly, an `error` event.
 *
 * ## The rules this module exists to hold
 *
 * - **`message_delta.usage` is CUMULATIVE.** Each one restates the running figure, so the LAST one
 *   wins and nothing is ever summed. It is MERGED over `message_start.message.usage` key by key (the
 *   start carries the input side, the deltas carry at least `output_tokens`, and a newer API may
 *   restate the input side too) and the merged object goes through `@agentistics/core`'s
 *   `fromAnthropicUsage` — the very function the non-streamed reader (`raw.ts`) uses, so the D21
 *   rule (a counter the source did not state is ABSENT, never 0), the TTL split and the context gauge
 *   are decided in one place for both paths.
 * - **HTTP 200 is not success.** An in-band `event: error` ends the attempt `failed`, classified by
 *   its `error.type` — never `completed`, however much text streamed before it. So does a body that
 *   ends without `message_stop` (the connection dropped or was cut): that is `failed` with
 *   `usageOutcome: 'unknown'`, because the provider may well have billed what it generated. There is
 *   no half-completed `completed`.
 * - **A frame this reader cannot parse makes the response unreadable.** A skipped frame could have
 *   been the `message_delta` carrying the usage, so the attempt fails `response-unreadable` rather
 *   than completing with numbers read around a hole.
 * - **The SSE framing is robust to where the network cuts the bytes**: a chunk may end mid-line,
 *   mid-field, between `\r` and `\n`, or mid-event. An event is dispatched only at its blank line; an
 *   event cut off by the end of the body is never dispatched (the SSE rule, and exactly what makes a
 *   truncated final frame read as "no `message_stop`").
 *
 * ## Tool calls (the B2.2 assembler), and the `max_tokens` decision
 *
 * A `tool_use` block's arguments stream as partial JSON text (`input_json_delta`). The assembler
 * (`../tool-call-stream.ts`, injected so this module stays pure and testable) owns every rule about
 * whether that text is a valid call. This module only drives it: `start` on the block's start,
 * `append` per delta (each also surfaced as a `tool-call-delta` event), `stop` once per block, and
 * `finish` for blocks that never closed.
 *
 * `stop_reason` arrives in `message_delta`, AFTER the blocks have stopped — so at a block's
 * `content_block_stop` this reader cannot yet say whether the response was cut by `max_tokens`. Only
 * the LAST content block can have been cut (generation stops there), so the decision is deferred for
 * at most one block and never guessed: the `stop` of a `tool_use` block is held until the next thing
 * that settles it — another `content_block_start` (it was not the last block → not truncated) or
 * `message_delta` (truncated exactly when `stop_reason === 'max_tokens'`). The cost is that the
 * last tool call's `tool-call` event lands a frame later, immediately before `message_delta`'s
 * `usage` event; nothing is decided twice and the assembler's JSON rule is never re-implemented here.
 *
 * A call that fails to assemble is a `tool-call-failed` event and a `ToolCallFailure` on the
 * completed result; its block is carried in `content` as `{type: 'other', rawType: 'tool_use'}` and
 * never as a `tool_use`, so nothing downstream can execute it. It does NOT fail the invocation: the
 * response was billed and its usage is real. A `tool-call` event states only that the arguments
 * assembled; acting on it waits for the `end` event to say the attempt completed (B3).
 *
 * This module is a NON-holder of the provider key: it only ever sees the response side.
 */
import {
  classifyProviderError,
  fromAnthropicStopReason,
  fromAnthropicUsage,
  type ClassifierInput,
  type ProviderError,
  type ProviderUsage,
  type StopReason,
  type UsageAnomaly,
} from '@agentistics/core'
import type { ProviderContent, ProviderStreamEvent, ToolCallFailure } from '../client.ts'
import type { ToolCallAssembler, ToolCallStep } from '../tool-call-stream.ts'

// ── SSE framing ───────────────────────────────────────────────────────────────────────────────

/** One dispatched server-sent event. `event` is absent when the frame carried no `event:` line. */
export interface SseFrame {
  event?: string
  data: string
}

export interface SseDecoder {
  /** Feed the next piece of decoded text; returns every event COMPLETED by it, in order. */
  push(text: string): SseFrame[]
  /**
   * The body is over. Returns nothing: per the SSE rule an event not terminated by its blank line is
   * never dispatched, and a line with no terminator is not a complete line.
   */
  end(): SseFrame[]
}

/**
 * An incremental SSE decoder (WHATWG HTML "server-sent events", interpreting an event stream):
 * lines end in `\r\n`, `\n` or `\r`; a line starting with `:` is a comment; `field: value` strips
 * ONE leading space from the value; `data` lines join with `\n`; a blank line dispatches. `id` and
 * `retry` are read and ignored (a single HTTP response is never reconnected here). A leading BOM is
 * dropped.
 */
export function createSseDecoder(): SseDecoder {
  let buf = ''
  let first = true
  let eventName: string | undefined
  let dataLines: string[] = []
  let hasData = false

  function onLine(line: string, out: SseFrame[]): void {
    if (line === '') {
      if (hasData) {
        const frame: SseFrame = { data: dataLines.join('\n') }
        if (eventName !== undefined && eventName !== '') frame.event = eventName
        out.push(frame)
      }
      eventName = undefined
      dataLines = []
      hasData = false
      return
    }
    if (line.charCodeAt(0) === 0x3a /* ':' */) return
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.charCodeAt(0) === 0x20 /* ' ' */) value = value.slice(1)
    if (field === 'event') eventName = value
    else if (field === 'data') {
      dataLines.push(value)
      hasData = true
    }
  }

  return {
    push(text: string): SseFrame[] {
      if (first && text.length > 0) {
        first = false
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      }
      buf += text
      const out: SseFrame[] = []
      let start = 0
      for (let i = 0; i < buf.length; i++) {
        const c = buf.charCodeAt(i)
        if (c === 0x0a /* \n */) {
          onLine(buf.slice(start, i), out)
          start = i + 1
        } else if (c === 0x0d /* \r */) {
          // A `\r` as the LAST character may be the first half of a `\r\n` split across chunks:
          // hold it until the next chunk (or the end) says which.
          if (i === buf.length - 1) break
          onLine(buf.slice(start, i), out)
          if (buf.charCodeAt(i + 1) === 0x0a) i++
          start = i + 1
        }
      }
      buf = buf.slice(start)
      return out
    },
    end(): SseFrame[] {
      const out: SseFrame[] = []
      // A held lone `\r` terminated its line after all; anything else left is an unterminated line.
      if (buf.endsWith('\r')) onLine(buf.slice(0, -1), out)
      buf = ''
      // The frame still being built (no blank line yet) is discarded by rule — never dispatched.
      eventName = undefined
      dataLines = []
      hasData = false
      return out
    },
  }
}

// ── In-band errors ───────────────────────────────────────────────────────────────────────────

/**
 * An in-band `error` event on a 200 → `ProviderError`. The event states an `error.type` and no
 * status, so the kind is found through `@agentistics/core`'s own status table — the one status
 * whose documented `error.type` this is — rather than a second copy of that table here. The
 * result then states what the wire actually carried: `httpStatus: 200`.
 *
 * `usageOutcome` is always `'unknown'`: the response had been accepted and may have generated (and
 * billed) output before it broke, which is exactly what `'unknown'` means. A type the table does not
 * know stays `http-other`, not retryable, with the raw type kept verbatim.
 */
export function classifyInBandError(errorType: string | undefined, requestIdHeader?: string): ProviderError {
  const base: ClassifierInput = {}
  if (requestIdHeader !== undefined) base.requestIdHeader = requestIdHeader
  if (errorType !== undefined) {
    for (let status = 400; status < 600; status++) {
      const e = classifyProviderError({ ...base, httpStatus: status, errorType })
      if (e.kind !== 'http-other' && e.errorType === errorType) {
        return { ...e, httpStatus: 200, usageOutcome: 'unknown' }
      }
    }
  }
  const input: ClassifierInput = { ...base, httpStatus: 200 }
  if (errorType !== undefined) input.errorType = errorType
  return { ...classifyProviderError(input), usageOutcome: 'unknown' }
}

// ── The event reader ─────────────────────────────────────────────────────────────────────────

/** How the body ended, as the IO side observed it. */
export type StreamBodyEnd =
  /** the body was read to its end */
  | 'complete'
  /** reading failed mid-body (the connection dropped) */
  | 'errored'
  /** reading stopped because the caller aborted */
  | 'aborted'

export type StreamVerdict =
  | {
      ok: true
      messageId: string
      servedModel: string
      usage: ProviderUsage
      usageAnomalies: UsageAnomaly[]
      stopReason: StopReason
      content: ProviderContent[]
      toolCallFailures: ToolCallFailure[]
      /** events settled only by the end of the body (a held tool call, blocks that never closed) —
       *  the caller yields these BEFORE `end` */
      events: ProviderStreamEvent[]
    }
  | { ok: false; error: ProviderError; events: ProviderStreamEvent[] }

export interface AnthropicStreamReader {
  /** One dispatched SSE frame → the live events it produces (possibly none). Never throws. */
  accept(frame: SseFrame): ProviderStreamEvent[]
  /** The body is over. Called once. Never throws. */
  finish(end: StreamBodyEnd): StreamVerdict
}

export interface AnthropicStreamReaderOptions {
  /** the response's `request-id` header, when it carried one */
  requestId?: string
  /** a FRESH assembler for this attempt's tool calls (`../tool-call-stream.ts`) */
  assembler: ToolCallAssembler
}

interface Block {
  index: number
  rawType: string
  text: string
  /** tool_use only */
  id?: string
  name?: string
  /** tool_use only: what the assembler decided, once it has */
  step?: ToolCallStep
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * The state machine over Anthropic's stream events. See the module doc for every rule; the short
 * version: facts are read from the events themselves, usage is merged last-wins and never summed,
 * and anything short of a readable `message_start` … `message_stop` with no `error` is a failure.
 */
export function createAnthropicStreamReader(opts: AnthropicStreamReaderOptions): AnthropicStreamReader {
  const { assembler } = opts
  const blocks = new Map<number, Block>()
  const failures: ToolCallFailure[] = []

  let started = false
  let messageId: string | undefined
  let servedModel: string | undefined
  /** `undefined` until some event carried a usage OBJECT (then `fromAnthropicUsage` reads it) */
  let usageRaw: Record<string, unknown> | undefined
  let stopReasonRaw: unknown = null
  let stopDetailsRaw: unknown
  let stopped = false
  let inBandErrorType: string | undefined
  let inBandError = false
  let unreadable = false
  /** the tool_use block whose `stop` waits on what follows it (module doc, `max_tokens`) */
  let heldToolStop: number | undefined
  let finished = false

  function mergeUsage(u: unknown): void {
    if (!isObject(u)) return
    usageRaw = { ...(usageRaw ?? {}), ...u }
  }

  function settle(index: number, truncated: boolean, out: ProviderStreamEvent[]): void {
    const block = blocks.get(index)
    if (!block || block.step !== undefined) return
    const step = assembler.stop(index, truncated ? { truncated: true } : undefined)
    block.step = step
    if (step.ok) {
      out.push({ type: 'tool-call', index, id: step.call.id, name: step.call.name, input: step.call.input })
    } else {
      failures.push(step.failure)
      out.push({ type: 'tool-call-failed', failure: step.failure })
    }
  }

  function releaseHeld(truncated: boolean, out: ProviderStreamEvent[]): void {
    if (heldToolStop === undefined) return
    const index = heldToolStop
    heldToolStop = undefined
    settle(index, truncated, out)
  }

  function onEvent(ev: Record<string, unknown>, out: ProviderStreamEvent[]): void {
    switch (ev.type) {
      case 'ping':
        return
      case 'message_start': {
        const msg = isObject(ev.message) ? ev.message : undefined
        if (typeof msg?.id === 'string') messageId = msg.id
        if (typeof msg?.model === 'string') servedModel = msg.model
        mergeUsage(msg?.usage)
        if (!started) {
          started = true
          const s: Extract<ProviderStreamEvent, { type: 'started' }> = { type: 'started' }
          if (opts.requestId !== undefined) s.requestId = opts.requestId
          if (messageId !== undefined) s.messageId = messageId
          if (servedModel !== undefined) s.servedModel = servedModel
          out.push(s)
        }
        return
      }
      case 'content_block_start': {
        // A new block means the held one was not the last: it cannot have been cut by max_tokens.
        releaseHeld(false, out)
        const index = ev.index
        const cb = isObject(ev.content_block) ? ev.content_block : undefined
        if (typeof index !== 'number' || !cb) {
          unreadable = true
          return
        }
        const rawType = typeof cb.type === 'string' ? cb.type : 'unknown'
        const block: Block = { index, rawType, text: '' }
        if (rawType === 'text' && typeof cb.text === 'string') {
          block.text = cb.text
          if (cb.text.length > 0) out.push({ type: 'text-delta', index, text: cb.text })
        }
        if (rawType === 'tool_use') {
          if (typeof cb.id !== 'string' || typeof cb.name !== 'string') {
            unreadable = true
            return
          }
          block.id = cb.id
          block.name = cb.name
          assembler.start(index, cb.id, cb.name)
        }
        blocks.set(index, block)
        return
      }
      case 'content_block_delta': {
        const index = ev.index
        const delta = isObject(ev.delta) ? ev.delta : undefined
        if (typeof index !== 'number' || !delta) {
          unreadable = true
          return
        }
        const block = blocks.get(index)
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          if (!block || block.rawType !== 'text') {
            unreadable = true
            return
          }
          block.text += delta.text
          out.push({ type: 'text-delta', index, text: delta.text })
          return
        }
        if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          if (!block || block.rawType !== 'tool_use' || block.id === undefined || block.name === undefined) {
            unreadable = true
            return
          }
          assembler.append(index, delta.partial_json)
          out.push({ type: 'tool-call-delta', index, id: block.id, name: block.name, partialJson: delta.partial_json })
          return
        }
        // thinking_delta, signature_delta, citations_delta, … — carried by the block's raw type.
        return
      }
      case 'content_block_stop': {
        const index = ev.index
        if (typeof index !== 'number') {
          unreadable = true
          return
        }
        const block = blocks.get(index)
        if (block?.rawType === 'tool_use') {
          releaseHeld(false, out)
          heldToolStop = index
        }
        return
      }
      case 'message_delta': {
        const delta = isObject(ev.delta) ? ev.delta : undefined
        if (delta && 'stop_reason' in delta) stopReasonRaw = delta.stop_reason
        if (delta && 'stop_details' in delta) stopDetailsRaw = delta.stop_details
        releaseHeld(stopReasonRaw === 'max_tokens', out)
        mergeUsage(ev.usage)
        const output = isObject(ev.usage) ? ev.usage.output_tokens : undefined
        if (typeof output === 'number' && Number.isFinite(output) && output >= 0) {
          out.push({ type: 'usage', outputTokensSoFar: output })
        }
        return
      }
      case 'message_stop':
        stopped = true
        return
      case 'error': {
        inBandError = true
        const err = isObject(ev.error) ? ev.error : undefined
        if (typeof err?.type === 'string') inBandErrorType = err.type
        return
      }
      default:
        // An event type this reader does not know is not a fault: new ones are additive.
        return
    }
  }

  function contentOf(): ProviderContent[] {
    return [...blocks.values()]
      .sort((a, b) => a.index - b.index)
      .map((b): ProviderContent => {
        if (b.rawType === 'text') return { type: 'text', text: b.text }
        if (b.rawType === 'tool_use' && b.step?.ok) {
          return { type: 'tool_use', id: b.step.call.id, name: b.step.call.name, input: b.step.call.input }
        }
        return { type: 'other', rawType: b.rawType }
      })
  }

  return {
    accept(frame: SseFrame): ProviderStreamEvent[] {
      const out: ProviderStreamEvent[] = []
      // After an error, a stop or a hole, nothing more can change the verdict — later frames are
      // not read for facts (the capture still holds every byte).
      if (finished || inBandError || stopped || unreadable) return out
      let parsed: unknown
      try {
        parsed = JSON.parse(frame.data)
      } catch {
        unreadable = true
        return out
      }
      if (!isObject(parsed)) {
        unreadable = true
        return out
      }
      // `data.type` is the fact; `event:` restates it. An `error` named only by the event line is
      // still an error.
      if (frame.event === 'error' && parsed.type !== 'error') parsed = { type: 'error', error: parsed.error }
      try {
        onEvent(parsed as Record<string, unknown>, out)
      } catch {
        // An injected assembler that throws is a defect there, never a throw here.
        unreadable = true
      }
      return out
    },

    finish(end: StreamBodyEnd): StreamVerdict {
      finished = true
      const requestIdHeader = opts.requestId
      const fail = (input: ClassifierInput): StreamVerdict => {
        if (requestIdHeader !== undefined) input.requestIdHeader = requestIdHeader
        return { ok: false, error: classifyProviderError(input), events: [] }
      }

      if (inBandError) return { ok: false, error: classifyInBandError(inBandErrorType, requestIdHeader), events: [] }
      if (unreadable) return fail({ httpStatus: 200, responseUnreadable: true })
      if (stopped) {
        if (messageId === undefined || servedModel === undefined) {
          return fail({ httpStatus: 200, responseUnreadable: true })
        }
        const events: ProviderStreamEvent[] = []
        try {
          // A held stop with no message_delta after it: nothing said the response was cut.
          releaseHeld(false, events)
          for (const failure of assembler.finish()) {
            failures.push(failure)
            events.push({ type: 'tool-call-failed', failure })
            const block = blocks.get(failure.index)
            if (block && block.step === undefined) block.step = { ok: false, failure }
          }
        } catch {
          return fail({ httpStatus: 200, responseUnreadable: true })
        }
        const { usage, anomalies } = fromAnthropicUsage(usageRaw)
        return {
          ok: true,
          messageId,
          servedModel,
          usage,
          usageAnomalies: anomalies,
          stopReason: fromAnthropicStopReason(stopReasonRaw, stopDetailsRaw),
          content: contentOf(),
          toolCallFailures: [...failures],
          events,
        }
      }
      if (end === 'aborted') return fail({ transport: 'aborted' })
      // A complete body that never even began a message is not a message at all.
      if (end === 'complete' && !started) return fail({ httpStatus: 200, responseUnreadable: true })
      // The body ended (or broke) before `message_stop`: the provider may have generated and billed
      // output this reader never saw the end of.
      return fail({ transport: 'network', requestSent: true })
    },
  }
}
