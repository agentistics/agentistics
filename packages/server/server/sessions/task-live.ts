/**
 * task-live.ts — PURE. The LIVE DELIVERY view's read model: the active PIECES of work (a subtask,
 * or a task nobody broke up), which stage of the delivery line each is in, and an ETA that says
 * where it comes from.
 *
 * What this module knows and what it does not:
 *  - It knows the BOOK: statuses, when a status last moved, the sessions filed under each piece
 *    and their span, the activity log. It does NOT know whether a session is working or waiting
 *    right now — that is the fleet's, and the browser joins the two (two copies of one truth
 *    disagree and flicker).
 *  - A STAGE is derived, never stored. The board has no "QA" field: it is read from the status
 *    (`in_review` → leader review, `blocked` → adjust, `done` → published) and, for work in
 *    progress, from the filed sessions' own names (a live session called "…QA…" is QA). A status
 *    the vocabulary lets people invent is matched on its id/label words; one nobody can place is
 *    not guessed into a column — a piece with a live session falls back to "running", one without
 *    is left off the line.
 *  - The ETA is NEVER a number without a source. It is the median of how long SIMILAR delivered
 *    pieces took (same harness + model, else same harness), with the inter-quartile half-range as
 *    the ± and a confidence read off the sample size and spread. Fewer than `MIN_SAMPLES`
 *    similar pieces, or a piece already past the typical range, answers `none` with the reason.
 */

import type { Subtask, Task, TaskEvent } from './task-model'
import type { PieceTimes } from './task-times'
import type { TaskDetail } from './task-report'

export type LiveStage = 'queue' | 'running' | 'qa' | 'adjust' | 'leader' | 'merge' | 'published'
export const LIVE_STAGES: readonly LiveStage[] = ['queue', 'running', 'qa', 'adjust', 'leader', 'merge', 'published']

export const MIN_SAMPLES = 3
/** A published piece stays on the line this long. */
export const PUBLISHED_WINDOW_MS = 24 * 3600_000

export type LiveEta =
  | {
      kind: 'estimate'
      atMs: number
      plusMinusMs: number
      confidence: 'low' | 'medium' | 'high'
      basis: { n: number; scope: 'harness-model' | 'harness'; harness: string; model: string | null; medianMs: number }
    }
  | { kind: 'none'; reason: 'no-history' | 'not-started' | 'beyond-range' }

export interface LiveDelivery {
  /** `<taskId>` or `<taskId>/<subtaskId>` — stable across polls. */
  key: string
  taskId: string
  taskTitle: string
  subtaskId: string | null
  title: string
  status: string
  stage: LiveStage
  /** When the piece last changed status (the book's own stamp) — "time in this stage". */
  stageSinceMs: number | null
  /** Earliest session start; null when nothing is filed. */
  startedAtMs: number | null
  /** Registry ids of the sessions that have not ended — what the browser joins to the fleet. */
  sessionIds: string[]
  harnesses: string[]
  models: string[]
  eta: LiveEta
  /** The newest thing the log says about this piece, short. Null when nothing is recorded. */
  lastAction: { text: string; atMs: number } | null
  blockedReason: string | null
  /** Set once a published piece leaves the line. */
  deliveredAtMs: number | null
}

export interface LiveReply {
  generatedAt: string
  deliveries: LiveDelivery[]
  /** How many delivered pieces fed the ETA — shown so "no estimate" is explainable. */
  samples: number
}

// ---------------------------------------------------------------------------------- stage

const words = (s: string) => s.toLowerCase()

/** PURE: the stage a status names, by id then label; null when it names none of them. */
export function stageOfStatus(status: string, label?: string): LiveStage | null {
  switch (status) {
    case 'todo': return 'queue'
    case 'in_progress': return 'running'
    case 'blocked': return 'adjust'
    case 'in_review': return 'leader'
    case 'done': return 'published'
    default: break
  }
  const t = `${words(status)} ${words(label ?? '')}`
  if (/\bqa\b|\btest/.test(t)) return 'qa'
  if (/ajust|adjust|\bfix|rework|retrab/.test(t)) return 'adjust'
  if (/review|revis/.test(t)) return 'leader'
  if (/merge|\bpr\b|pull.?request/.test(t)) return 'merge'
  if (/publish|publicad|releas|shipped/.test(t)) return 'published'
  if (/progress|andamento|doing|executando|running/.test(t)) return 'running'
  if (/todo|backlog|queue|fila/.test(t)) return 'queue'
  return null
}

const QA_NAME = /(^|[^a-z])qa([^a-z]|$)|\bquality\b/i

interface PieceSession { id: string; harness: string; model: string | null; label?: string; live: boolean }

// ---------------------------------------------------------------------------------- ETA

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 1) return sorted[0]!
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos), hi = Math.ceil(pos)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

