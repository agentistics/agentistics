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
import {
  applyHarnessChatDeltas, chatHasHistory,
  type ChatHistoryPage, type ChatSearchPage, type ChatSourceRef, type ChatUnavailable,
  type HarnessChat, type HarnessChatDelta, type HarnessChatHistory,
} from '@agentistics/engine-api'
import {
  chatDelta, excerptAround, findMatches, foldQuery,
  type ChatSearchHit, type ChatSearchPage as HostSearchPage, type ChatTurn, type SessionConversationLink,
} from '@agentistics/core'
import type { CliLang } from '../cli-lang'
import type { ChatHistoryMeta, ChatPayload } from './chat-web'
import { conversationOfRow } from './row-conversation'
import { isExternalRowId } from './external-continue'
import { RefusalLog } from './refusal-log'

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
  /**
   * What the session is FORMULATING (a structured session's raw stream, `structured-composing.ts`):
   * the current value, then every change. Absent = this source cannot say (the event is never sent).
   */
  composing?: { now(): 'question' | null; on(cb: (c: 'question' | null) => void): () => void }
  /**
   * Is this channel STILL the one the row would be served from? Asked on every fleet tick; `false`
   * closes the stream (not as a failure) so the client reconnects to whatever the row reads from now.
   * A structured session turned into a TUI (`attach` = open in terminal) keeps its row and its
   * conversation, but its structured channel is dead: following it froze the chat on the person's own
   * message while the TUI answered (AGY.CHAT.REPLIES, 2026-10-10). Absent = never re-asked.
   */
  current?: () => Promise<boolean>
  /** The chat-source switch moved (`resetChatStreams`): close (not as a failure) and let the client
   *  reconnect to whatever reader the switch names now. Absent = never told. */
  onReset?: (cb: () => void) => () => void
  /**
   * The conversations OTHER rows are linked to (CROSSBIND). A source the engine resolves or forks to
   * that names one of them is another session's chat: the stream closes as a failure and the legacy
   * reader — which never follows into one (`transcript-fork.ts`) — serves instead. Absent = not asked.
   */
  foreign?: () => Promise<ReadonlySet<string>>
  setTimer?: (f: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

/**
 * PURE (CROSSBIND). Does this source belong to ANOTHER row? Its stated conversation, or the file it
 * names (a Claude transcript is `<conversationId>.jsonl`), is one another row is linked to — and it is
 * not the conversation this stream was opened for. The engine's fork-follow judges a sibling file by
 * its content (shared uuids, a pending prompt), and two sessions in one folder can share both.
 */
export function sourceForeign(src: ChatSourceRef, own: string, foreign: ReadonlySet<string>): boolean {
  const file = src.sourceRef.split(/[\\/]/).pop()?.replace(/\.jsonl$/, '') ?? ''
  for (const c of [src.conversationId, file]) if (c && c !== own && foreign.has(c)) return true
  return false
}

/** The warning, said once per pair, when a source is refused for belonging to another row. */
const refusedForeign = new RefusalLog()
export function logForeign(own: string, src: ChatSourceRef): void {
  refusedForeign.warn(`${own}\0${src.conversationId}\0${src.sourceRef}`, `[sessions] refused the chat source ${src.sourceRef} for ${own}: another session is linked to that conversation`)
}

/** Which channel a stream follows: a structured session's own, or the engine's file channel for a conversation. */
export type AdapterSourceKind = { structured: true } | { structured: false; conversationId: string }

/**
 * PURE (AGY.CHAT.REPLIES). Is the channel a stream opened on still the one the row would be served
 * from? `now === null` = the row would take the legacy path now. A structured channel stays current
 * while the session is structured — its conversation id may move from the managed id to the one the
 * harness states, which is the same channel; a file channel stays current for the same conversation.
 */
export function sameAdapterSource(opened: AdapterSourceKind, now: AdapterSourceKind | null): boolean {
  if (!now) return false
  if (opened.structured || now.structured) return opened.structured === now.structured
  return opened.conversationId === now.conversationId
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
  // CROSSBIND — every source the stream follows has a GENERATION (`gen`, bumped by each adoption: the
  // initial resolve and every fork). `approved` is the newest generation whose ownership check passed.
  // Frames are held per generation and nothing is emitted unless the held frames, the followed source
  // and the approval are the SAME generation — re-checked after every await, so a check that settles
  // for an older fork can never release a newer fork's frames (HIGH-2).
  let held: { turns: ChatTurn[]; older: boolean; gen: number } = { turns: [], older: false, gen: 0 }
  let gen = 0
  let approved = 0
  let heldLive: { gen: number; data: string } | null = null
  let heldState: { gen: number; data: string } | null = null
  let sentTurns: string[] | null = null
  let sentMeta = ''
  let live = false
  let link: SessionConversationLink | null | undefined
  let src: ChatSourceRef | null = null
  let unfollow: (() => void) | null = null
  let cwd: string | undefined
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
    // A STOPPED row with no source is either still resolving or about to hand over to the legacy
    // reader: an empty frame now would read as "this conversation is empty" (MED-2). Nothing is sent.
    if (!src && !live) return
    // A source whose ownership check has not passed yet emits nothing; its approval schedules.
    if (src && approved !== gen) return
    if (emitting) { emitAgain = true; return }
    emitting = true
    try {
      const g = gen
      const frame = held.gen === g ? held : { turns: [], older: false }
      const p = adapterPayload(await deps.finish({ turns: [...frame.turns], older: frame.older }, live), link)
      if (closed) return
      // The source moved while the payload was built: these frames are not the current source's.
      if (g !== gen || approved !== gen) return
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
      case 'window': case 'append': case 'grow': {
        const base = held.gen === gen ? held : { turns: [], older: false }
        held = { ...applyHarnessChatDeltas(base, [d], deps.max), gen }
        schedule()
        return
      }
      case 'live': {
        const data = JSON.stringify({ text: d.text, ...(d.reasoning !== undefined ? { reasoning: d.reasoning } : {}) })
        if (approved === gen) send('live', data); else heldLive = { gen, data }
        return
      }
      case 'state': {
        const data = JSON.stringify({ working: d.working, ...(d.attention ? { attention: d.attention } : {}) })
        if (approved === gen) send('state', data); else heldState = { gen, data }
        return
      }
      case 'fork':
        // The engine follows the new source itself and a `window` of it follows — none of which is
        // emitted until the new source is shown not to be another row's conversation (CROSSBIND).
        adopt(d.to, true)
        return
    }
  }

  /** Follow `to` as a new generation; with `check`, nothing of it is emitted until its owner check passes. */
  function adopt(to: ChatSourceRef, check: boolean) {
    const g = ++gen
    src = to
    heldLive = null
    heldState = null
    if (!check || !deps.foreign) { approve(g); return }
    void verify(to, g)
  }

  /** Is `to` (generation `g`) another row's? Close as a failure if so; approve it if still current. */
  async function verify(to: ChatSourceRef, g: number): Promise<void> {
    let owners: ReadonlySet<string>
    try { owners = await deps.foreign!() } catch { close(true); return }
    if (closed) return
    if (sourceForeign(to, deps.conversationId, owners)) { logForeign(deps.conversationId, to); close(true); return }
    if (g === gen) approve(g)
  }

  function approve(g: number) {
    if (closed || g !== gen || approved === g) return
    approved = g
    if (heldLive?.gen === g) send('live', heldLive.data)
    if (heldState?.gen === g) send('state', heldState.data)
    heldLive = null
    heldState = null
    schedule()
  }

  // ONE resolution in flight, and every caller waits for IT: startup used to find `resolving` set by
  // the tick it had just run, return at once and schedule the first frame — so a stopped row whose
  // resolve was slower than the debounce got an empty SUCCESSFUL frame before its legacy hand-over.
  let resolution: Promise<void> | null = null
  function resolveAndFollow(): Promise<void> {
    if (closed || src) return Promise.resolve()
    if (resolution) return resolution
    resolution = (async () => {
      try {
        const found = await deps.chat.resolve({
          conversationId: deps.conversationId,
          ...(cwd ? { cwd } : {}),
          pending: deps.pending(),
        })
        if (closed) return
        if (!found) {
          // Stopped row, transcript unresolvable: hand over to the legacy stream and its diagnosis.
          if (!live) { close(true); return }
          schedule(); return // live, nothing written yet: the empty conversation, retried on ticks
        }
        if (deps.foreign && sourceForeign(found, deps.conversationId, await deps.foreign())) {
          logForeign(deps.conversationId, found)
          close(true); return
        }
        if (closed) return
        adopt(found, false) // checked just above, against the owners of this moment
        unfollow = deps.chat.follow(found, deps.max, onDelta)
      } catch {
        close(true)
      }
    })().finally(() => { resolution = null })
    return resolution
  }

  async function onTick(): Promise<void> {
    if (closed) return
    try {
      const row = await deps.row()
      if (closed) return
      if (!row) { close(false); return } // gone: the legacy stream says so in its own words
      if (deps.current && !(await deps.current())) { if (!closed) close(false); return }
      if (closed) return
      cwd = row.cwd || cwd
      link = row.link
      const nowLive = rowLive(row)
      if (nowLive !== live) { live = nowLive; schedule() }
      if (!src) { void resolveAndFollow(); return }
      // Ownership can change under the followed source — a row registered after it was adopted (its
      // check could only see the owners of that moment). Re-asked on every tick: a source another row
      // now owns closes the stream and the legacy reader serves (HIGH-4).
      if (deps.foreign && approved === gen) await verify(src, gen)
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
      if (deps.onReset) offs.push(deps.onReset(() => close(false)))
      if (deps.composing) {
        const say = (c: 'question' | null) => send('composing', JSON.stringify({ what: c }))
        if (deps.composing.now()) say(deps.composing.now())
        offs.push(deps.composing.on(say))
      }
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
  /** See `AdapterChatDeps.foreign`: a source owned by another row is refused (`null`, legacy serves). */
  foreign?: () => Promise<ReadonlySet<string>>
}): Promise<ChatPayload | null> {
  try {
    const live = rowLive(o.row)
    const src = await o.chat.resolve({
      conversationId: o.conversationId,
      ...(o.row.cwd ? { cwd: o.row.cwd } : {}),
      pending: o.pending,
    })
    // A live row that has not written yet is an empty conversation; a STOPPED row whose transcript
    // cannot be resolved is gone, and the legacy reader owns that diagnosis (retention, missing file).
    if (!src) return live ? adapterPayload(await o.finish({ turns: [], older: false }, live), o.row.link) : null
    // Every source this read adopts — the resolved one, and any the follower forks to before its first
    // window — is checked against the CURRENT owners; a foreign one makes the read `null` (MED-1).
    const allowed = async (to: ChatSourceRef): Promise<boolean> => {
      if (!o.foreign) return true
      if (!sourceForeign(to, o.conversationId, await o.foreign())) return true
      logForeign(o.conversationId, to)
      return false
    }
    if (!await allowed(src)) return null
    const window = await firstWindow(o.chat, src, o.max, o.timeoutMs, allowed)
    if (!window) return null
    return adapterPayload(await o.finish(window, live), o.row.link)
  } catch {
    return null
  }
}

/**
 * Follow a source until its first `window`, then stop following: one read of the last `max` turns.
 * `null` when no window arrived within `timeoutMs` (the channel could not answer in time).
 */
export function firstWindow(
  chat: HarnessChat,
  src: ChatSourceRef,
  max: number,
  timeoutMs: number = ADAPTER_FIRST_WINDOW_MS,
  /** Asked of every source a `fork` moves to before the window arrives; `false` makes the read `null`. */
  forkAllowed?: (to: ChatSourceRef) => Promise<boolean>,
): Promise<{ turns: ChatTurn[]; older: boolean } | null> {
  return new Promise(resolve => {
    let done = false
    let unfollow: (() => void) | null = null
    const finish = (v: { turns: ChatTurn[]; older: boolean } | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      // `follow` may deliver the window synchronously, before it has returned its unsubscribe: the
      // microtask runs after `unfollow` is assigned, so it is the ONE release on either path.
      queueMicrotask(() => { try { unfollow?.() } catch { /* total by contract */ } })
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    // Every fork so far, checked in order: a window is taken only once the checks of every source that
    // led to it have passed, so a window of a foreign source is never returned.
    let gate: Promise<boolean> = Promise.resolve(true)
    unfollow = chat.follow(src, max, d => {
      if (done) return
      if (d.kind === 'fork') {
        const to = d.to
        gate = gate.then(ok => ok && (forkAllowed ? forkAllowed(to).catch(() => false) : true))
        return
      }
      if (d.kind !== 'window') return
      const w = applyHarnessChatDeltas({ turns: [], older: false }, [d], max)
      void gate.then(ok => finish(ok ? w : null))
    })
  })
}

// ─── V-READ: history and search through the engine's 1.22 contract ────────────────────────────────

/** How long one `history()` / `search()` call may take before its signal aborts it (the engine answers `timeout`/`cancelled`). */
export const ADAPTER_HISTORY_TIMEOUT_MS = 10_000
/** How long one `search()` call may scan before it answers what it has with `complete: false`. */
export const ADAPTER_SEARCH_BUDGET_MS = 4_000

/**
 * PURE. The chat's history members when this harness DECLARES them (`declares.history.from`) and has
 * them; `null` for a 1.21 engine, a declared absence, or a half-implemented entry — the host's own
 * readers serve those.
 */
export function historyOf(chat: HarnessChat): (HarnessChat & HarnessChatHistory) | null {
  if (chat.declares.history?.from === undefined) return null
  return chatHasHistory(chat) ? chat : null
}

type Say = Record<CliLang, string>
const say = (m: Say, lang: CliLang): string => m[lang] ?? m.en

/** The sentence for a source that is not readable: never an empty list, always a reason a person reads. */
export function historySentence(u: ChatUnavailable, lang: CliLang): string {
  if (u.status === 'pending') {
    return say({
      en: 'This conversation is not ready yet — the harness writes its history when the first message is sent. Try again in a moment.',
      pt: 'Esta conversa ainda não está pronta — o histórico só é gravado quando a primeira mensagem é enviada. Tente de novo em instantes.',
    } as Say, lang)
  }
  if (u.status === 'absent') {
    return say({ en: 'There is no history for this conversation.', pt: 'Não há histórico para esta conversa.' } as Say, lang)
  }
  switch (u.code) {
    case 'epoch-changed': case 'bad-cursor': case 'foreign':
      return say({
        en: 'The conversation changed while you were reading it (rewound or rewritten) — reloading from the start.',
        pt: 'A conversa mudou enquanto você lia (voltou no tempo ou foi reescrita) — recarregando desde o início.',
      } as Say, lang)
    case 'timeout': case 'cancelled':
      return say({
        en: 'Reading the history took too long. Try again.',
        pt: 'Ler o histórico demorou demais. Tente de novo.',
      } as Say, lang)
    case 'unknown-account':
      return say({
        en: 'The account this conversation belongs to is not available here.',
        pt: 'A conta a que esta conversa pertence não está disponível aqui.',
      } as Say, lang)
    case 'bad-query':
      return say({ en: 'Type something to search for.', pt: 'Digite algo para buscar.' } as Say, lang)
    default:
      return say({
        en: 'The history could not be read right now. Try again in a moment.',
        pt: 'Não foi possível ler o histórico agora. Tente de novo em instantes.',
      } as Say, lang)
  }
}

const RESNAPSHOT_CODES = new Set(['epoch-changed', 'bad-cursor', 'foreign'])

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const t = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, t]) : t
}

