/**
 * nativeChat.ts — PURE: a native Agentistics session's conversation, from what the engine serves
 * (UI.3). No fetch, no EventSource, no React — `useNativeSession` owns those and feeds this.
 *
 * Two sources, one view:
 *
 * - **The window** (`GET /api/runtime/sessions/:id/messages`): the persisted conversation — the
 *   person's messages, the model's text and tool calls, each tool result — plus the latest run
 *   (`latestRun`: its id, status and each call's `toolExecutionId ↔ toolUseId`). Authoritative for
 *   everything already on disk.
 * - **The live frames** (`GET …/stream`, SSE): canonical events (`run.*`, `model.*`, `tool.*`,
 *   `policy.*`), text deltas and the policy's questions. They carry no content beyond the streamed
 *   text (events are facts, never conversation), so they drive STATE — running or not, which call is
 *   running, awaiting approval, denied — and the text being written right now.
 *
 * Rules, each a test:
 *
 * - A tool call is ONE card: its `tool_use` (name, input) and its `tool_result` (output) from the
 *   window, its live status from the events through the `toolExecutionId ↔ toolUseId` map. A call the
 *   window has not caught up with yet is a card from its events alone.
 * - Streamed text is shown until the window carries the message it became — never both.
 * - A message the person sent shows at once (pending) and is not doubled when the window has it.
 * - An open question sits on the card of the call it is about (its id starts with the call's
 *   `toolExecutionId`); a question about no call is an approval item of its own.
 * - Frames are applied once, in `seq` order: a reconnect that replays is harmless.
 * - Untrusted input (`parseNativeFrame`) never throws.
 */

import type { ChatTurn } from '../components/sessions/ChatBubble'

// ── what the engine serves (structural, minimal — the web never imports the runtime) ─────────────

export type NativePart =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }

export interface NativeMessage {
  role: 'user' | 'assistant'
  content: string | NativePart[]
}

export interface NativeToolCallRef {
  toolExecutionId: string
  toolUseId: string
  name: string
  state: 'started' | 'settled'
  isError?: boolean
}

export interface NativeWindow {
  session: { sessionId: string; model: string; provider: string; status: string; title?: string; cwd?: string; credential?: { provider: string; id: string } }
  messages: { seq: number; message: NativeMessage }[]
  nextBefore?: number
  latestRun?: { runId: string; status: string; toolCalls: NativeToolCallRef[] }
}

export interface NativeQuestion {
  id: string
  kind: 'permission' | 'question'
  text: string
  options: { label: string; description?: string }[]
  allowFreeText?: boolean
  subjects?: Record<string, unknown>[]
}

export type NativeFrame =
  | { kind: 'hello'; sessionId: string; cursor: number; protocol: number }
  | { kind: 'event'; seq: number; event: { type: string; runId?: string; data?: Record<string, unknown> } }
  | { kind: 'delta'; seq: number; runId?: string; text: string }
  | { kind: 'ask'; seq: number; question: NativeQuestion }
  | { kind: 'ask-closed'; seq: number; questionId: string; outcome: string }
  | { kind: 'gap'; missed: number; resumeAt: number }
  | { kind: 'closed'; reason: string }

const KINDS = new Set(['hello', 'event', 'delta', 'ask', 'ask-closed', 'gap', 'closed'])

export function parseNativeFrame(raw: string): NativeFrame | null {
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    const k = (v as { kind?: unknown }).kind
    return typeof k === 'string' && KINDS.has(k) ? (v as NativeFrame) : null
  } catch {
    return null
  }
}

// ── state ─────────────────────────────────────────────────────────────────────────────────────────

export type ToolStatus = 'running' | 'awaiting' | 'completed' | 'failed' | 'denied' | 'cancelled'

interface LiveCall {
  name: string
  status: ToolStatus
  exitCode?: number
  durationMs?: number
  errorClass?: string
}

