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
import { featureOn } from '@agentistics/core'
import { engine } from '../engine/load'
import { pendingRewindFor } from './rewind-pending'
import {
  adapterChatResponse, historyOf, pickAdapterChat, readAdapterChat, readAdapterHistory, refuseAdapter,
  sameAdapterSource, searchAdapterHistory,
  type AdapterChatRow, type AdapterSearchAnswer, type AdapterSourceKind,
} from './adapter-chat'
import { anyGrant, scrubDeep } from '../vault/grants'
import { finishChatRead, MAX_TURNS } from './chat-web'
import { acquireChatSlot, onChatStreamsReset, onChatWake, releaseChatSlot } from './chat-stream'
import { pendingFor } from './pending-prompts'
import { fleetSessionHub } from './fleet-web'
import { foreignConversations } from './row-conversation'
import { readRegistry } from './registry'
import { composingOf, onComposing } from './structured-composing'
import { accountRootOf } from './account-transcript-roots'

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
 * Does this session run on a SECOND account's config root? The engine's file channel reads each
 * harness's DEFAULT home only (engine-api 1.x `harnessRoots` names one root per harness and `ChatRef`
 * carries none), so for such a row it finds nothing — a live row then streamed an empty conversation
 * forever while its terminal answered. Those rows are served by the host readers, which look in every
 * account root (`account-transcript-roots.ts`). A structured session is its own source and is unaffected.
 */