/** What a history read decided: a payload to serve, or the legacy flow (`absent`, or the call threw). */
export type AdapterHistoryRead = { payload: ChatPayload } | { legacy: 'absent' | 'failed' }

/**
 * M01/M07/M11 — one read of the conversation's PAGE from `history()`, for harnesses that declare it.
 *
 * - `ready` is served as it is — `ready([])` is a conversation with nothing in it, and NO other reader is asked.
 * - `pending` / `error` are served as a sentence + `history.status`, never as `[]`.
 * - `absent` → `{ legacy: 'absent' }`: the caller continues with the flow it had before this existed.
 * - A call that throws breaks the contract: `{ legacy: 'failed' }` (the caller refuses the conversation).
 * - An older page asked with a cursor of another epoch / conversation → `history.resnapshot`, with no turns.
 */
export async function readAdapterHistory(o: {
  conversationId: string
  chat: HarnessChat
  row: AdapterChatRow
  pending: string[]
  max: number
  lang: CliLang
  before?: string
  snapshot?: string
  signal?: AbortSignal
  timeoutMs?: number
  finish(read: { turns: ChatTurn[]; older: boolean }, live: boolean): Promise<ChatPayload>
  foreign?: () => Promise<ReadonlySet<string>>
}): Promise<AdapterHistoryRead> {
  const h = historyOf(o.chat)
  if (!h) return { legacy: 'absent' }
  const live = rowLive(o.row)
  const ref = { conversationId: o.conversationId, ...(o.row.cwd ? { cwd: o.row.cwd } : {}), pending: o.pending }
  try {
    if (o.foreign) {
      // CROSSBIND: the source the engine resolves must not be another row's.
      const src = await o.chat.resolve(ref)
      if (src && sourceForeign(src, o.conversationId, await o.foreign())) {
        logForeign(o.conversationId, src)
        return { legacy: 'failed' }
      }
    }
    const res: ChatHistoryPage | ChatUnavailable = await h.history(ref, {
      limit: o.max,
      ...(o.before ? { before: o.before } : {}),
      ...(o.snapshot ? { snapshot: o.snapshot } : {}),
      signal: withTimeout(o.signal, o.timeoutMs ?? ADAPTER_HISTORY_TIMEOUT_MS),
    })
    if (res.status === 'absent') return { legacy: 'absent' }
    const link = o.row.link
    if (res.status === 'ready') {
      const meta: ChatHistoryMeta = {
        status: 'ready', start: res.start, total: res.total, before: res.before, snapshot: res.snapshot, epoch: res.sourceEpoch,
      }
      // The window notice belongs to the newest page only ("the last N turns"); an older page is not the end.
      const older = !o.before && !o.snapshot && res.before !== null
      const p = adapterPayload(await o.finish({ turns: res.turns as ChatTurn[], older }, live), link)
      return { payload: { ...p, history: meta } }
    }
    const base = adapterPayload(await o.finish({ turns: [], older: false }, live), link)
    if (res.status === 'pending') {
      return { payload: {
        ...base,
        unavailable: historySentence(res, o.lang),
        transcript: { state: 'not-yet-written', reason: 'live-no-file-yet' },
        history: { status: 'pending', retryAfterMs: res.retryAfterMs },
      } }
    }
    const resnapshot = RESNAPSHOT_CODES.has(res.code) && !!(o.before || o.snapshot)
    return { payload: {
      ...base,
      unavailable: historySentence(res, o.lang),
      transcript: { state: 'unreadable', reason: 'read-failed' },
      history: { status: 'error', code: res.code, retryable: res.retryable, ...(resnapshot ? { resnapshot: true as const } : {}) },
    } }
  } catch {
    return { legacy: 'failed' }
  }
}