export interface NativeChatState {
  window: NativeWindow | null
  /** The highest sequenced frame applied — the cursor a reconnect resumes after. */
  lastSeq: number | null
  running: boolean
  runId?: string
  /** Text streamed by the model call in flight. */
  liveText: string
  /** How many assistant messages the window held when that call started (see `nativeChatItems`). */
  liveBase: number
  calls: Record<string, LiveCall>
  /** Open questions, by id. */
  asks: Record<string, NativeQuestion>
  pending: { clientRef: string; text: string }[]
  /** A sentence to show once (a refused send, a closed stream). */
  notice?: string
  closed: boolean
}

export const INITIAL_NATIVE_CHAT: NativeChatState = {
  window: null, lastSeq: null, running: false, liveText: '', liveBase: 0, calls: {}, asks: {}, pending: [], closed: false,
}

export type NativeChatAction =
  | { type: 'window'; window: NativeWindow }
  | { type: 'frame'; frame: NativeFrame }
  | { type: 'sent'; clientRef: string; text: string }
  | { type: 'send-failed'; clientRef: string; sentence: string }
  | { type: 'notice'; sentence: string | undefined }

const assistantCount = (w: NativeWindow | null) => (w ? w.messages.filter(m => m.message.role === 'assistant').length : 0)
const userText = (m: NativeMessage) => (typeof m.content === 'string' ? m.content : m.content.flatMap(p => (p.type === 'text' ? [p.text] : [])).join('\n'))

const TERMINAL: Record<string, ToolStatus> = {
  'tool.completed': 'completed', 'tool.failed': 'failed', 'tool.denied': 'denied',
}

function applyFrame(s: NativeChatState, f: NativeFrame): NativeChatState {
  if (f.kind === 'hello') return s
  if (f.kind === 'gap') return s // the window refresh (needsWindowRefresh) catches up
  if (f.kind === 'closed') return { ...s, closed: true, running: false }
  if (s.lastSeq !== null && f.seq <= s.lastSeq) return s
  const next: NativeChatState = { ...s, lastSeq: f.seq }

  if (f.kind === 'delta') return { ...next, liveText: next.liveText + f.text }

  if (f.kind === 'ask') return { ...next, asks: { ...next.asks, [f.question.id]: f.question } }
  if (f.kind === 'ask-closed') {
    const { [f.questionId]: _gone, ...asks } = next.asks
    return { ...next, asks }
  }

  // an event
  const { type, runId, data = {} } = f.event
  const tx = typeof data.toolExecutionId === 'string' ? data.toolExecutionId : undefined
  switch (type) {
    case 'run.started':
      return { ...next, running: true, ...(runId ? { runId } : {}), liveText: '', liveBase: assistantCount(next.window) }
    case 'run.ended':
      return { ...next, running: false, liveText: '', asks: {} }
    case 'model.invoked':
      return { ...next, liveText: '', liveBase: assistantCount(next.window) }
    case 'tool.requested':
      if (!tx) return next
      return { ...next, calls: { ...next.calls, [tx]: { name: String(data.name ?? data.canonicalName ?? 'tool'), status: 'running' } } }
    case 'tool.completed':
    case 'tool.failed':
    case 'tool.denied': {
      if (!tx) return next
      const prev = next.calls[tx] ?? { name: 'tool', status: 'running' as ToolStatus }
      const status: ToolStatus = type === 'tool.failed' && data.status === 'cancelled' ? 'cancelled' : TERMINAL[type]!
      return {
        ...next,
        calls: {
          ...next.calls,
          [tx]: {
            ...prev, status,
            ...(typeof data.exitCode === 'number' ? { exitCode: data.exitCode } : {}),
            ...(typeof data.durationMs === 'number' ? { durationMs: data.durationMs } : {}),
            ...(typeof data.errorClass === 'string' ? { errorClass: data.errorClass } : {}),
          },
        },
      }
    }
    default:
      return next
  }
}

