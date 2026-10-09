/**
 * adapter-chat.ts — a session's conversation served from the ENGINE's chat channel (engine-api 1.9
 * `HarnessChat`, ENGINE.MAP 09 §3–§4), behind the `adapter-chat` experimental flag.
 *
 * The seam is harness-agnostic: nothing here names a harness. A harness takes this path when, and only
 * when, its engine integration serves `chat` — every other one (and every harness on a community build,
 * and every harness with the flag off) keeps the host's own readers, byte for byte.
 *
 * - **The same events as the legacy stream** (`chat-stream.ts`): `chat` (the whole payload) once, then
 *   `chat-delta` (core's positional `chatDelta`) whenever the turns or the payload's other fields change,
 *   plus two ADDITIVE ones: `live` (in-flight text, replaced by each one) and `state` (working / waiting
 *   on a person). The payload carries `source: 'adapter'`.
 * - **The same payload rules.** Turns from the channel go through `finishChatRead` — the context fence,
 *   a pending rewind, the composer marks, the pending echoes, the attachments log, the vault scrub, the
 *   window notice — exactly as turns from a legacy reader do.
 * - **No polling of its own.** The engine follows the source (one cursor, shared); the row's state is
 *   re-read on the SessionHub's ticks; a send wakes the stream (`onChatWake`). A source that does not
 *   exist yet is retried on the ticks too — never a 1 s loop.
 * - **An error CLOSES the stream** and remembers the conversation as refused for `ADAPTER_REFUSAL_MS`,
 *   so the client's reconnect lands on the legacy stream instead of failing the same way again.
 */
import { applyHarnessChatDeltas, type ChatSourceRef, type HarnessChat, type HarnessChatDelta } from '@agentistics/engine-api'
import { chatDelta, type ChatTurn, type SessionConversationLink } from '@agentistics/core'
import type { ChatPayload } from './chat-web'
import { conversationOfRow } from './row-conversation'
import { isExternalRowId } from './external-continue'

/** How long a conversation whose channel failed is served by the legacy readers instead. */
export const ADAPTER_REFUSAL_MS = 5 * 60_000
/** How long a one-shot read waits for the channel's first window before falling back. */
export const ADAPTER_FIRST_WINDOW_MS = 3_000
export const ADAPTER_DEBOUNCE_MS = 25
export const ADAPTER_KEEPALIVE_MS = 15_000

/** The slice of a fleet row this module reads. */
export interface AdapterChatRow {
  id: string
  harness?: string
  cwd?: string
  state: string
  conversationId?: string
  link?: SessionConversationLink | null
}

const refused = new Map<string, number>()
const refusalKey = (harness: string, conversationId: string) => `${harness}\0${conversationId}`

/** Remember that this conversation's channel failed: its next reads go to the legacy readers. */
export function refuseAdapter(harness: string, conversationId: string, nowMs: number = Date.now()): void {
  refused.set(refusalKey(harness, conversationId), nowMs + ADAPTER_REFUSAL_MS)
  if (refused.size > 256) {
    for (const [k, until] of refused) if (until <= nowMs) refused.delete(k)
  }
}

export function adapterRefused(harness: string, conversationId: string, nowMs: number = Date.now()): boolean {
  const until = refused.get(refusalKey(harness, conversationId))
  if (until === undefined) return false
  if (until <= nowMs) { refused.delete(refusalKey(harness, conversationId)); return false }
  return true
}

/** Test seam. */
export function clearAdapterRefusals(): void { refused.clear() }

/**
 * PURE. Whether a row is served by the channel, and with which conversation — `null` keeps the legacy
 * readers. The flag and the engine's integration are the caller's (`flagOn`, `chatOf`), so this
 * decision has no environment of its own to read.
 */
export function pickAdapterChat(
  row: AdapterChatRow | undefined,
  flagOn: boolean,
  chatOf: (harness: string) => HarnessChat | undefined,
  nowMs: number = Date.now(),
): { chat: HarnessChat; conversationId: string } | null {
  if (!flagOn || !row || !row.harness) return null
  const chat = chatOf(row.harness)
  if (!chat) return null
  // The EXACT link or nothing — the same rule the legacy readers keep (`chat-web.ts`): an unlinked row
  // stays on the legacy path, which knows how to say why there is nothing to read yet.
  const conversationId = conversationOfRow(row)
  if (!conversationId) return null
  if (adapterRefused(row.harness, conversationId, nowMs)) return null
  return { chat, conversationId }
}

