/**
 * deliveryCalendar.ts — PURE. The read model of the Delivery calendar ("Calendário de entregas"): when each
 * piece of work started, when it is expected to ship, which release version it rides, when a version really
 * went out, and the moments of the context that matter to a schedule (an account's usage window renewing, a
 * task's due day).
 *
 * ONE builder and ONE filter serve the screen, `GET /api/deliveries/calendar`, the MCP tool
 * `agentistics_delivery_calendar` and `agentop flow calendario`. A second implementation of "which piece is
 * active" or "when does 2.202.0 ship" would be a second answer to the same question, which is the bug the
 * board's own `task-reopen.ts` exists to have fixed once.
 *
 * Rules that are the whole point:
 *  - NOTHING IS INVENTED. An ETA is only ever what the Live read model computed from delivered work
 *    (`kind: 'none'` stays "no estimate" and is never given a date); a version's predicted date is the LATEST
 *    ETA of its pieces and is absent — flagged `partial` or `none` — when any piece cannot say.
 *  - A PUBLISHED instant is the delivery record's `publishedAt` (the green release run's own completion), never
 *    the moment somebody noticed.
 *  - A day is a BRT day (`America/Sao_Paulo`, UTC-3 — Brazil has no daylight saving since 2019), whatever zone
 *    the reader's machine is in: a delivery planned for "Sat 07" is Sat 07 for everybody on the team.
 */

export const CAL_TZ = 'America/Sao_Paulo'
export const BRT_OFFSET_MS = -3 * 3600_000

export const CAL_STAGES = ['queue', 'blocked', 'running', 'qa', 'adjust', 'leader', 'merge', 'ci', 'published'] as const
export type CalStage = (typeof CAL_STAGES)[number]
export type CalPriority = 'urgent' | 'high' | 'medium' | 'low'
export const CAL_PRIORITIES: readonly CalPriority[] = ['urgent', 'high', 'medium', 'low']
export type CalConfidence = 'low' | 'medium' | 'high'

/** The ETA of a piece reaching Publicado (or leaving its stage) — `none` is "no estimate", never a time. */
export type CalEta =
  | { kind: 'estimate'; atMs: number; confidence: CalConfidence | null }
  | { kind: 'none'; reason: string | null }

/** One real visit to a stage, from the activity log; `ms` runs to now for the stage the piece is in. */
export interface CalVisit { stage: CalStage; enteredMs: number; ms: number }

export interface CalPiece {
  /** `<taskId>` or `<taskId>/<subtaskId>`. */
  key: string
  taskId: string
  taskTitle: string
  subtaskId: string | null
  title: string
  stage: CalStage
  /** The release version it rides (`2.202.0`); null when none is declared (or the piece was deferred to `next`). */
  version: string | null
  harness: string | null
  model: string | null
  priority: CalPriority | null
  /** A piece of a task being worked on now. The default filter. */
  active: boolean
  startedAtMs: number | null
  stageSinceMs: number | null
  /** The stages the piece really went through, oldest first — what the schedule's coloured bars are drawn from. */
  trail: CalVisit[]
  /** Expected time of leaving the current stage. */
  stageEta: CalEta
  /** Expected time of reaching Publicado. */
  publishEta: CalEta
  /** The real publication instant (the release's own) — null until it shipped. */
  publishedAtMs: number | null
  /** `yyyy-MM-dd` — the task's due day. */
  dueDate: string | null
  /** Published, or an estimate with at least medium confidence. "só confirmadas" keeps exactly these. */
  confirmed: boolean
  /** Past its due day, or past its publish ETA, and not published. */
  late: boolean
}

export interface CalVersion {
  version: string
  state: 'published' | 'planned'
  /** Published: the real instant. Planned: the latest piece ETA (null when no piece can say). */
  atMs: number | null
  basis: 'published' | 'estimate' | 'partial' | 'none'
  /** True when publication was proven by a release tag and its green run. */
  taggedRelease?: boolean
  /** Lowest confidence among the pieces that carry an estimate. */
  confidence: CalConfidence | null
  pieceKeys: string[]
  stageCounts: Partial<Record<CalStage, number>>
}