/** The answer of "Buscar na conversa" through the engine (a superset of the host's page — see `chat-search-web.ts`). */
export interface AdapterSearchAnswer extends HostSearchPage {
  /** False = the scan stopped short: "no results" must never be said, and `cursor` continues it. */
  complete: boolean
  stopped?: 'limit' | 'budget' | 'cancelled'
  cursor?: string | null
  /** Already-localized: why nothing could be searched. */
  unavailable?: string
}

/** PURE. An engine hit as the host's page shape: the snippet is all the engine sends of the message. */
export function hostHitOf(h: ChatSearchPage['hits'][number], query: string): ChatSearchHit {
  const spans = findMatches(h.snippet, foldQuery(query))
  const { excerpt, highlights } = excerptAround(h.snippet, spans)
  return {
    index: h.index, role: h.role, ...(h.at ? { at: h.at } : {}), text: h.snippet,
    excerpt, highlights, matches: Math.max(1, spans.length),
  }
}

/**
 * M09 — "Buscar na conversa" from the engine's `search()`, for harnesses that declare it; `null` = the
 * host's own whole-transcript search serves (undeclared, or the source is `absent`). It never says
 * "no results" for a scan that did not finish: `complete` is the engine's word, passed through, and a
 * pending/error source is a sentence with `complete: false`.
 */