/** PURE. Is this row's session running (the legacy reader's own `live` rule). */
export function rowLive(row: Pick<AdapterChatRow, 'id' | 'state'>): boolean {
  return row.state === 'working' || row.state === 'waiting' || row.state === 'waiting-approval'
    || (row.state === 'unknown' && isExternalRowId(row.id))
}

export interface AdapterChatDeps {
  id: string
  conversationId: string
  chat: HarnessChat
  /** The row as the fleet holds it NOW (the SessionHub's snapshot), or `null` when it is gone. */
  row(): Promise<AdapterChatRow | null>
  /** What has been sent and is not echoed yet — the fork-ownership proof `resolve` takes. */
  pending(): string[]
  /** The legacy post-processing (`finishChatRead`). */
  finish(read: { turns: ChatTurn[]; older: boolean }, live: boolean): Promise<ChatPayload>
  /** The window size asked of the channel. */
  max: number
  /** Every completed fleet poll. */
  onFleetTick(cb: () => void): () => void
  /** A send / an answer for this session. */
  onWake(cb: () => void): () => void
  setTimer?: (f: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

/** PURE. The payload's canonical facts, the way `readSessionChat` adds them on the legacy path. */
export function adapterPayload(base: ChatPayload, link: SessionConversationLink | null | undefined): ChatPayload {
  const transcript = base.transcript
    ?? (base.unavailable === undefined && base.turns.length > 0 ? { state: 'present' as const, reason: 'resolved' as const } : undefined)
  return {
    ...base,
    ...(transcript ? { transcript } : {}),
    ...(link !== undefined ? { link } : {}),
    source: 'adapter',
  }
}

/**
 * The adapter stream. `onClose(failed)` is told whether it ended on an error (the caller then refuses
 * the conversation for a while) — the response itself always just ends, and the client reconnects.
 */
export function adapterChatResponse(
  deps: AdapterChatDeps,
  signal: AbortSignal,
  onClose: (failed: boolean) => void,
): Response {
  const setTimer = deps.setTimer ?? ((f, ms) => setTimeout(f, ms))
  const clearTimer = deps.clearTimer ?? (t => clearTimeout(t as ReturnType<typeof setTimeout>))
  const enc = new TextEncoder()
  let closed = false
  let held: { turns: ChatTurn[]; older: boolean } = { turns: [], older: false }
  let sentTurns: string[] | null = null
  let sentMeta = ''
  let live = false
  let link: SessionConversationLink | null | undefined
  let src: ChatSourceRef | null = null
  let unfollow: (() => void) | null = null
  let cwd: string | undefined
  let resolving = false
  let emitting = false
  let emitAgain = false
  let debounce: unknown = null
  let keepalive: unknown = null
  const offs: Array<() => void> = []
  let ctl!: ReadableStreamDefaultController<Uint8Array>

  const send = (event: string, data: string) => {
    if (closed) return
    try { ctl.enqueue(enc.encode(`event: ${event}\ndata: ${data}\n\n`)) } catch { close(false) }
  }

  function close(failed: boolean) {
    if (closed) return
    closed = true
    try { unfollow?.() } catch { /* the engine's unsubscribe is total by contract */ }
    for (const off of offs) off()
    for (const t of [debounce, keepalive]) if (t !== null) clearTimer(t)
    try { ctl.close() } catch { /* already */ }
    onClose(failed)
  }

  async function emit(): Promise<void> {
    if (closed) return
    if (emitting) { emitAgain = true; return }
    emitting = true
    try {
      const p = adapterPayload(await deps.finish({ turns: [...held.turns], older: held.older }, live), link)
      if (closed) return
      const { turns, ...meta } = p
      const metaJson = JSON.stringify(meta)
      const d = chatDelta(sentTurns, turns)
      if (d.kind === 'same' && metaJson === sentMeta) return
      if (d.kind === 'full') send('chat', JSON.stringify(p))
      else send('chat-delta', JSON.stringify({ ...(d.kind === 'delta' ? { drop: d.drop, keep: d.keep, append: d.append } : { drop: 0, keep: turns.length, append: [] }), meta }))
      sentTurns = turns.map(t => JSON.stringify(t))
      sentMeta = metaJson
    } catch {
      close(true)
    } finally {
      emitting = false
      if (emitAgain && !closed) { emitAgain = false; void emit() }
    }
  }

  function schedule() {
    if (closed || debounce !== null) return
    debounce = setTimer(() => { debounce = null; void emit() }, ADAPTER_DEBOUNCE_MS)
  }

  function onDelta(d: HarnessChatDelta) {
    if (closed) return
    switch (d.kind) {
      case 'window': case 'append': case 'grow':
        held = applyHarnessChatDeltas(held, [d], deps.max)
        schedule()
        return
      case 'live':
        send('live', JSON.stringify({ text: d.text, ...(d.reasoning !== undefined ? { reasoning: d.reasoning } : {}) }))
        return
      case 'state':
        send('state', JSON.stringify({ working: d.working, ...(d.attention ? { attention: d.attention } : {}) }))
        return
      case 'fork':
        // The engine follows the new source itself and a `window` of it follows; only the ref moves.
        src = d.to
        return
    }
  }

  async function resolveAndFollow(): Promise<void> {
    if (closed || src || resolving) return
    resolving = true
    try {
      const found = await deps.chat.resolve({
        conversationId: deps.conversationId,
        ...(cwd ? { cwd } : {}),
        pending: deps.pending(),
      })
      if (closed) return
      if (!found) { schedule(); return } // nothing written yet: the empty conversation, retried on ticks
      src = found
      unfollow = deps.chat.follow(found, deps.max, onDelta)
    } catch {
      close(true)
    } finally {
      resolving = false
    }
  }

  async function onTick(): Promise<void> {
    if (closed) return
    try {
      const row = await deps.row()
      if (closed) return
      if (!row) { close(false); return } // gone: the legacy stream says so in its own words
      cwd = row.cwd || cwd
      link = row.link
      const nowLive = rowLive(row)
      if (nowLive !== live) { live = nowLive; schedule() }
      if (!src) void resolveAndFollow()
    } catch {
      close(true)
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c
      ctl.enqueue(enc.encode('retry: 2000\n\n'))
      const ping = () => { send('ping', String(Date.now())); keepalive = setTimer(ping, ADAPTER_KEEPALIVE_MS) }
      keepalive = setTimer(ping, ADAPTER_KEEPALIVE_MS)
      offs.push(deps.onFleetTick(() => { void onTick() }))
      offs.push(deps.onWake(() => schedule()))
      void (async () => {
        await onTick()
        if (closed) return
        await resolveAndFollow()
        // The first frame goes out even when the channel has nothing yet: an empty conversation with
        // its pending echoes is an answer, and the client must not wait a tick for it.
        if (!closed && sentTurns === null) schedule()
      })()
    },
    cancel() { close(false) },
  })
  signal.addEventListener('abort', () => close(false), { once: true })
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' },
  })
}

