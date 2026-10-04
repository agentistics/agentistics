/**
 * projections/session-surface.ts — PURE, version 1. Keyed by `sessionId` (LIVE.2; spec
 * `2026-10-02-live-sessions-from-journal` §3, narrowed by the owner's Q3 of 2026-10-02): what the SESSION
 * surfaces (the chat, the tail, the reopen list) may say about a conversation whose transcript is
 * gone — NUMBERS, never text. A deleted or expired transcript shows METRICS ONLY: no skeleton of
 * turns, no tool summaries ("permanence of conversation content is a Cloud feature, not a local one").
 * So this fold holds counts, the models, the token counters and the attention marks, and nothing a
 * person or a model wrote (D5).
 *
 * One row per session, filed in the store's `day` column under `sessionSurfaceKey(harness,
 * conversationId)` — the column a reader filters by — because the public side cannot derive a
 * canonical session id from a conversation id (each integration hashes its own; they are engine code)
 * but it always knows the conversation. A session whose events never named its conversation files no row.
 *
 * Attention marks pair a `raised` with the next `cleared` AT FINISH, by time, so the fold stays
 * order-independent. A raised with no clear is `openAttention` — history for the person to read, never
 * a button: whether a card is answerable is decided by the live fleet row alone.
 *
 * Idempotent by `eventId` (`seen`, over the types it counts); `firstAt`/`lastAt` are a min/max over every
 * event, so a repeat or a reorder changes nothing.
 */
import type { AgentisticsEvent, AnyAgentisticsEvent, Projection } from '@agentistics/core'

/** Marks kept per session — the most recent. A conversation of thousands of dialogs must not be one huge row. */
export const SESSION_SURFACE_MAX_MARKS = 50

export const sessionSurfaceKey = (harness: string, conversationId: string): string => `${harness}:${conversationId}`

export interface SurfaceMark {
  at: string
  kind: 'approval' | 'question' | 'select' | 'confirm' | 'unknown'
  via: 'screen' | 'acp'
  optionCount?: number
  hasFreeText?: boolean
  /** Absent while the dialog is still open. */
  how?: 'answered-here' | 'answered-elsewhere' | 'session-ended' | 'unknown'
  /** The 1-based option index, only when agentop sent it. An index, never a label. */
  choice?: number
  blockedMs?: number
}

export interface SessionSurfaceRow {
  /** The lookup key (`sessionSurfaceKey`), or `''` when the events never named the conversation. */
  key: string
  sessionId: string | null
  harness: string | null
  conversationId: string | null
  firstAt: string | null
  lastAt: string | null
  /** Human turns (`turn.started`). */
  turns: number
  toolCalls: number
  toolsFailed: number
  toolsDenied: number
  models: string[]
  /** Summed per counter over the responses that reported it; `null` when no response was folded at all. */
  tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | null
  /** Oldest first, at most `SESSION_SURFACE_MAX_MARKS`. */
  attention: SurfaceMark[]
  /** The latest dialog that was raised and never cleared, when there is one. */
  openAttention?: SurfaceMark
}

interface Raised { eventId: string; at: string; data: AgentisticsEvent<'attention.raised'>['data'] }
interface Cleared { eventId: string; at: string; data: AgentisticsEvent<'attention.cleared'>['data'] }

export interface SessionSurfaceState {
  seen: Set<string>
  sessionId?: string
  harness?: string
  conversationId?: string
  firstAt?: string
  lastAt?: string
  turns: number
  toolCalls: number
  toolsFailed: number
  toolsDenied: number
  models: Set<string>
  tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | null
  raised: Raised[]
  cleared: Cleared[]
}

const COUNTED: ReadonlySet<string> = new Set([
  'run.started', 'turn.started', 'tool.requested', 'tool.failed', 'tool.denied', 'model.completed', 'attention.raised', 'attention.cleared',
])

