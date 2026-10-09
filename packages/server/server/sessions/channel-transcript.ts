/**
 * channel-transcript.ts — a conversation read through the ENGINE's chat channel, for every surface
 * that reads one whole rather than following it (`readSessionChat`, the conversation search, the
 * chat stream's fallback that has to say in words why there is nothing to show).
 *
 * F4.A deleted the host's own per-harness readers (`*-chat.ts`, `chat-tail.ts`'s window,
 * `transcript-fork.ts`): the engine holds byte-equal copies behind `HarnessChat`, so a second set in
 * the host was a second parser of the same bytes (P-10). This module gives the callers the same
 * `HarnessTranscript` seam they always had — `resolve` then `read` — with both halves answered by the
 * channel: `resolve` is `HarnessChat.resolve` (the engine follows forks itself) and `read` is one
 * `follow` until the first `window`.
 *
 * `null` from `transcriptReaderFor` = no engine, or an integration that declares no chat: the caller
 * refuses IN WORDS, naming the harness, exactly as it did for a harness with no host reader.
 */

import type { ChatSourceRef, HarnessChat } from '@agentistics/engine-api'
import { engine } from '../engine/load'
import { firstWindow } from './adapter-chat'
import type { TranscriptRead, TranscriptRef } from './harness-transcript'

export interface ChannelTranscript {
  /** The source's re-openable reference (the transcript path, where the harness has one), or `null`. */
  resolve(ref: TranscriptRef): Promise<string | null>
  /** The conversation, oldest first, capped at `max` turns from the end. Throws when it cannot be read. */
  read(sourceRef: string, max: number): Promise<TranscriptRead>
}

/** The engine's chat channel for a harness, or `undefined` (no engine, or a declared absence). */
export function chatChannelFor(harness: string): HarnessChat | undefined {
  const integrations = engine()?.integrations as Record<string, { chat?: HarnessChat } | undefined> | undefined
  return integrations?.[harness]?.chat
}

/** How long one whole read may wait for its first window. A whole transcript can be large. */
const READ_WINDOW_MS = 15_000

/** PURE over its channel: the `HarnessTranscript`-shaped reader for one harness's channel. */
export function channelTranscript(chat: HarnessChat, timeoutMs: number = READ_WINDOW_MS): ChannelTranscript {
  // `read` is handed back the `sourceRef` its own `resolve` answered; the source it came from is kept
  // here so the engine is followed on the ref IT minted, never on one rebuilt from a string.
  const sources = new Map<string, ChatSourceRef>()
  return {
    async resolve(ref) {
      const src = await chat.resolve(ref)
      if (!src) return null
      sources.set(src.sourceRef, src)
      while (sources.size > 16) sources.delete(sources.keys().next().value!)
      return src.sourceRef
    },
    async read(sourceRef, max) {
      const src = sources.get(sourceRef)
      if (!src) throw new Error('source not resolved by this reader')
      const window = await firstWindow(chat, src, max, timeoutMs)
      if (!window) throw new Error('the channel gave no window in time')
      return window
    },
  }
}

/** The reader for a harness named as a plain string, or `null` (see the header). */
export function transcriptReaderFor(harness: string | undefined): ChannelTranscript | null {
  if (!harness) return null
  const chat = chatChannelFor(harness)
  return chat ? channelTranscript(chat) : null
}