export type CalMark =
  | { kind: 'account-reset'; atMs: number; harness: string; account: string; label: string; window: '5h' | 'week' }
  | { kind: 'task-due'; day: string; taskId: string; label: string; priority: CalPriority | null }

export interface CalendarReply {
  generatedAt: string
  nowMs: number
  timezone: typeof CAL_TZ
  pieces: CalPiece[]
  versions: CalVersion[]
  marks: CalMark[]
}

// ---------------------------------------------------------------------------------------------- inputs

/** What the builder needs of a Live delivery — structural, so core imports nothing from the server. */
export interface CalLiveInput {
  key: string
  taskId: string
  taskTitle: string
  subtaskId: string | null
  title: string
  stage: CalStage
  startedAtMs: number | null
  stageSinceMs: number | null
  harnesses: readonly string[]
  models: readonly string[]
  trail?: readonly CalVisit[]
  eta: { kind: 'estimate'; confidence: CalConfidence } | { kind: 'none'; reason?: string }
  stageEta: { kind: 'estimate'; atMs: number } | { kind: 'none'; reason?: string }
  publishEta: { kind: 'estimate'; atMs: number } | { kind: 'none'; reason?: string }
  deliveredAtMs: number | null
}
export interface CalRecordInput {
  subtaskId: string; taskId: string; phase: string; versionTarget?: string; publishedAt?: string; tag?: string
  /** ISO of the record's first and latest phase moves (its history) — when the piece began and entered this phase. */
  firstAt?: string; lastAt?: string
}

/** The Live stage each delivery phase reads as (`delivery/host.ts` LIVE_STAGE) — a record with no Live card still has one. */
const PHASE_STAGE: Record<string, CalStage> = {
  fila: 'queue', executando: 'running', qa: 'qa', ajuste: 'adjust', revisao_lider: 'leader', pr_merge: 'merge', ci: 'ci', publicado: 'published', bloqueado: 'blocked',
}
export interface CalTaskInput { id: string; title: string; status: string; priority?: string; dueDate?: string }
export interface CalSubtaskInput { id: string; taskId: string; title: string; priority?: string; dueDate?: string }
export interface CalResetInput { harness: string; account: string; label: string; window: '5h' | 'week'; resetsAt: number }

const toPriority = (p: string | undefined): CalPriority | null => (p === 'urgent' || p === 'high' || p === 'medium' || p === 'low' ? p : null)
const pickVersion = (v: string | undefined): string | null => (v && v !== 'next' && /^\d+\.\d+\.\d+/.test(v) ? v : null)
const parseMs = (iso: string | undefined): number | null => { const n = iso ? Date.parse(iso) : NaN; return Number.isFinite(n) ? n : null }
const eta = (e: { kind: string; atMs?: number; reason?: string }, confidence: CalConfidence | null): CalEta =>
  e.kind === 'estimate' && typeof e.atMs === 'number' ? { kind: 'estimate', atMs: e.atMs, confidence } : { kind: 'none', reason: e.reason ?? null }

/** `yyyy-MM-dd` of an instant on the BRT clock. */
export function brtDay(ms: number): string { return new Date(ms + BRT_OFFSET_MS).toISOString().slice(0, 10) }
/** The BRT clock reading of an instant: day, hour, minute. */
export function brtParts(ms: number): { day: string; hour: number; minute: number } {
  const d = new Date(ms + BRT_OFFSET_MS)
  return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours(), minute: d.getUTCMinutes() }
}
/** Epoch ms of 00:00 BRT of a `yyyy-MM-dd`. */
export function brtDayStartMs(day: string): number { return Date.parse(`${day}T00:00:00.000Z`) - BRT_OFFSET_MS }

const RANK: Record<CalConfidence, number> = { low: 0, medium: 1, high: 2 }