async function onAccountRoot(id: string): Promise<boolean> {
  const row = (await readRegistry().catch(() => [])).find(r => r.id === id)
  return (await accountRootOf(row?.accountId).catch(() => null)) !== null
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

/**
 * The conversations the OTHER rows are linked to NOW (CROSSBIND): the hub's snapshot AND the registry
 * as it is at this moment — a row registered after the last poll (a concurrent spawn) is an owner the
 * snapshot cannot know yet (HIGH-4). The registry read is a cached parse per file version.
 */
function foreignOf(hub: SessionHub, id: string, conversationId: string): () => Promise<ReadonlySet<string>> {
  return async () => {
    const snap = hub.last() ?? await hub.read()
    return foreignConversations([...(snap?.sessions ?? []), ...await readRegistry()], id, conversationId)
  }
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
  const structured = row ? await structuredChatOf(id) : undefined
  const picked = structured ?? (await onAccountRoot(id) ? null : pickAdapterChat(row ?? undefined, true, chatOf))
  if (!row || !picked) return null
  if (!acquireChatSlot()) return null
  const { chat, conversationId } = picked
  const harness = row.harness ?? ''
  const opened: AdapterSourceKind = structured ? { structured: true } : { structured: false, conversationId }
  return adapterChatResponse({
    id,
    conversationId,
    chat,
    max: MAX_TURNS,
    row: () => findRow(hub, lang, id),
    pending: () => pendingFor(conversationId, []).map(p => p.text),
    finish: (read, live) => finishChatRead(id, conversationId, read, live, lang, row.id),
    foreign: foreignOf(hub, id, conversationId),
    onFleetTick: cb => hub.subscribe(() => cb()),
    onWake: cb => onChatWake(id, cb),
    onReset: onChatStreamsReset,
    // A structured session turned into a TUI (open in terminal) keeps its row: re-pick on every tick,
    // and let the client reconnect when this channel is no longer the row's (AGY.CHAT.REPLIES).
    current: async () => {
      // The switch was turned off (the global experimental OFF, or the variable): the route would now
      // open the legacy reader, so this stream is no longer the row's.
      if (!featureOn('adapter-chat')) return false
      const r = await findRow(hub, lang, id).catch(() => null)
      if (!r) return true // a row that left is the tick's own close, said in the legacy words
      const s = await structuredChatOf(id)
      const p = s || await onAccountRoot(id) ? null : pickAdapterChat(r, true, chatOf)
      return sameAdapterSource(opened, s ? { structured: true } : p ? { structured: false, conversationId: p.conversationId } : null)
    },
    // Only a structured session's raw stream can say it (the file channel learns a block when it is FINISHED).
    ...(structured ? { composing: { now: () => composingOf(id), on: (cb: (c: 'question' | null) => void) => onComposing(id, cb) } } : {}),
  }, signal, failed => {
    releaseChatSlot()
    if (failed) refuseAdapter(harness, conversationId)
  })
}

/**
 * `GET /api/fleet/chat` through the engine's channel, or `null` for the legacy read.
 *
 * V-READ: a harness whose chat DECLARES history is read by `history()` — the snapshot page, or an older
 * page when `before` (+ `snapshot`) come back from a previous answer. Only its `absent` falls through to
 * the follow-based read below; `ready` (even `[]`), `pending` and `error` are answered as themselves.
 */
export async function readAdapterChatPayload(
  host: StartHost,
  lang: CliLang,
  id: string,
  page: { before?: string; snapshot?: string; signal?: AbortSignal } = {},
) {
  const hub = await fleetSessionHub().catch(() => null)
  if (!hub) return null
  const row = await findRow(hub, lang, id).catch(() => null)
  const picked = (row ? await structuredChatOf(id) : undefined)
    ?? (await onAccountRoot(id) ? null : pickAdapterChat(row ?? undefined, true, chatOf))
  if (!row || !picked) return null
  const { chat, conversationId } = picked
  const common = {
    conversationId,
    chat,
    row,
    pending: pendingFor(conversationId, []).map(p => p.text),
    max: MAX_TURNS,
    finish: (read: { turns: import('@agentistics/core').ChatTurn[]; older: boolean }, live: boolean) =>
      finishChatRead(id, conversationId, read, live, lang, row.id),
    foreign: foreignOf(hub, id, conversationId),
  }
  if (featureOn('chat-history-engine') && historyOf(chat)) {
    const read = await readAdapterHistory({
      ...common, lang,
      ...(page.before ? { before: page.before } : {}),
      ...(page.snapshot ? { snapshot: page.snapshot } : {}),
      ...(page.signal ? { signal: page.signal } : {}),
    })
    if ('payload' in read) return read.payload
    if (read.legacy === 'failed') { refuseAdapter(row.harness ?? '', conversationId); return null }
  }
  const out = await readAdapterChat(common)
  if (!out) refuseAdapter(row.harness ?? '', conversationId)
  return out
}

/**
 * "Buscar na conversa" through the engine's `search()`, or `null` for the host's own search (flag off is
 * the caller's check; here: no row, a second account's root, a harness that does not declare history).
 */
export async function searchAdapterChat(
  lang: CliLang,
  id: string,
  query: string,
  page: { cursor?: string; limit?: number; offset?: number; signal?: AbortSignal } = {},
): Promise<(AdapterSearchAnswer & { harness?: string }) | null> {
  if (!featureOn('adapter-chat') || !featureOn('chat-history-engine')) return null
  const hub = await fleetSessionHub().catch(() => null)
  if (!hub) return null
  const row = await findRow(hub, lang, id).catch(() => null)
  if (!row || !row.harness || await onAccountRoot(id)) return null
  const picked = pickAdapterChat(row, true, chatOf)
  if (!picked || !historyOf(picked.chat)) return null
  const out = await searchAdapterHistory({
    conversationId: picked.conversationId,
    chat: picked.chat,
    ...(row.cwd ? { cwd: row.cwd } : {}),
    query, lang,
    ...(page.cursor ? { cursor: page.cursor } : {}),
    ...(page.limit !== undefined ? { limit: page.limit } : {}),
    ...(page.offset !== undefined ? { offset: page.offset } : {}),
    ...(page.signal ? { signal: page.signal } : {}),
    scrub: async v => (anyGrant() ? scrubDeep(id, v) : v),
    foreign: foreignOf(hub, id, picked.conversationId),
    rewindPending: pendingRewindFor(picked.conversationId, Date.now()) !== null,
  })
  return out ? { ...out, harness: row.harness } : null
}