export async function searchAdapterHistory(o: {
  conversationId: string
  chat: HarnessChat
  cwd?: string
  query: string
  cursor?: string
  limit?: number
  offset?: number
  lang: CliLang
  signal?: AbortSignal
  budgetMs?: number
  timeoutMs?: number
  /** The vault scrub the chat applies to its turns (a granted secret must not surface in a snippet). */
  scrub?: <T>(v: T) => Promise<T>
}): Promise<AdapterSearchAnswer | null> {
  const h = historyOf(o.chat)
  if (!h) return null
  const empty = { query: o.query, total: 0, offset: o.offset ?? 0, hits: [] as ChatSearchHit[], scanned: 0 }
  try {
    const res = await h.search(
      { conversationId: o.conversationId, ...(o.cwd ? { cwd: o.cwd } : {}) },
      {
        query: o.query,
        ...(o.cursor ? { cursor: o.cursor } : {}),
        ...(o.limit !== undefined ? { limit: o.limit } : {}),
        budgetMs: o.budgetMs ?? ADAPTER_SEARCH_BUDGET_MS,
        signal: withTimeout(o.signal, o.timeoutMs ?? ADAPTER_HISTORY_TIMEOUT_MS),
      },
    )
    if (res.status === 'absent') return null
    if (res.status !== 'ready') return { ...empty, complete: false, unavailable: historySentence(res, o.lang) }
    const hits = res.hits.map(hit => hostHitOf(hit, o.query))
    const shown = o.scrub ? await o.scrub(hits) : hits
    return {
      ...empty, total: shown.length, hits: shown, scanned: res.scanned,
      complete: res.complete, ...(res.stopped ? { stopped: res.stopped } : {}), cursor: res.cursor,
    }
  } catch {
    return null
  }
}