export function buildCalendar(o: {
  nowMs: number
  lives: readonly CalLiveInput[]
  records: readonly CalRecordInput[]
  tasks: readonly CalTaskInput[]
  subtasks: readonly CalSubtaskInput[]
  resets: readonly CalResetInput[]
}): CalendarReply {
  const taskById = new Map(o.tasks.map(t => [t.id, t]))
  const subById = new Map(o.subtasks.map(s => [s.id, s]))
  const recBySub = new Map(o.records.map(r => [r.subtaskId, r]))
  const today = brtDay(o.nowMs)

  const pieces: CalPiece[] = []
  const seen = new Set<string>()
  for (const l of o.lives) {
    const rec = l.subtaskId ? recBySub.get(l.subtaskId) : undefined
    const task = taskById.get(l.taskId)
    const publishedAtMs = parseMs(rec?.publishedAt) ?? (l.stage === 'published' ? l.deliveredAtMs : null)
    const confidence = l.eta.kind === 'estimate' ? l.eta.confidence : null
    const publishEta = l.stage === 'published' ? ({ kind: 'none', reason: 'final' } as CalEta) : eta(l.publishEta, confidence)
    const sub = l.subtaskId ? subById.get(l.subtaskId) : undefined
    const dueDate = sub?.dueDate ?? task?.dueDate ?? null
    const published = l.stage === 'published'
    pieces.push({
      key: l.key, taskId: l.taskId, taskTitle: l.taskTitle, subtaskId: l.subtaskId, title: l.title, stage: l.stage,
      version: pickVersion(rec?.versionTarget),
      harness: l.harnesses[0] ?? null, model: l.models[0] ?? null,
      priority: toPriority(sub?.priority ?? task?.priority),
      active: !published,
      startedAtMs: l.startedAtMs, stageSinceMs: l.stageSinceMs, trail: l.trail ? l.trail.map(v => ({ ...v })) : [],
      stageEta: published ? { kind: 'none', reason: 'final' } : eta(l.stageEta, confidence),
      publishEta, publishedAtMs, dueDate,
      confirmed: published || (publishEta.kind === 'estimate' && publishEta.confidence !== null && RANK[publishEta.confidence] >= RANK.medium),
      late: !published && ((dueDate !== null && dueDate < today) || (publishEta.kind === 'estimate' && publishEta.atMs < o.nowMs)),
    })
    seen.add(l.key)
  }
  // Pieces that shipped long enough ago to have left the Live line: the delivery record still states when and in
  // which version, which is what the calendar's history needs.
  for (const r of o.records) {
    const key = `${r.taskId}/${r.subtaskId}`
    if (seen.has(key)) continue
    const publishedAtMs = parseMs(r.publishedAt)
    const task = taskById.get(r.taskId)
    const sub = subById.get(r.subtaskId)
    const dueDate = sub?.dueDate ?? task?.dueDate ?? null
    const stage = PHASE_STAGE[r.phase]
    if (stage && stage !== 'published') {
      // A piece the delivery flow tracks (it has a phase, maybe a version) that the Live line does not draw — planned
      // work with no session yet. It belongs on a calendar, but with NO estimate: the Live model produced none.
      seen.add(key)
      pieces.push({
        key, taskId: r.taskId, taskTitle: task?.title ?? r.taskId, subtaskId: r.subtaskId,
        title: subById.get(r.subtaskId)?.title ?? r.subtaskId, stage, version: pickVersion(r.versionTarget),
        harness: null, model: null, priority: toPriority(sub?.priority ?? task?.priority), active: task?.status === 'in_progress',
        startedAtMs: parseMs(r.firstAt), stageSinceMs: parseMs(r.lastAt), trail: [],
        stageEta: { kind: 'none', reason: 'not-started' }, publishEta: { kind: 'none', reason: 'not-started' },
        publishedAtMs: null, dueDate, confirmed: false,
        late: dueDate !== null && dueDate < today,
      })
      continue
    }
    if (r.phase !== 'publicado' || publishedAtMs === null) continue
    pieces.push({
      key, taskId: r.taskId, taskTitle: task?.title ?? r.taskId, subtaskId: r.subtaskId,
      title: subById.get(r.subtaskId)?.title ?? r.subtaskId, stage: 'published', version: pickVersion(r.versionTarget),
      harness: null, model: null, priority: toPriority(sub?.priority ?? task?.priority), active: false,
      startedAtMs: null, stageSinceMs: null, trail: [],
      stageEta: { kind: 'none', reason: 'final' }, publishEta: { kind: 'none', reason: 'final' },
      publishedAtMs, dueDate, confirmed: true, late: false,
    })
  }

  // ---- versions: the pieces that ride one release, and when it ships (or shipped).
  const byVersion = new Map<string, CalPiece[]>()
  for (const p of pieces) if (p.version) { const l = byVersion.get(p.version); if (l) l.push(p); else byVersion.set(p.version, [p]) }
  // A release is a version-level fact. One release record can carry the tag and the
  // green release run's completion even while sibling pieces still have stale phases.
  // Keep this separate from piece publication so a partial record cannot turn a real
  // release into a planned version with "no estimate".
  const releasePublishedAt = new Map<string, number>()
  for (const r of o.records) {
    const version = pickVersion(r.versionTarget)
    const publishedAt = parseMs(r.publishedAt)
    if (!version || !r.tag || publishedAt === null) continue
    const previous = releasePublishedAt.get(version)
    if (previous === undefined || publishedAt > previous) releasePublishedAt.set(version, publishedAt)
  }
  const versions: CalVersion[] = []
  for (const [version, ps] of byVersion) {
    const stageCounts: Partial<Record<CalStage, number>> = {}
    for (const p of ps) stageCounts[p.stage] = (stageCounts[p.stage] ?? 0) + 1
    const allPublished = ps.every(p => p.stage === 'published')
    const confs = ps.flatMap(p => (p.publishEta.kind === 'estimate' && p.publishEta.confidence ? [p.publishEta.confidence] : []))
    const lowest = confs.length ? confs.reduce((a, b) => (RANK[b] < RANK[a] ? b : a)) : null
    const releaseAtMs = releasePublishedAt.get(version)
    if (releaseAtMs !== undefined) {
      versions.push({ version, state: 'published', atMs: releaseAtMs, basis: 'published', taggedRelease: true, confidence: null, pieceKeys: ps.map(p => p.key), stageCounts })
      continue
    }
    if (allPublished) {
      const times = ps.flatMap(p => (p.publishedAtMs !== null ? [p.publishedAtMs] : []))
      versions.push({ version, state: 'published', atMs: times.length ? Math.max(...times) : null, basis: times.length ? 'published' : 'none', confidence: null, pieceKeys: ps.map(p => p.key), stageCounts })
      continue
    }
    const open = ps.filter(p => p.stage !== 'published')
    const known = open.flatMap(p => (p.publishEta.kind === 'estimate' ? [p.publishEta.atMs] : []))
    versions.push({
      version, state: 'planned',
      atMs: known.length ? Math.max(...known) : null,
      basis: known.length === 0 ? 'none' : known.length === open.length ? 'estimate' : 'partial',
      confidence: lowest, pieceKeys: ps.map(p => p.key), stageCounts,
    })
  }
  versions.sort((a, b) => compareVersions(a.version, b.version))

  // ---- marks of the context
  const marks: CalMark[] = o.resets.map(r => ({ kind: 'account-reset' as const, atMs: r.resetsAt, harness: r.harness, account: r.account, label: r.label, window: r.window }))
  for (const t of o.tasks) {
    if (!t.dueDate || t.status === 'done') continue
    marks.push({ kind: 'task-due', day: t.dueDate, taskId: t.id, label: t.title, priority: toPriority(t.priority) })
  }
  return { generatedAt: new Date(o.nowMs).toISOString(), nowMs: o.nowMs, timezone: CAL_TZ, pieces, versions, marks }
}

