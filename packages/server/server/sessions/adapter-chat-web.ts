/**
 * adapter-chat-web.ts — the IO half of `adapter-chat.ts`: which row, which engine channel, which hub.
 *
 * Reached ONLY with `featureOn('adapter-chat')` (the routes check it first), and every function answers
 * `null` whenever the legacy path should serve instead: no such row, no exact conversation link, no
 * engine, an integration that does not serve `chat` (a declared absence), the stream cap, or a
 * conversation whose channel failed a moment ago (`refuseAdapter`).
 */
import type { HarnessChat } from '@agentistics/engine-api'
import type { StartHost } from '../cli-start'
import type { CliLang } from '../cli-lang'
import { engine } from '../engine/load'
import {
  adapterChatResponse, pickAdapterChat, readAdapterChat, refuseAdapter, type AdapterChatRow,
} from './adapter-chat'
import { finishChatRead, MAX_TURNS } from './chat-web'
import { acquireChatSlot, onChatWake, releaseChatSlot } from './chat-stream'
import { pendingFor } from './pending-prompts'
import { fleetSessionHub } from './fleet-web'

/** The engine's chat channel for a harness, or `undefined` (no engine, or a declared absence). */
function chatOf(harness: string): HarnessChat | undefined {
  const integrations = engine()?.integrations as Record<string, { chat?: HarnessChat } | undefined> | undefined
  return integrations?.[harness]?.chat
}

async function findRow(host: StartHost, id: string): Promise<AdapterChatRow | null> {
  if (!host.sessions) return null
  const fleet = await host.sessions()
  return (fleet.sessions.find(r => r.id === id) as AdapterChatRow | undefined) ?? null
}

/** `GET /api/fleet/chat-stream` through the engine's channel, or `null` for the legacy stream. */
export async function openAdapterChatStream(
  host: StartHost,
  lang: CliLang,
  id: string,
  signal: AbortSignal,
): Promise<Response | null> {
  const row = await findRow(host, id).catch(() => null)
  const picked = pickAdapterChat(row ?? undefined, true, chatOf)
  if (!row || !picked) return null
  const hub = await fleetSessionHub().catch(() => null)
  if (!hub) return null
  if (!acquireChatSlot()) return null
  const { chat, conversationId } = picked
  const harness = row.harness ?? ''
  return adapterChatResponse({
    id,
    conversationId,
    chat,
    max: MAX_TURNS,
    row: () => findRow(host, id),
    pending: () => pendingFor(conversationId, []).map(p => p.text),
    finish: (read, live) => finishChatRead(id, conversationId, read, live, lang),
    onFleetTick: cb => hub.subscribe(() => cb()),
    onWake: cb => onChatWake(id, cb),
  }, signal, failed => {
    releaseChatSlot()
    if (failed) refuseAdapter(harness, conversationId)
  })
}

/** `GET /api/fleet/chat` through the engine's channel, or `null` for the legacy read. */
export async function readAdapterChatPayload(host: StartHost, lang: CliLang, id: string) {
  const row = await findRow(host, id).catch(() => null)
  const picked = pickAdapterChat(row ?? undefined, true, chatOf)
  if (!row || !picked) return null
  const { chat, conversationId } = picked
  const out = await readAdapterChat({
    conversationId,
    chat,
    row,
    pending: pendingFor(conversationId, []).map(p => p.text),
    max: MAX_TURNS,
    finish: (read, live) => finishChatRead(id, conversationId, read, live, lang),
  })
  if (!out) refuseAdapter(row.harness ?? '', conversationId)
  return out
}