function foldOne(s: SessionSurfaceState, e: AnyAgentisticsEvent): void {
  if (e.sessionId && (s.sessionId === undefined || e.sessionId < s.sessionId)) s.sessionId = e.sessionId
  if (s.firstAt === undefined || e.occurredAt < s.firstAt) s.firstAt = e.occurredAt
  if (s.lastAt === undefined || e.occurredAt > s.lastAt) s.lastAt = e.occurredAt
  if (!COUNTED.has(e.type) || s.seen.has(e.eventId)) return
  s.seen.add(e.eventId)
  switch (e.type) {
    case 'run.started': {
      const d = (e as AgentisticsEvent<'run.started'>).data
      // Several runs of one session (a resume): the smallest conversation id wins, so the choice is order-free.
      if (d.conversationId && (s.conversationId === undefined || d.conversationId < s.conversationId)) {
        s.conversationId = d.conversationId
        s.harness = d.harness
      }
      return
    }
    case 'turn.started': s.turns++; return
    case 'tool.requested': s.toolCalls++; return
    case 'tool.failed': s.toolsFailed++; return
    case 'tool.denied': s.toolsDenied++; return
    case 'model.completed': {
      const d = (e as AgentisticsEvent<'model.completed'>).data
      s.models.add(d.model)
      const t = (s.tokens ??= {})
      for (const c of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
        const v = d.usage[c]
        if (typeof v === 'number') t[c] = (t[c] ?? 0) + v
      }
      return
    }
    case 'attention.raised': s.raised.push({ eventId: e.eventId, at: e.occurredAt, data: (e as AgentisticsEvent<'attention.raised'>).data }); return
    case 'attention.cleared': s.cleared.push({ eventId: e.eventId, at: e.occurredAt, data: (e as AgentisticsEvent<'attention.cleared'>).data }); return
  }
}

const byTime = (a: { at: string; eventId: string }, b: { at: string; eventId: string }): number =>
  a.at < b.at ? -1 : a.at > b.at ? 1 : a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0

function marksOf(s: SessionSurfaceState): { marks: SurfaceMark[]; open?: SurfaceMark } {
  const raised = [...s.raised].sort(byTime)
  const matched = new Set<number>()
  const how = new Map<number, Cleared>()
  for (const c of [...s.cleared].sort(byTime)) {
    for (let i = raised.length - 1; i >= 0; i--) {
      if (matched.has(i) || raised[i]!.at > c.at) continue
      matched.add(i); how.set(i, c); break
    }
  }
  const marks = raised.map((r, i): SurfaceMark => {
    const c = how.get(i)
    return {
      at: r.at, kind: r.data.kind, via: r.data.via,
      ...(r.data.optionCount !== undefined ? { optionCount: r.data.optionCount } : {}),
      ...(r.data.hasFreeText !== undefined ? { hasFreeText: r.data.hasFreeText } : {}),
      ...(c ? { how: c.data.how, ...(c.data.choice !== undefined ? { choice: c.data.choice } : {}), ...(c.data.blockedMs !== undefined ? { blockedMs: c.data.blockedMs } : {}) } : {}),
    }
  })
  const open = [...raised.keys()].filter(i => !matched.has(i)).at(-1)
  const kept = marks.slice(-SESSION_SURFACE_MAX_MARKS)
  return { marks: kept, ...(open !== undefined ? { open: marks[open]! } : {}) }
}

export const sessionSurfaceProjection: Projection<SessionSurfaceState, SessionSurfaceRow | null> = {
  name: 'session-surface',
  version: 1,
  empty: () => ({ seen: new Set(), turns: 0, toolCalls: 0, toolsFailed: 0, toolsDenied: 0, models: new Set(), tokens: null, raised: [], cleared: [] }),
  fold(state, events) {
    for (const e of events) foldOne(state, e)
  },
  finish(s) {
    if (s.firstAt === undefined) return null
    const { marks, open } = marksOf(s)
    return {
      key: s.harness && s.conversationId ? sessionSurfaceKey(s.harness, s.conversationId) : '',
      sessionId: s.sessionId ?? null,
      harness: s.harness ?? null,
      conversationId: s.conversationId ?? null,
      firstAt: s.firstAt ?? null,
      lastAt: s.lastAt ?? null,
      turns: s.turns,
      toolCalls: s.toolCalls,
      toolsFailed: s.toolsFailed,
      toolsDenied: s.toolsDenied,
      models: [...s.models].sort(),
      tokens: s.tokens ? { ...s.tokens } : null,
      attention: marks,
      ...(open ? { openAttention: open } : {}),
    }
  },
}