export function nativeChatReducer(s: NativeChatState, a: NativeChatAction): NativeChatState {
  switch (a.type) {
    case 'frame':
      return applyFrame(s, a.frame)
    case 'window': {
      const w = a.window
      const lr = w.latestRun
      // Pending messages the window now carries are no longer pending — matched by text, oldest first.
      const persisted = w.messages.filter(m => m.message.role === 'user').map(m => userText(m.message))
      const pending = s.pending.filter(p => {
        const i = persisted.indexOf(p.text)
        if (i < 0) return true
        persisted.splice(i, 1)
        return false
      })
      const runningFromWindow = lr?.status === 'running'
      return {
        ...s,
        window: w,
        pending,
        // the stream decides while it is live; the window decides on a cold open (a reload mid-run)
        running: s.lastSeq === null ? runningFromWindow : s.running,
        ...(lr && (s.runId === undefined || s.lastSeq === null) ? { runId: lr.runId } : {}),
      }
    }
    case 'sent':
      return { ...s, pending: [...s.pending, { clientRef: a.clientRef, text: a.text }], notice: undefined }
    case 'send-failed':
      return { ...s, pending: s.pending.filter(p => p.clientRef !== a.clientRef), notice: a.sentence }
    case 'notice':
      return { ...s, notice: a.sentence }
  }
}

/** The cursor to reconnect from: the frame after the last one applied; none before the first. */
export function streamFromSeq(s: NativeChatState): number | undefined {
  return s.lastSeq === null ? undefined : s.lastSeq + 1
}

/** After these frames the persisted window has news (a tool_use, a result, a message, a gap). */
export function needsWindowRefresh(f: NativeFrame): boolean {
  if (f.kind === 'gap') return true
  if (f.kind !== 'event') return false
  return ['tool.requested', 'tool.completed', 'tool.failed', 'tool.denied', 'model.completed', 'model.failed', 'run.ended'].includes(f.event.type)
}

// ── the view ─────────────────────────────────────────────────────────────────────────────────────

export interface NativeAsk {
  questionId: string
  kind: 'permission' | 'question'
  text: string
  options: { label: string; description?: string }[]
  allowFreeText?: boolean
  /** What the call would touch (a command, a path) — for the person to read before answering. */
  subjects: string[]
}

export interface ToolCard {
  key: string
  name: string
  /** What it acted on: a path, a command, a pattern. */
  detail?: string
  status: ToolStatus
  result?: string
  isError?: boolean
  exitCode?: number
  durationMs?: number
  toolExecutionId?: string
  ask?: NativeAsk
}

export type NativeChatItem =
  | { kind: 'turn'; key: string; turn: ChatTurn }
  | { kind: 'tool'; key: string; card: ToolCard }
  | { kind: 'approval'; key: string; ask: NativeAsk }

/** `file__read` → `file.read` (the provider wire name of a catalogue tool). */
const canonical = (wire: string) => wire.replace(/__/g, '.')

function detailOf(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const i = input as Record<string, unknown>
  for (const k of ['command', 'path', 'pattern', 'id', 'query']) {
    if (typeof i[k] === 'string' && (i[k] as string).trim() !== '') return (i[k] as string).replace(/\s+/g, ' ').trim().slice(0, 160)
  }
  if (typeof i.patch === 'string') {
    const m = /\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(i.patch)
    if (m) return m[1]!.trim()
  }
  if (typeof i.offloaded === 'string') return i.offloaded.slice(0, 160)
  return undefined
}

function subjectLines(q: NativeQuestion): string[] {
  return (q.subjects ?? []).flatMap(s => {
    if (typeof s.command === 'string') return [s.command]
    if (typeof s.path === 'string') return [`${typeof s.action === 'string' ? `${s.action} ` : ''}${s.path}`]
    return []
  })
}

function toAsk(q: NativeQuestion): NativeAsk {
  return {
    questionId: q.id, kind: q.kind, text: q.text, options: q.options,
    ...(q.allowFreeText ? { allowFreeText: true } : {}),
    subjects: subjectLines(q),
  }
}