/** `2.10.0` > `2.9.0` — numeric by part, not text. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => Number.parseInt(n, 10) || 0), pb = b.split('.').map(n => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d }
  return 0
}

// ---------------------------------------------------------------------------------------------- filter

export interface CalFilters {
  /** `active` (default): tasks being worked on now. `all`: every piece the calendar knows. */
  tasks?: 'active' | 'all'
  /** A task id, or part of its title (case-insensitive). */
  task?: string
  subtaskId?: string
  versions?: readonly string[]
  stages?: readonly CalStage[]
  harnesses?: readonly string[]
  priorities?: readonly CalPriority[]
  confirmedOnly?: boolean
  /** Epoch ms bounds (inclusive); an item is kept when its time span touches the window. */
  fromMs?: number
  toMs?: number
}

/** The instants a piece occupies: start → end (published / ETA). A piece with one known instant is a point. */
export function pieceSpan(p: CalPiece): { startMs: number; endMs: number } | null {
  const start = p.startedAtMs ?? p.stageSinceMs
  const end = p.publishedAtMs ?? (p.publishEta.kind === 'estimate' ? p.publishEta.atMs : null)
  if (start === null && end === null) return null
  const s = start ?? end!, e = end ?? start!
  return { startMs: Math.min(s, e), endMs: Math.max(s, e) }
}

