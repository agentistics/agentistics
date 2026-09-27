/**
 * stream.ts — opening a provider's live answer safely, and sharing it through ONE hub.
 *
 * `ProviderClient.stream` is optional (`client.ts`): a client whose `capabilities.streaming` is
 * false promises none. A caller that asked for a stream from such a client must get a REFUSAL IN
 * WORDS — never a hang, never an iterator that never yields, never a silent fallback to the
 * non-streamed call (which would be a different request than the one asked for).
 *
 * `providerEventStream` wraps a `ProviderStream` in the generic hub (`stream/event-stream.ts`) with
 * the provider's own overflow rule: deltas (`text-delta`, `tool-call-delta`, `usage`) are EPHEMERAL
 * and may be dropped-and-counted for a reader that falls behind; `started`, `tool-call`,
 * `tool-call-failed` and the terminal `end` are the record and are never dropped. The `end` event
 * is retained, so a reader that subscribes after the answer finished still learns the outcome.
 */
import type { ProviderId } from '@agentistics/core'
import type { ProviderClient, ProviderRequest, ProviderStream, ProviderStreamEvent } from './client.ts'
import { createEventStream, type EventStream, type EventStreamOptions } from '../stream/event-stream.ts'

export interface StreamingRefusal {
  ok: false
  reason: 'streaming-unsupported'
  /** a sentence CODE rendered by the caller's i18n */
  userCode: 'provider.streaming_unsupported'
  provider: ProviderId
}

export type OpenProviderStreamResult = { ok: true; stream: ProviderStream } | StreamingRefusal

/**
 * Pure: may this client stream at all? `null` = yes. A client that declares `streaming: true` but
 * has no `stream` method breaks its own contract, and is refused the same way rather than trusted.
 * Checked BEFORE anything is recorded, so a call that cannot be made leaves no event behind.
 */
export function streamingRefusal(client: ProviderClient): StreamingRefusal | null {
  if (client.capabilities.streaming && typeof client.stream === 'function') return null
  return { ok: false, reason: 'streaming-unsupported', userCode: 'provider.streaming_unsupported', provider: client.provider }
}

/** Open one attempt as a live stream, or refuse in words. Never throws. */
export function openProviderStream(client: ProviderClient, req: ProviderRequest, attempt: number): OpenProviderStreamResult {
  const refusal = streamingRefusal(client)
  if (refusal) return refusal
  return { ok: true, stream: client.stream!(req, attempt) }
}

/** Deltas are for people watching live; the record is everything else. */
export function isEphemeralProviderEvent(e: ProviderStreamEvent): boolean {
  return e.type === 'text-delta' || e.type === 'tool-call-delta' || e.type === 'usage'
}

/** A hub configured with the provider overflow rule. Feed it with `hub.pipe(stream)`. */
export function providerEventStream(
  opts: Omit<EventStreamOptions<ProviderStreamEvent>, 'droppable' | 'retain'> = {},
): EventStream<ProviderStreamEvent> {
  return createEventStream<ProviderStreamEvent>({
    ...opts,
    droppable: isEphemeralProviderEvent,
    retain: e => e.type === 'end',
  })
}