export function nativeChatItems(s: NativeChatState): NativeChatItem[] {
  const items: NativeChatItem[] = []
  const w = s.window
  const execByUse = new Map<string, string>()
  for (const c of w?.latestRun?.toolCalls ?? []) execByUse.set(c.toolUseId, c.toolExecutionId)
  const results = new Map<string, { content: string; isError?: boolean }>()
  for (const m of w?.messages ?? []) {
    if (typeof m.message.content === 'string') continue
    for (const p of m.message.content) if (p.type === 'tool_result') results.set(p.toolUseId, { content: p.content, ...(p.isError ? { isError: true } : {}) })
  }
  const asks = Object.values(s.asks)
  const usedAsks = new Set<string>()
  const askFor = (tx: string | undefined) => {
    if (!tx) return undefined
    const q = asks.find(a => a.id.startsWith(tx))
    if (!q) return undefined
    usedAsks.add(q.id)
    return toAsk(q)
  }
  const seenTx = new Set<string>()

  for (const m of w?.messages ?? []) {
    const msg = m.message
    if (msg.role === 'user') {
      const text = userText(msg)
      if (text.trim() !== '') items.push({ kind: 'turn', key: `m${m.seq}`, turn: { role: 'user', text } })
      continue
    }
    if (typeof msg.content === 'string') {
      if (msg.content.trim() !== '') items.push({ kind: 'turn', key: `m${m.seq}`, turn: { role: 'assistant', text: msg.content } })
      continue
    }
    let text = ''
    const flush = (i: number) => {
      if (text.trim() !== '') items.push({ kind: 'turn', key: `m${m.seq}.${i}`, turn: { role: 'assistant', text } })
      text = ''
    }
    msg.content.forEach((p, i) => {
      if (p.type === 'text') { text += (text ? '\n\n' : '') + p.text; return }
      if (p.type !== 'tool_use') return
      flush(i)
      const tx = execByUse.get(p.id)
      if (tx) seenTx.add(tx)
      const live = tx ? s.calls[tx] : undefined
      const res = results.get(p.id)
      const ask = askFor(tx)
      const ref = w?.latestRun?.toolCalls.find(c => c.toolUseId === p.id)
      const status: ToolStatus = ask ? 'awaiting'
        : live && live.status !== 'running' ? live.status
          : res ? (res.isError ? 'failed' : 'completed')
            : live?.status ?? (s.running ? 'running' : 'cancelled')
      const detail = detailOf(p.input)
      items.push({
        kind: 'tool', key: `t${p.id}`,
        card: {
          key: p.id, name: ref?.name ?? canonical(p.name), status,
          ...(detail ? { detail } : {}),
          ...(res ? { result: res.content } : {}),
          ...(res?.isError ? { isError: true } : {}),
          ...(live?.exitCode !== undefined ? { exitCode: live.exitCode } : {}),
          ...(live?.durationMs !== undefined ? { durationMs: live.durationMs } : {}),
          ...(tx ? { toolExecutionId: tx } : {}),
          ...(ask ? { ask } : {}),
        },
      })
    })
    flush(msg.content.length)
  }

  // Calls the window has not caught up with: cards from their events.
  for (const [tx, c] of Object.entries(s.calls)) {
    if (seenTx.has(tx)) continue
    const ask = askFor(tx)
    items.push({ kind: 'tool', key: `x${tx}`, card: { key: tx, name: c.name, status: ask ? 'awaiting' : c.status, toolExecutionId: tx, ...(ask ? { ask } : {}) } })
  }

  for (const p of s.pending) items.push({ kind: 'turn', key: `pending:${p.clientRef}`, turn: { role: 'user', text: p.text, pending: true } })

  if (s.liveText !== '' && assistantCount(w) <= s.liveBase) {
    items.push({ kind: 'turn', key: 'live', turn: { role: 'assistant', text: s.liveText, pending: true } })
  }

  for (const q of asks) if (!usedAsks.has(q.id)) items.push({ kind: 'approval', key: `q${q.id}`, ask: toAsk(q) })

  // A user turn that is only pending is `pending: true`; persisted turns say `pending: false` so a
  // caller can tell them apart without a second field.
  return items.map(i => (i.kind === 'turn' && i.turn.role === 'user' && i.turn.pending === undefined ? { ...i, turn: { ...i.turn, pending: false } } : i))
}