/** A piece that has not finished only "was on" a day it did something, and on today only if that was in the last 24h. */
export const RECENT_ACTIVITY_MS = 24 * 3600_000
const BLIP_MS = 15 * 60_000

export interface CalPresence { fromMs: number; toMs: number; expected: boolean }

/**
 * THE one rule for "what is on a day" — the Day and phone Week views draw from it and the API's date window filters
 * with it, so the screen and `GET /api/deliveries/calendar?from=&to=` can never count differently.
 *  - published: start → publication.
 *  - open with a FUTURE publish ETA: start → ETA (real until now, expected after).
 *  - open with no ETA or an ETA already past: NOT stretched across the days between; only the instants of real
 *    activity (start, stage entries from the trail, the current stage's start), plus now when the last one is < 24h old.
 *  - no activity data at all: nothing — a piece is never extended on the strength of nothing.
 */
export function piecePresence(p: CalPiece, nowMs: number): CalPresence[] {
  const start = p.startedAtMs ?? p.stageSinceMs
  if (p.publishedAtMs !== null) {
    const s = start ?? p.publishedAtMs
    return [{ fromMs: Math.min(s, p.publishedAtMs), toMs: Math.max(Math.max(s, p.publishedAtMs), Math.min(s, p.publishedAtMs) + BLIP_MS), expected: false }]
  }
  const eta = p.publishEta.kind === 'estimate' ? p.publishEta.atMs : null
  if (eta !== null && eta >= nowMs) {
    const out: CalPresence[] = []
    if (start !== null && start < nowMs) out.push({ fromMs: start, toMs: nowMs, expected: false })
    out.push({ fromMs: Math.max(nowMs, start ?? nowMs), toMs: Math.max(eta, nowMs + BLIP_MS), expected: true })
    return out
  }
  const at = [p.startedAtMs, p.stageSinceMs, ...p.trail.map(v => v.enteredMs)].filter((x): x is number => x !== null && Number.isFinite(x))
  if (at.length === 0) return []
  const out: CalPresence[] = at.map(a => ({ fromMs: a, toMs: a + BLIP_MS, expected: false }))
  const last = Math.max(...at)
  if (last >= nowMs - RECENT_ACTIVITY_MS) out.push({ fromMs: last, toMs: Math.max(nowMs, last + BLIP_MS), expected: false })
  return out
}

/** The presence clipped to one BRT day. */
export function pieceDayPresence(p: CalPiece, day: string, nowMs: number): CalPresence[] {
  const d0 = brtDayStartMs(day), d1 = d0 + 86_400_000
  return piecePresence(p, nowMs).flatMap(b => {
    const from = Math.max(b.fromMs, d0), to = Math.min(b.toMs, d1)
    return to > from ? [{ fromMs: from, toMs: to, expected: b.expected }] : []
  })
}

const touches = (p: CalPiece, f: CalFilters, nowMs: number): boolean => {
  if (f.fromMs === undefined && f.toMs === undefined) return true
  return piecePresence(p, nowMs).some(b => b.toMs > (f.fromMs ?? -Infinity) && b.fromMs <= (f.toMs ?? Infinity))
}