export interface Sample { harness: string; model: string | null; durationMs: number }

/** PURE: the ETA of a piece that started at `startedAtMs`, read from `samples`. */
export function estimateEta(o: {
  nowMs: number
  startedAtMs: number | null
  harness: string | null
  model: string | null
  samples: readonly Sample[]
}): LiveEta {
  if (o.startedAtMs === null) return { kind: 'none', reason: 'not-started' }
  if (!o.harness) return { kind: 'none', reason: 'no-history' }
  const same = (s: Sample) => s.harness === o.harness
  let scope: 'harness-model' | 'harness' = 'harness-model'
  let pool = o.model ? o.samples.filter(s => same(s) && s.model === o.model) : []
  if (pool.length < MIN_SAMPLES) { scope = 'harness'; pool = o.samples.filter(same) }
  if (pool.length < MIN_SAMPLES) return { kind: 'none', reason: 'no-history' }
  const sorted = pool.map(s => s.durationMs).sort((a, b) => a - b)
  const median = quantile(sorted, 0.5)
  const p25 = quantile(sorted, 0.25), p75 = quantile(sorted, 0.75)
  const elapsed = o.nowMs - o.startedAtMs
  if (elapsed > p75) return { kind: 'none', reason: 'beyond-range' }
  const spread = median > 0 ? (p75 - p25) / median : 1
  const confidence = pool.length >= 8 && spread < 0.6 ? 'high' : pool.length >= 4 && spread < 1.2 ? 'medium' : 'low'
  return {
    kind: 'estimate',
    atMs: o.startedAtMs + Math.max(median, elapsed),
    plusMinusMs: Math.round((p75 - p25) / 2),
    confidence,
    basis: { n: pool.length, scope, harness: o.harness, model: scope === 'harness-model' ? o.model : null, medianMs: Math.round(median) },
  }
}

const dominant = (xs: readonly string[]): string | null => {
  const n = new Map<string, number>()
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1)
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

// ---------------------------------------------------------------------------------- build

interface Piece {
  task: Task
  sub: Subtask | null
  status: string
  updatedAt: string
  deliveredAt?: string
  times: PieceTimes | undefined
  sessions: PieceSession[]
  blockedReason: string | null
}

/** Resolve the target carried by newer activity records and by the older human-readable detail. */
function eventSubtaskId(e: TaskEvent, titles: ReadonlyMap<string, string>): string | null {
  if (e.subtaskId) return e.subtaskId
  const rawTarget = (e as TaskEvent & { target?: unknown }).target
  if (rawTarget && typeof rawTarget === 'object') {
    const target = rawTarget as { kind?: unknown; id?: unknown }
    if (target.kind === 'subtask' && typeof target.id === 'string' && target.id) return target.id
  }
  const detail = e.detail?.trim() ?? ''
  const match = /^on subtask ["“]([\s\S]*)["”]$/i.exec(detail)
  if (!match) return null
  return titles.get(`${e.taskId}\0${match[1]}`) ?? null
}

const ms = (iso: string | undefined | null): number | null => {
  const n = iso ? Date.parse(iso) : NaN
  return Number.isFinite(n) ? n : null
}

function piecesOf(d: TaskDetail): Piece[] {
  const sessionsOf = (subtaskId: string | null): PieceSession[] =>
    d.sessions
      .filter(s => (s.subtaskId ?? null) === subtaskId && !s.historical)
      .map(s => ({
        id: s.id, harness: s.harness, model: s.model, ...(s.label ? { label: s.label } : {}),
        live: !s.endedAt,
      }))
  const timesOf = (id: string | null) => d.subtaskRollups.find(r => r.id === id)?.times
  const subs = d.subtasks.filter(s => !s.parentGroupId)
  const out: Piece[] = subs.map(s => ({
    task: d.task, sub: s, status: s.status, updatedAt: s.updatedAt,
    ...(s.deliveredAt ? { deliveredAt: s.deliveredAt } : {}),
    times: timesOf(s.id), sessions: sessionsOf(s.id),
    blockedReason: null,
  }))
  // Sessions filed on the task itself stand for a piece of their own; a task with NO subtasks is
  // that piece. A task that has subtasks and also direct sessions gets the extra piece only while
  // one of those sessions is alive (an ended direct session is history, not a delivery).
  const direct = sessionsOf(null)
  if (subs.length === 0 || direct.some(s => s.live)) {
    out.push({
      task: d.task, sub: null, status: d.task.status, updatedAt: d.task.updatedAt,
      ...(d.task.deliveredAt ? { deliveredAt: d.task.deliveredAt } : {}),
      times: timesOf(null) ?? d.times, sessions: direct,
      blockedReason: d.task.blockedReason ?? null,
    })
  }
  return out
}

