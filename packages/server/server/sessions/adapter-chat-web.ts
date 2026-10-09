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
import { cliStrings } from '../cli-i18n'
import { toControlSession } from './control-session'
import type { SessionHub } from './session-hub'
import type { SessionSnapshot } from './sessions-host'
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

/**
 * F2.0 — a STRUCTURED session is its own chat source (the protocol: turns, `live` text, `state`), so
 * it is served from the backend's session before any engine integration or file link is asked.
 */
async function structuredChatOf(id: string): Promise<{ chat: HarnessChat; conversationId: string } | undefined> {
  const { resolveBackend } = await import('./index')
  return (await resolveBackend().catch(() => null))?.chatOf?.(id)
}

/**
 * PURE. One row of the poller's RAW snapshot, mapped by the same `toControlSession` `host.sessions()`
 * uses — for the fields the adapter stream reads (state, link, conversation, cwd). `null` when the
 * snapshot does not hold it (gone, or a native row: those are not the poller's and keep the legacy path).
 */
export function adapterRowOf(snap: SessionSnapshot | null, id: string, lang: CliLang): AdapterChatRow | null {
  const v = snap?.sessions.find(r => r.id === id)
  return v ? (toControlSession(v, cliStrings(lang)) as AdapterChatRow) : null
}

/**
 * The row, from the hub's snapshot — NEVER through `host.sessions()`. This runs on EVERY hub tick for
 * EVERY open adapter stream, and `host.sessions()` maps the WHOLE fleet (every closed row, the
 * baseline, repo facts, the native fleet): with five chats open that was five full fleet builds a tick,
 * on the event loop, and it is what made `/api/fleet` and `/api/data` stall for seconds with the flag on
 * (QA.F1.2 bench N=10 C=5: p95 3.9 s / 5.8 s against 32 / 27 ms off — F1.2b). On a tick the snapshot the
 * tick just produced is `last()`; otherwise the hub's own `read()` (shared, single flight).
 */
async function findRow(hub: SessionHub, lang: CliLang, id: string): Promise<AdapterChatRow | null> {
  const snap = hub.last() ?? await hub.read()
  return adapterRowOf(snap, id, lang)
}

/** `GET /api/fleet/chat-stream` through the engine's channel, or `null` for the legacy stream. */
export async function openAdapterChatStream(
  host: StartHost,
  lang: CliLang,
  id: string,
  signal: AbortSignal,
): Promise<Response | null> {
  const hub = await fleetSessionHub().catch(() => null)
  if (!hub) return null
  const row = await findRow(hub, lang, id).catch(() => null)
  const picked = (row ? await structuredChatOf(id) : undefined) ?? pickAdapterChat(row ?? undefined, true, chatOf)
  if (!row || !picked) return null
  if (!acquireChatSlot()) return null
  const { chat, conversationId } = picked
  const harness = row.harness ?? ''
  return adapterChatResponse({
    id,
    conversationId,
    chat,
    max: MAX_TURNS,
    row: () => findRow(hub, lang, id),
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
  const hub = await fleetSessionHub().catch(() => null)
  if (!hub) return null
  const row = await findRow(hub, lang, id).catch(() => null)
  const picked = (row ? await structuredChatOf(id) : undefined) ?? pickAdapterChat(row ?? undefined, true, chatOf)
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