export function pieceMatches(p: CalPiece, f: CalFilters, nowMs: number = Date.now()): boolean {
  if ((f.tasks ?? 'active') === 'active' && !p.active) return false
  if (f.task) {
    const q = f.task.toLowerCase()
    if (p.taskId !== f.task && !p.taskTitle.toLowerCase().includes(q)) return false
  }
  if (f.subtaskId && p.subtaskId !== f.subtaskId) return false
  if (f.versions?.length && (!p.version || !f.versions.includes(p.version))) return false
  if (f.stages?.length && !f.stages.includes(p.stage)) return false
  if (f.harnesses?.length && (!p.harness || !f.harnesses.includes(p.harness))) return false
  if (f.priorities?.length && (!p.priority || !f.priorities.includes(p.priority))) return false
  if (f.confirmedOnly && !p.confirmed) return false
  return touches(p, f, nowMs)
}

export interface CalendarView { pieces: CalPiece[]; versions: CalVersion[]; marks: CalMark[] }

/**
 * The calendar the filters leave. A version is kept when one of its kept pieces rides it; a version whose pieces
 * are ALL history (none active) is context and stays only while nothing narrows by task, stage, harness or
 * priority — narrowing by those is a question about pieces, not about releases.
 */
export function filterCalendar(reply: CalendarReply, f: CalFilters = {}): CalendarView {
  const pieces = reply.pieces.filter(p => pieceMatches(p, f, reply.nowMs))
  const keep = new Set(pieces.map(p => p.key))
  const narrowsPieces = !!(f.task || f.subtaskId || f.stages?.length || f.harnesses?.length || f.priorities?.length || f.confirmedOnly)
  const versions = reply.versions.filter(v => {
    if (f.versions?.length && !f.versions.includes(v.version)) return false
    if (v.pieceKeys.some(k => keep.has(k))) return true
    const hasActive = reply.pieces.some(p => p.version === v.version && p.active)
    if (hasActive || narrowsPieces) return false
    if (f.confirmedOnly && v.basis !== 'published') return false
    const at = v.atMs
    if (f.fromMs !== undefined || f.toMs !== undefined) return at !== null && at >= (f.fromMs ?? -Infinity) && at <= (f.toMs ?? Infinity)
    return true
  })
  const taskIds = new Set(pieces.map(p => p.taskId))
  const marks = reply.marks.filter(m => {
    if (m.kind === 'task-due') {
      if (narrowsPieces || (f.tasks ?? 'active') === 'active') { if (!taskIds.has(m.taskId)) return false }
      const at = brtDayStartMs(m.day)
      return (f.fromMs === undefined || at + 86_400_000 > f.fromMs) && (f.toMs === undefined || at <= f.toMs)
    }
    return (f.fromMs === undefined || m.atMs >= f.fromMs) && (f.toMs === undefined || m.atMs <= f.toMs)
  })
  return { pieces, versions, marks }
}

// ---------------------------------------------------------------------------------------------- .ics

const icsStamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
const icsEscape = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')

/** RFC 5545 text of the filtered view: one event per publication (real or expected) and per version. */
export function calendarToIcs(view: CalendarView, nowMs: number): string {
  const ev = (uid: string, at: number, summary: string, desc: string) => [
    'BEGIN:VEVENT', `UID:${uid}@agentistics`, `DTSTAMP:${icsStamp(nowMs)}`, `DTSTART:${icsStamp(at)}`, `DTEND:${icsStamp(at + 30 * 60_000)}`,
    `SUMMARY:${icsEscape(summary)}`, `DESCRIPTION:${icsEscape(desc)}`, 'END:VEVENT',
  ]
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//agentistics//delivery-calendar//EN', 'CALSCALE:GREGORIAN']
  for (const v of view.versions) {
    if (v.atMs === null) continue
    lines.push(...ev(`v-${v.version}`, v.atMs, `${v.version} · ${v.state === 'published' ? 'published' : 'expected'}`, `${v.pieceKeys.length} piece(s)`))
  }
  for (const p of view.pieces) {
    const at = p.publishedAtMs ?? (p.publishEta.kind === 'estimate' ? p.publishEta.atMs : null)
    if (at === null) continue
    lines.push(...ev(`p-${p.key}`, at, `${p.title}${p.version ? ` · ${p.version}` : ''}`, `${p.taskTitle} · ${p.stage}${p.publishedAtMs === null ? ' · expected' : ''}`))
  }
  lines.push('END:VCALENDAR')
  return lines.join('\r\n') + '\r\n'
}