/** PURE: details of the tasks → what the line shows now, plus the history the ETA rests on. */
export function buildLive(o: {
  details: readonly TaskDetail[]
  events: readonly TaskEvent[]
  nowMs: number
  /** id → label of the board's status vocabulary, for statuses people invented. */
  statusLabel?: (id: string) => string | undefined
}): LiveReply {
  const samples: Sample[] = []
  const candidates: Piece[] = []
  for (const d of o.details) {
    for (const p of piecesOf(d)) {
      const dur = p.times?.source === 'sessions' ? p.times.durationMs : null
      if (p.status === 'done' && dur && dur > 0 && p.sessions.length > 0) {
        samples.push({
          harness: dominant(p.sessions.map(s => s.harness)) ?? p.sessions[0]!.harness,
          model: dominant(p.sessions.map(s => s.model).filter((m): m is string => !!m)),
          durationMs: dur,
        })
      }
      candidates.push(p)
    }
  }

  const subtaskTitles = new Map<string, string>()
  for (const d of o.details) for (const sub of d.subtasks) {
    const key = `${sub.taskId}\0${sub.title}`
    // Ambiguous titles cannot safely identify an activity target; explicit event ids still work.
    if (subtaskTitles.has(key)) subtaskTitles.set(key, '')
    else subtaskTitles.set(key, sub.id)
  }
  const lastBySubject = new Map<string, TaskEvent>()
  for (const e of o.events) {
    const subtaskId = eventSubtaskId(e, subtaskTitles)
    const subject = subtaskId ? `${e.taskId}/${subtaskId}` : e.taskId
    const prev = lastBySubject.get(subject)
    if (!prev || e.at >= prev.at) lastBySubject.set(subject, e)
  }

  const deliveries: LiveDelivery[] = []
  for (const p of candidates) {
    let stage = stageOfStatus(p.status, o.statusLabel?.(p.status))
    const liveSessions = p.sessions.filter(s => s.live)
    if (stage === 'running' && liveSessions.some(s => s.label && QA_NAME.test(s.label))) stage = 'qa'
    if (stage === null) stage = liveSessions.length > 0 ? 'running' : null
    if (stage === null) continue
    const deliveredAtMs = ms(p.deliveredAt) ?? (stage === 'published' ? ms(p.updatedAt) : null)
    if (stage === 'published' && (deliveredAtMs === null || o.nowMs - deliveredAtMs > PUBLISHED_WINDOW_MS)) continue
    // An "active" delivery has a live agent or sits at a gate. A todo piece with nothing staged and
    // nothing alive is the main board's business, not the line's.
    const gate = stage === 'qa' || stage === 'adjust' || stage === 'leader' || stage === 'merge'
    const staged = p.sub?.stagedSession !== undefined
    if (stage === 'queue' && !staged && liveSessions.length === 0) continue
    if (stage === 'running' && liveSessions.length === 0 && !gate) continue
    const startedAtMs = ms(p.times?.startedAt) ?? ms(p.sub?.startedAt ?? p.task.startedAt)
    const harness = dominant(liveSessions.concat(p.sessions).map(s => s.harness))
    const model = dominant(liveSessions.concat(p.sessions).map(s => s.model).filter((m): m is string => !!m))
    const ev = lastBySubject.get(p.sub ? `${p.task.id}/${p.sub.id}` : p.task.id)
    deliveries.push({
      key: p.sub ? `${p.task.id}/${p.sub.id}` : p.task.id,
      taskId: p.task.id, taskTitle: p.task.title,
      subtaskId: p.sub?.id ?? null,
      title: p.sub?.title ?? p.task.title,
      status: p.status, stage,
      stageSinceMs: ms(p.updatedAt),
      startedAtMs,
      sessionIds: liveSessions.map(s => s.id),
      harnesses: [...new Set(liveSessions.concat(p.sessions).map(s => s.harness))],
      models: [...new Set(liveSessions.concat(p.sessions).map(s => s.model).filter((m): m is string => !!m))],
      eta: stage === 'published' ? { kind: 'none', reason: 'not-started' }
        : estimateEta({ nowMs: o.nowMs, startedAtMs, harness, model, samples }),
      lastAction: ev ? { text: (ev.detail ?? ev.kind).split('\n')[0]!.slice(0, 120), atMs: ms(ev.at) ?? o.nowMs } : null,
      blockedReason: p.blockedReason,
      deliveredAtMs: stage === 'published' ? deliveredAtMs : null,
    })
  }
  deliveries.sort((a, b) => (b.stageSinceMs ?? 0) - (a.stageSinceMs ?? 0))
  return { generatedAt: new Date(o.nowMs).toISOString(), deliveries, samples: samples.length }
}