/**
 * One read through the channel (`GET /api/fleet/chat`): resolve, follow until the first `window`, stop
 * following. `null` = the channel could not answer in time or failed — the caller serves the legacy
 * read instead (and refuses the conversation for a while).
 */
export async function readAdapterChat(o: {
  conversationId: string
  chat: HarnessChat
  row: AdapterChatRow
  pending: string[]
  max: number
  finish(read: { turns: ChatTurn[]; older: boolean }, live: boolean): Promise<ChatPayload>
  timeoutMs?: number
}): Promise<ChatPayload | null> {
  try {
    const live = rowLive(o.row)
    const src = await o.chat.resolve({
      conversationId: o.conversationId,
      ...(o.row.cwd ? { cwd: o.row.cwd } : {}),
      pending: o.pending,
    })
    if (!src) return adapterPayload(await o.finish({ turns: [], older: false }, live), o.row.link)
    const window = await new Promise<{ turns: ChatTurn[]; older: boolean } | null>(resolve => {
      let done = false
      let unfollow: (() => void) | null = null
      const finish = (v: { turns: ChatTurn[]; older: boolean } | null) => {
        if (done) return
        done = true
        clearTimeout(timer)
        // `follow` may deliver the window synchronously, before it has returned its unsubscribe.
        queueMicrotask(() => { try { unfollow?.() } catch { /* total by contract */ } })
        resolve(v)
      }
      const timer = setTimeout(() => finish(null), o.timeoutMs ?? ADAPTER_FIRST_WINDOW_MS)
      unfollow = o.chat.follow(src, o.max, d => {
        if (d.kind === 'window') finish(applyHarnessChatDeltas({ turns: [], older: false }, [d], o.max))
      })
      if (done) { try { unfollow() } catch { /* total */ } }
    })
    if (!window) return null
    return adapterPayload(await o.finish(window, live), o.row.link)
  } catch {
    return null
  }
}
