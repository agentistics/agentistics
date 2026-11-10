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
 *  - The ETA always names its evidence: comparable publication median, general average,
 *    low-confidence session work span, or a versioned initial planning range. Open pieces
 *    retain an interval even with no history or after overrunning their original range.
 */

import { migratePriority, subtaskDone, type Subtask, type Task, type TaskEvent } from './task-model'
import type { PieceTimes } from './task-times'
import type { TaskDetail } from './task-report'
import { ANTIGA_AFTER_MS, isAntiga } from '../delivery/antigas'
import { deriveStep, mergeStep, type SessionActivity, type StepRecord } from './task-live-steps'

export type LiveStage = 'queue' | 'blocked' | 'running' | 'qa' | 'adjust' | 'leader' | 'merge' | 'ci' | 'completed' | 'published'
export const LIVE_STAGES: readonly LiveStage[] = ['queue', 'blocked', 'running', 'qa', 'adjust', 'leader', 'merge', 'ci', 'completed', 'published']

/** The happy path a piece follows once it runs; `adjust` and `blocked` are detours that return to it. */
export const HAPPY_PATH: readonly LiveStage[] = ['running', 'qa', 'leader', 'merge', 'ci', 'published']

export const MIN_SAMPLES = 3
export const FORECAST_METHOD_VERSION = 'registration-forecast-v1'
export const FORECAST_SAMPLE_CAP = 500
export const FORECAST_WINDOW_MS = 90 * 24 * 3600_000
export const FORECAST_MIN_REMAINING_MS = 15 * 60_000
export const FORECAST_BUCKET_MS = 3600_000
export const FORECAST_BOOTSTRAP = { centerMs: 4 * 3600_000, lowerMs: 3600_000, upperMs: 12 * 3600_000 } as const
export type ForecastScope = 'type-harness-model' | 'type-harness' | 'harness-model' | 'harness' | 'general' | 'bootstrap' | 'stages'
export interface ForecastBasis {
  n: number; scope: ForecastScope; harness: string; model: string | null; medianMs: number
  endpoint?: 'publication' | 'work-span' | 'stage'; statistic?: 'median' | 'mean' | 'bootstrap' | 'sum'
  exclusions?: Readonly<Record<string, number>>
}
export interface ForecastMetadata {
  earliestAtMs: number; latestAtMs: number; computedAtMs: number; methodVersion: string
  confidence: 'low' | 'medium' | 'high'; basis: ForecastBasis
  overrun: boolean; conditional: 'blocked' | null
  assumption: 'started' | 'if-started-now' | 'scheduled-start' | 'after-resumption'
  queueTimeUnknown: boolean; blockReason: string | null; overrunAnchorAtMs?: number
}
/** A published piece stays on the line this long. */
export const PUBLISHED_WINDOW_MS = 24 * 3600_000
/** Published pieces older than 24 h stay readable (Publicado's longer periods), up to this many days back… */
export const HISTORY_DAYS = 365
/** …and at most this many published history pieces (the newest). Actionable old reviews are not capped. */
export const HISTORY_CAP = 400

export type LiveEta =
  | ({
      kind: 'estimate'
      atMs: number
      plusMinusMs: number
      confidence: 'low' | 'medium' | 'high'
      basis: ForecastBasis
    } & Partial<ForecastMetadata>)
  | { kind: 'none'; reason: 'no-history' | 'not-started' | 'beyond-range' }

/** Why a piece is blocked (fluxo-entrega-dsl §Bloqueio) and who can lift it. */
export type BlockReason = 'dependencia' | 'pedido_de_bloqueio' | 'limite' | 'maquina' | 'externo' | 'fora_das_autorizacoes' | 'decisao_do_dono'
export interface LiveBlock {
  reason: BlockReason
  /** The reason as the book states it, when it says more than the code. */
  text: string | null
  unlocker: 'leader' | 'owner' | 'self'
  /** The stage it returns to, when the activity log says where it came from. */
  originStage: LiveStage | null
}

/** One visit to a stage, from the activity log. `ms` runs to now for the stage the piece is in. */
export interface StageVisit { stage: LiveStage; enteredMs: number; ms: number }

export type LiveStageEta =
  | ({ kind: 'estimate'; atMs: number; medianMs: number; n: number; nextStage: LiveStage | null } & Partial<ForecastMetadata>)
  | { kind: 'none'; reason: 'no-history' | 'beyond-range' | 'not-started' | 'final'; typicalMs?: number; n?: number }
export type LivePublishEta =
  | ({ kind: 'estimate'; atMs: number; source: 'stages' | 'total' | 'general' | 'bootstrap' | 'revised-overrun'; n: number; parts: { stage: LiveStage; medianMs: number }[] } & Partial<ForecastMetadata>)
  | { kind: 'none'; reason: 'no-history' | 'beyond-range' | 'not-started' | 'final' }

/**
 * The release signal of a piece in "CI · publicando", exactly as the delivery flow states it. The
 * Live only RENDERS it: the piece moves to Publicado when `releaseGreen` and `tagPublished` are both
 * true, and the flow — not this view — decides that.
 */
export interface LiveCiSignal { mergedMain: boolean; releaseGreen: boolean; tagPublished: boolean; tag: string | null; pr: number | null }

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
  /** Current stage round, from the session start or stage entry; shared by Web and MCP. */
  round?: { number: number; startedAtMs: number | null }
  /** Earliest session start; null when nothing is filed. */
  startedAtMs: number | null
  /** Registry ids of the sessions that have not ended — what the browser joins to the fleet. */
  sessionIds: string[]
  harnesses: string[]
  models: string[]
  eta: LiveEta
  /** Real work of THIS piece (union of its sessions' active time), never the task's age. Null when unmeasured. */
  workMs: number | null
  /** Reasoning efforts the piece's sessions ran with, when the harness has the concept. */
  efforts: string[]
  /** Stage visits from the activity log, oldest first. Empty when the log has none. */
  trail: StageVisit[]
  /** Estimated time to LEAVE the current stage, and when the piece reaches Publicado. */
  stageEta: LiveStageEta
  publishEta: LivePublishEta
  block: LiveBlock | null
  /** "Antiga sem registro" (`delivery/antigas.ts`): shown (marked "antiga") only in "Tudo", where its group decides it in one click. */
  old?: boolean
  /** An old card only: what the last reconcile suspects shipped it. Weak evidence: it moved nothing, the person may accept it. */
  suggestion?: { repo: string; pr: number; tag?: string; via: string }
  /** Only in the CI stage, and only when the flow stated it. */
  ci: LiveCiSignal | null
  /** The 1-based step the piece reported inside its CURRENT stage (a `step` event); null = nobody said, show nothing. */
  step: number | null
  /**
   * Where `step` came from: `reported` (the worker/flow stated it, `step` event) or `signals` (observed — an edit, a test
   * run, a commit, the delivery record's gates; `stepSignal` names which). Null with `step`.
   */
  stepSource?: 'reported' | 'signals' | null
  stepSignal?: string | null
  /** The newest thing the log says about this piece, short. Null when nothing is recorded. */
  lastAction: { text: string; atMs: number; kind?: string; from?: string; to?: string } | null
  blockedReason: string | null
  /**
   * The piece's stated priority (urgent | high | medium | low), inherited from the task when absent.
   * Never `none`: an unset priority reads as `low` everywhere (`migratePriority`).
   */
  priority: 'urgent' | 'high' | 'medium' | 'low'
  /** Set once a published piece leaves the line. */
  deliveredAtMs: number | null
  /**
   * FLUXO.ENTREGA-DSL: the pre-dispatch the piece will start with ("Na fila": harness · model · effort · account),
   * read off the subtask's staged session. Absent fields are null — never guessed.
   */
  staged?: { harness: string | null; model: string | null; effort: string | null; account: string | null } | null
  /** The `vaga` gate's last verdict on the delivery record — the expected slot. Null = not checked yet. */
  slot?: { ok: boolean; reason: string | null; at: string } | null
  /** The delivery record's own phase (the state machine), when the piece has one — the stage is its projection. */
  phase?: string | null
  /** A human gate the owner was ASKED about and has not answered at this revision (autonomous mode OFF). The Live card offers approve / reject for it. */
  awaitingApproval?: { phase: string } | null
  /**
   * FILA.PRIORIDADE — only a queued piece: why it is not starting. `hold` = the leader said `nao` (reason) or `agendar`
   * (starts at `until`); `asking` = the question is open with the leader; `approved` = `sim` given, waiting for a slot.
   * Null/absent = just waiting its turn.
   */
  queue?: { hold: { kind: 'nao' | 'agendar'; reason: string; until: string | null; by: string; atMs: number | null } | null; asking: boolean; approved: boolean } | null
}

/** PURE: the queue facts a card shows from the delivery record (a lapsed `agendar` is no hold any more). */
export function queueOfRecord(rec: { queueHold?: { kind: 'nao' | 'agendar'; reason: string; at: string; actor: string; until?: string }; queueAsk?: { approved?: unknown } } | undefined, nowMs: number): LiveDelivery['queue'] {
  if (!rec) return null
  const h = rec.queueHold
  const until = h?.until ? Date.parse(h.until) : NaN
  const active = h && (h.kind === 'nao' || (Number.isFinite(until) && until > nowMs))
  const asking = Boolean(rec.queueAsk && !rec.queueAsk.approved)
  const approved = Boolean(rec.queueAsk?.approved)
  if (!active && !asking && !approved) return null
  return {
    hold: active && h ? { kind: h.kind, reason: h.reason, until: h.until ?? null, by: h.actor, atMs: Date.parse(h.at) || null } : null,
    asking, approved,
  }
}

/** A piece the line considered and left off, with the reason — so a card never disappears without a word. */
export type HiddenReason = 'no-live-session' | 'status-unplaced' | 'published-old' | 'queue-idle' | 'legacy-review-old'
export interface LiveHidden { key: string; taskId: string; /** The subtask (absent for a task-level piece): what the "Antigas" actions are addressed to. */ subtaskId?: string; title: string; stage: LiveStage | null; reason: HiddenReason; atMs: number | null }

export interface LiveReply {
  generatedAt: string
  deliveries: LiveDelivery[]
  /** Published more than 24 h ago (≤ HISTORY_DAYS days, ≤ HISTORY_CAP pieces), newest first — read by Publicado's longer periods. */
  history?: LiveDelivery[]
  /** How many such pieces exist BEFORE the HISTORY_CAP cut (the list above holds at most the cap). */
  historyTotal?: number
  /** Same, for `oldReviews`. */
  oldReviewsTotal?: number
  /** The pieces the cap CUT, per task (title kept for a name filter): what a task/stage filter may say is missing. */
  cutByTask?: Record<string, { title: string; history: number; oldReviews: number }>
  /** Legacy reviews nobody is on (full pieces marked `old`): drawn only by the "Tudo" tab. */
  oldReviews?: LiveDelivery[]
  /** Pieces left off the line and why (bounded, NEWEST first — the ones that just left are the ones somebody asks about). */
  hidden: LiveHidden[]
  /** Live session id -> the task it is filed on, so a view can ask "which task is this session's". */
  sessionTasks: Record<string, string>
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
    case 'blocked': return 'blocked'
    case 'in_review': return 'leader'
    case 'done': return 'published'
    default: break
  }
  const t = `${words(status)} ${words(label ?? '')}`
  if (/\bqa\b|\btest/.test(t)) return 'qa'
  if (/ajust|adjust|\bfix|rework|retrab/.test(t)) return 'adjust'
  if (/review|revis/.test(t)) return 'leader'
  if (/\bci\b|publicando|publishing/.test(t)) return 'ci'
  if (/merge|\bpr\b|pull.?request/.test(t)) return 'merge'
  if (/publish|publicad|releas|shipped/.test(t)) return 'published'
  if (/progress|andamento|doing|executando|running/.test(t)) return 'running'
  if (/todo|backlog|queue|fila/.test(t)) return 'queue'
  return null
}

// A WHOLE word ("[ LÍDER ] - Motor", "Leader of X"), never a substring: "Leaderboard UI" is a worker.
const LEADER_NAME = /(^|[^\p{L}])(l[ií]der|leader)([^\p{L}]|$)/iu
// A registry heartbeat older than this means the session is not being seen any more (a reboot leaves a `lost` row with no endedAt).
const STALE_HEARTBEAT_MS = 10 * 60_000
const QA_NAME =/(^|[^a-z])qa([^a-z]|$)|\bquality\b/i

/** The stored session role (`session-roles.ts`); a session that has one is never read as the QA's by its NAME. */
export type StoredRoleOf = (s: { id: string; conversationId?: string }) => string | undefined
/** QA by name — only the fallback, and only for a session with no stored leader/worker role. */
const isQaName = (s: { label?: string; role?: string }): boolean => !!s.label && s.role !== 'leader' && s.role !== 'worker' && QA_NAME.test(s.label)

interface PieceSession { id: string; harness: string; model: string | null; effort?: string; label?: string; role?: string; live: boolean; seenMs?: number; startMs: number | null; activity?: SessionActivity }

// ---------------------------------------------------------------------------------- ETA

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 1) return sorted[0]!
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos), hi = Math.ceil(pos)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

export interface Sample {
  harness: string; model: string | null; durationMs: number; taskType?: string | null
  key?: string; endpoint?: 'publication' | 'work-span'; startedAtMs?: number; completedAtMs?: number
  abandoned?: boolean; recovered?: boolean; rollup?: boolean
  /** Blocked waits are included in durationMs, retained for diagnostics. */
  blockReasons?: readonly string[]
}
interface Distribution { center: number; lower: number; upper: number; confidence: ForecastMetadata['confidence']; basis: ForecastBasis }
export interface ForecastCohorts {
  sampleCount: number
  samples: readonly Sample[]
  exclusions: Readonly<Record<string, number>>
  distributions: ReadonlyMap<string, Distribution>
}
const cohortKey = (endpoint: string, scope: ForecastScope, type: string | null, harness: string | null, model: string | null) =>
  JSON.stringify([endpoint, scope, type, harness, model])

function distribution(xs: readonly number[], basis: ForecastBasis): Distribution {
  const sorted = [...xs].sort((a, b) => a - b)
  const median = quantile(sorted, 0.5), p25 = quantile(sorted, 0.25), p75 = quantile(sorted, 0.75)
  const general = basis.scope === 'general'
  const center = general ? sorted.reduce((a, b) => a + b, 0) / sorted.length : median
  let lower = general ? Math.min(p25, center / 2) : Math.min(p25, center - Math.max(center / 4, FORECAST_MIN_REMAINING_MS))
  let upper = general ? Math.max(p75, center * 2) : Math.max(p75, center + Math.max(center / 4, FORECAST_MIN_REMAINING_MS))
  if (general && (xs.length < 8 || basis.endpoint === 'work-span')) {
    lower = Math.min(lower, center / 4); upper = Math.max(upper, center * 3)
  }
  const spread = (p75 - p25) / median
  const confidence = general ? 'low' : xs.length >= 8 && spread < 0.6 ? 'high' : xs.length >= 4 && spread < 1.2 ? 'medium' : 'low'
  return { center, lower: Math.max(0, lower), upper, confidence,
    basis: { ...basis, medianMs: median, statistic: general ? 'mean' : 'median' } }
}

/** PURE: validate/dedupe/bound once, then sort distributions once per source revision. */
export function buildForecastCohorts(samples: Iterable<Sample>, nowMs: number): ForecastCohorts {
  const exclusions = { invalid: 0, outsideWindow: 0, abandoned: 0, recovered: 0, rollup: 0, duplicate: 0, capped: 0 }
  const bounded: Sample[] = []
  for (const s of samples) {
    if (s.abandoned) { exclusions.abandoned++; continue }
    if (s.recovered) { exclusions.recovered++; continue }
    if (s.rollup) { exclusions.rollup++; continue }
    if (!Number.isFinite(s.durationMs) || s.durationMs <= 0 ||
      s.startedAtMs === undefined || s.completedAtMs === undefined ||
      (s.completedAtMs !== undefined && (!Number.isFinite(s.completedAtMs) || s.completedAtMs <= 0 || s.completedAtMs > nowMs)) ||
      (s.startedAtMs !== undefined && (!Number.isFinite(s.startedAtMs) || s.startedAtMs <= 0 || s.completedAtMs === undefined || s.startedAtMs >= s.completedAtMs ||
        Math.abs(s.completedAtMs - s.startedAtMs - s.durationMs) > 1))) {
      exclusions.invalid++; continue
    }
    if (s.completedAtMs !== undefined && s.completedAtMs < nowMs - FORECAST_WINDOW_MS) { exclusions.outsideWindow++; continue }
    const duplicate = s.key ? bounded.findIndex(x => x.key === s.key) : -1
    if (duplicate >= 0) {
      exclusions.duplicate++
      if ((bounded[duplicate]!.completedAtMs ?? 0) >= (s.completedAtMs ?? 0)) continue
      bounded.splice(duplicate, 1)
    }
    // Keep only the newest 500 while scanning. No lifetime-sized history sort or allocation.
    let lo = 0, hi = bounded.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if ((bounded[mid]!.completedAtMs ?? 0) >= (s.completedAtMs ?? 0)) lo = mid + 1
      else hi = mid
    }
    bounded.splice(lo, 0, s)
    if (bounded.length > FORECAST_SAMPLE_CAP) { bounded.pop(); exclusions.capped++ }
  }
  const pools = new Map<string, { xs: number[]; basis: ForecastBasis }>()
  for (const s of bounded) {
    const endpoint = s.endpoint ?? 'work-span'
    const add = (scope: ForecastScope, type: string | null, harness: string | null, model: string | null) => {
      const key = cohortKey(endpoint, scope, type, harness, model)
      let pool = pools.get(key)
      if (!pool) { pool = { xs: [], basis: { n: 0, scope, harness: harness ?? '', model, medianMs: 0, endpoint, exclusions } }; pools.set(key, pool) }
      pool.xs.push(s.durationMs); pool.basis.n++
    }
    add('general', null, null, null)
    if (endpoint === 'work-span') continue
    if (s.taskType && s.model) add('type-harness-model', s.taskType, s.harness, s.model)
    if (s.taskType) add('type-harness', s.taskType, s.harness, null)
    add('harness', null, s.harness, null)
  }
  return { sampleCount: bounded.length, samples: bounded, exclusions,
    distributions: new Map([...pools].filter(([, p]) => p.xs.length >= MIN_SAMPLES).map(([k, p]) => [k, distribution(p.xs, p.basis)])) }
}

export interface EstimateOptions {
  nowMs: number
  startedAtMs: number | null
  harness: string | null
  model: string | null
  taskType?: string | null; samples?: readonly Sample[]; cohorts?: ForecastCohorts
  scheduledAtMs?: number | null; blocked?: boolean; blockReason?: string | null
  /** Persisted cache input. It is an hourly anchor, never a mutable prediction. */
  overrunAnchorAtMs?: number
}
function generalDistribution(c: ForecastCohorts): Distribution {
  return c.distributions.get(cohortKey('publication', 'general', null, null, null)) ??
    c.distributions.get(cohortKey('work-span', 'general', null, null, null)) ?? {
      center: FORECAST_BOOTSTRAP.centerMs, lower: FORECAST_BOOTSTRAP.lowerMs, upper: FORECAST_BOOTSTRAP.upperMs,
      confidence: 'low', basis: { n: 0, scope: 'bootstrap', endpoint: 'publication', harness: '', model: null, medianMs: FORECAST_BOOTSTRAP.centerMs,
        statistic: 'bootstrap', exclusions: c.exclusions },
    }
}
function selectDistribution(c: ForecastCohorts, o: EstimateOptions): Distribution {
  if (o.harness) {
    const keys = [
      ...(o.taskType && o.model ? [cohortKey('publication', 'type-harness-model', o.taskType, o.harness, o.model)] : []),
      ...(o.taskType ? [cohortKey('publication', 'type-harness', o.taskType, o.harness, null)] : []),
      cohortKey('publication', 'harness', null, o.harness, null),
    ]
    for (const key of keys) { const d = c.distributions.get(key); if (d) return d }
  }
  return generalDistribution(c)
}
type ForecastEstimate = Extract<LiveEta, { kind: 'estimate' }> & ForecastMetadata
function projectDistribution(d: Distribution, o: EstimateOptions, general: Distribution): ForecastEstimate {
  const unstarted = o.startedAtMs === null || o.blocked
  const scheduled = Number.isFinite(o.scheduledAtMs) ? Math.max(o.nowMs, o.scheduledAtMs!) : o.nowMs
  let anchor = unstarted ? (o.blocked ? o.nowMs : scheduled) : o.nowMs
  const elapsed = unstarted ? 0 : Math.max(0, o.nowMs - o.startedAtMs!)
  let lower = Math.max(FORECAST_MIN_REMAINING_MS, d.lower - elapsed)
  let upper = Math.max(lower + FORECAST_MIN_REMAINING_MS, d.upper - elapsed)
  let center = d.center - elapsed
  let basis = d.basis, confidence = d.confidence
  let overrunAnchorAtMs: number | undefined
  if (!unstarted && elapsed >= d.upper) {
    // A persisted boundary keeps its hourly phase across restarts/source refreshes. Without
    // one, derive a reproducible boundary from the original upper-bound crossing.
    const crossing = o.startedAtMs! + d.upper
    const boundary = crossing + Math.floor((o.nowMs - crossing) / FORECAST_BUCKET_MS) * FORECAST_BUCKET_MS
    const saved = o.overrunAnchorAtMs
    overrunAnchorAtMs = saved !== undefined && Number.isFinite(saved) && saved >= o.startedAtMs! && saved <= o.nowMs
      ? saved + Math.floor((o.nowMs - saved) / FORECAST_BUCKET_MS) * FORECAST_BUCKET_MS : boundary
    anchor = overrunAnchorAtMs
    lower = Math.max(FORECAST_MIN_REMAINING_MS, general.lower)
    upper = Math.max(lower + FORECAST_MIN_REMAINING_MS, general.upper * Math.min(4, 1 + (anchor - o.startedAtMs!) / d.upper))
    center = general.center; basis = general.basis; confidence = 'low'
  }
  center = Math.min(upper, Math.max(lower, center))
  return { kind: 'estimate', atMs: anchor + center, plusMinusMs: (upper - lower) / 2,
    earliestAtMs: anchor + lower, latestAtMs: anchor + upper, basis, confidence,
    computedAtMs: o.nowMs, methodVersion: FORECAST_METHOD_VERSION, overrun: !unstarted && elapsed >= d.center,
    conditional: o.blocked ? 'blocked' : null, blockReason: o.blockReason ?? null,
    assumption: o.blocked ? 'after-resumption' : unstarted ? (Number.isFinite(o.scheduledAtMs) ? 'scheduled-start' : 'if-started-now') : 'started',
    queueTimeUnknown: !!unstarted && !o.blocked && !Number.isFinite(o.scheduledAtMs),
    ...(overrunAnchorAtMs !== undefined ? { overrunAnchorAtMs } : {}) }
}

/** PURE: an approximation always exists, including cold starts and overruns. */
export function estimateEta(o: EstimateOptions): ForecastEstimate {
  const c = o.cohorts ?? buildForecastCohorts(o.samples ?? [], o.nowMs)
  return projectDistribution(selectDistribution(c, o), o, generalDistribution(c))
}


// ------------------------------------------------------------------------------------ blocks

const BLOCK_CODES: readonly BlockReason[] = ['dependencia', 'pedido_de_bloqueio', 'limite', 'maquina', 'externo', 'fora_das_autorizacoes', 'decisao_do_dono']

/**
 * PURE: the block a piece sits in. A reason written as `<code>: text` is exact; otherwise the words
 * are matched (the rules worker will stamp the code, this reads either). A sibling dependency is its
 * own reason and unblocks by itself; everything the rules do not reserve for the owner is the leader's.
 */
export function blockOf(o: { text: string | null; dependsOn: number; originStage: LiveStage | null }): LiveBlock {
  const raw = (o.text ?? '').trim()
  const coded = /^([a-z_]+)\s*[:\-–]\s*([\s\S]*)$/i.exec(raw)
  let reason: BlockReason | null = null
  let text: string | null = raw || null
  if (coded && BLOCK_CODES.includes(coded[1]!.toLowerCase() as BlockReason)) {
    reason = coded[1]!.toLowerCase() as BlockReason
    text = coded[2]!.trim() || null
  }
  if (!reason && o.dependsOn > 0) reason = 'dependencia'
  if (!reason) {
    const t = raw.toLowerCase()
    if (/limite|limit|quota|login|rate/.test(t)) reason = 'limite'
    else if (/mem[oó]ria|m[aá]quina|machine|\block\b|\bram\b/.test(t)) reason = 'maquina'
    else if (/\bci\b|github|infra|release|externo|external/.test(t)) reason = 'externo'
    else if (/dono|owner|apple|credencial|credential|assinatura|pagamento|payment/.test(t)) reason = 'decisao_do_dono'
    else reason = 'pedido_de_bloqueio'
  }
  const unlocker: LiveBlock['unlocker'] = reason === 'decisao_do_dono' ? 'owner' : reason === 'dependencia' ? 'self' : 'leader'
  return { reason, text, unlocker, originStage: o.originStage }
}


/** PURE: the CI signal a piece carries, trusted only in its exact shape. */
export function ciSignalOf(raw: unknown): LiveCiSignal | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const b = (k: string) => o[k] === true
  return {
    mergedMain: o.mergedMain === undefined ? true : b('mergedMain'),
    releaseGreen: b('releaseGreen'), tagPublished: b('tagPublished'),
    tag: typeof o.tag === 'string' && o.tag ? o.tag : null,
    pr: typeof o.pr === 'number' && Number.isFinite(o.pr) ? o.pr : null,
  }
}

/** PURE: the newest reported step of the current stage, from `step` events recorded since the stage began. */
export function stepOf(events: readonly TaskEvent[], sinceMs: number | null): number | null {
  let best: { at: number; step: number } | null = null
  for (const e of events) {
    if (e.kind !== 'step') continue
    const at = Date.parse(e.at)
    const n = Number.parseInt(e.to ?? e.detail ?? '', 10)
    if (!Number.isFinite(at) || !Number.isFinite(n) || n < 1) continue
    if (sinceMs !== null && at < sinceMs) continue
    if (!best || at >= best.at) best = { at, step: n }
  }
  return best?.step ?? null
}

// ------------------------------------------------------------------------------------ trail

/** PURE: the stage visits of one piece from its `status` events (oldest first); the last runs to `nowMs`. */
export function trailOf(
  events: readonly TaskEvent[], nowMs: number, statusLabel?: (id: string) => string | undefined,
): StageVisit[] {
  const moves = events
    .filter(e => e.kind === 'status' && e.to)
    .map(e => ({ at: ms(e.at), stage: stageOfStatus(e.to!, statusLabel?.(e.to!)) }))
    .filter((m): m is { at: number; stage: LiveStage } => m.at !== null && m.stage !== null)
    .sort((a, b) => a.at - b.at)
  const visits: StageVisit[] = []
  for (const m of moves) {
    const last = visits[visits.length - 1]
    if (last && last.stage === m.stage) continue
    if (last) last.ms = Math.max(0, m.at - last.enteredMs)
    visits.push({ stage: m.stage, enteredMs: m.at, ms: 0 })
  }
  const tail = visits[visits.length - 1]
  if (tail) tail.ms = Math.max(0, nowMs - tail.enteredMs)
  return visits
}

export interface StageTypical { medianMs: number; p25Ms?: number; p75Ms: number; n: number }

/** PURE: how long pieces typically sit in each stage, from the CLOSED visits of every piece. */
export function stageTypicals(trails: readonly (readonly StageVisit[])[]): Partial<Record<LiveStage, StageTypical>> {
  const by = new Map<LiveStage, number[]>()
  for (const t of trails) {
    for (let i = 0; i < t.length - 1; i++) {
      const v = t[i]!
      if (Number.isFinite(v.ms) && v.ms > 0) {
        const xs = by.get(v.stage) ?? []
        xs.push(v.ms); by.set(v.stage, xs)
      }
    }
  }
  const out: Partial<Record<LiveStage, StageTypical>> = {}
  for (const [stage, xs] of by) {
    if (xs.length < MIN_SAMPLES) continue
    const sorted = [...xs].sort((a, b) => a - b)
    out[stage] = { medianMs: Math.round(quantile(sorted, 0.5)), p25Ms: Math.round(quantile(sorted, 0.25)), p75Ms: Math.round(quantile(sorted, 0.75)), n: sorted.length }
  }
  return out
}

/** The stage a piece goes to next on the happy path; a detour returns to where it came from. */
export function nextStageOf(stage: LiveStage, origin: LiveStage | null = null): LiveStage | null {
  if (stage === 'published' || stage === 'completed') return null
  if (stage === 'queue') return 'running'
  if (stage === 'blocked') return origin ?? 'running'
  if (stage === 'adjust') return 'leader'
  const i = HAPPY_PATH.indexOf(stage)
  return i >= 0 ? HAPPY_PATH[i + 1] ?? null : null
}

/** PURE: the two estimates a card shows — leaving this stage, and reaching Publicado. */
export function estimateStages(o: {
  stage: LiveStage; origin: LiveStage | null; sinceMs: number | null; nowMs: number
  typicals: Partial<Record<LiveStage, StageTypical>>; totalEta: LiveEta
}): { stageEta: LiveStageEta; publishEta: LivePublishEta } {
  const { stage, nowMs } = o
  if (stage === 'published' || stage === 'completed') return { stageEta: { kind: 'none', reason: 'final' }, publishEta: { kind: 'none', reason: 'final' } }
  const next = nextStageOf(stage, o.origin)
  if (o.sinceMs === null) return { stageEta: { kind: 'none', reason: 'not-started' }, publishEta: totalOnly(o.totalEta) }
  const here = o.typicals[stage]
  const elapsed = nowMs - o.sinceMs
  let stageEta: LiveStageEta
  if (!here) stageEta = { kind: 'none', reason: 'no-history' }
  else if (here.n < MIN_SAMPLES || elapsed >= stageDistribution(here).upper) stageEta = { kind: 'none', reason: 'beyond-range', typicalMs: here.medianMs, n: here.n }
  else {
    const estimate = projectDistribution(stageDistribution(here), {
      nowMs, startedAtMs: o.sinceMs, harness: null, model: null,
    }, stageDistribution(here))
    stageEta = { ...estimate, medianMs: here.medianMs, n: here.n, nextStage: next }
  }

  // Publication: the rest of the current stage plus every stage still ahead; any stage with no
  // history makes the sum unknowable, so the whole-piece estimate answers instead (and says so).
  const ahead: LiveStage[] = []
  for (let s: LiveStage | null = next; s && s !== 'published'; s = nextStageOf(s, null)) ahead.push(s)
  const parts = ahead.map(s => ({ stage: s, medianMs: o.typicals[s]?.medianMs ?? NaN }))
  if (stageEta.kind === 'estimate' && parts.every(p => Number.isFinite(p.medianMs) && o.typicals[p.stage]!.n >= MIN_SAMPLES)) {
    const n = Math.min(here!.n, ...ahead.map(s => o.typicals[s]!.n))
    const components = [stageDistribution(here!), ...ahead.map(s => stageDistribution(o.typicals[s]!))]
    const confidence = components.some(c => c.confidence === 'low') ? 'low' : components.some(c => c.confidence === 'medium') ? 'medium' : 'high'
    const atMs = stageEta.atMs + parts.reduce((a, p) => a + p.medianMs, 0)
    return {
      stageEta,
      publishEta: { ...stageEta, kind: 'estimate', atMs, source: 'stages', n, parts,
        earliestAtMs: stageEta.earliestAtMs! + components.slice(1).reduce((a, c) => a + c.lower, 0),
        latestAtMs: stageEta.latestAtMs! + components.slice(1).reduce((a, c) => a + c.upper, 0), confidence,
        basis: { n, scope: 'stages', endpoint: 'stage', statistic: 'sum', harness: '', model: null,
          exclusions: o.totalEta.kind === 'estimate' ? o.totalEta.basis.exclusions ?? {} : {},
          medianMs: components.reduce((a, c) => a + c.center, 0) } },
    }
  }
  return { stageEta, publishEta: totalOnly(o.totalEta, stageEta) }
}

/**
 * The whole-piece estimate as a publication time. It can never come BEFORE the next stage's own estimate
 * (publication is the end of the line, the next stage a step on it). A missing/overrun stage
 * estimate never suppresses the whole-piece fallback.
 */
function totalOnly(eta: LiveEta, stageEta?: LiveStageEta): LivePublishEta {
  if (eta.kind === 'estimate') {
    const floor = stageEta?.kind === 'estimate' ? stageEta.atMs : 0
    const atMs = Math.max(eta.atMs, floor)
    return { ...eta, kind: 'estimate', atMs,
      ...(eta.latestAtMs === undefined ? {} : { latestAtMs: Math.max(eta.latestAtMs, atMs) }),
      source: eta.overrunAnchorAtMs !== undefined ? 'revised-overrun' : eta.basis.scope === 'bootstrap' ? 'bootstrap' : eta.basis.scope === 'general' ? 'general' : 'total',
      n: eta.basis.n, parts: [] }
  }
  return { kind: 'none', reason: eta.reason }
}

function stageDistribution(t: StageTypical): Distribution {
  const half = Math.max(t.medianMs / 4, FORECAST_MIN_REMAINING_MS)
  const p25 = t.p25Ms ?? t.medianMs
  const ratio = (t.p75Ms - p25) / t.medianMs
  return { center: t.medianMs, lower: Math.max(0, Math.min(p25, t.medianMs - half)),
    upper: Math.max(t.p75Ms, t.medianMs + half),
    confidence: t.n >= 8 && ratio < 0.6 ? 'high' : t.n >= 4 && ratio < 1.2 ? 'medium' : 'low',
    basis: { n: t.n, scope: 'stages', endpoint: 'stage', statistic: 'median', harness: '', model: null, medianMs: t.medianMs, exclusions: {} } }
}

/** One publication projection, reusable by Live, Calendar and dispatch snapshot callers. */
export function resolvePieceForecast(o: EstimateOptions & {
  stage: LiveStage; origin: LiveStage | null; sinceMs: number | null
  typicals: Partial<Record<LiveStage, StageTypical>>
}): { eta: LiveEta; stageEta: LiveStageEta; publishEta: LivePublishEta } {
  if (o.stage === 'published' || o.stage === 'completed') {
    return { eta: { kind: 'none', reason: 'not-started' }, stageEta: { kind: 'none', reason: 'final' }, publishEta: { kind: 'none', reason: 'final' } }
  }
  const total = estimateEta({ ...o, startedAtMs: o.stage === 'queue' ? null : o.startedAtMs, blocked: o.stage === 'blocked' })
  if (o.stage === 'queue' || o.startedAtMs === null) {
    return { eta: total, stageEta: { kind: 'none', reason: 'not-started' }, publishEta: totalOnly(total) }
  }
  const result = estimateStages({ ...o, totalEta: total })
  const p = result.publishEta
  // Blocking has no known resumption date. Do not subtract the blocked wait or compose a
  // running stage across it; keep the conditional whole-piece interval instead.
  if (o.stage === 'blocked') return { eta: total, stageEta: result.stageEta, publishEta: totalOnly(total) }
  if (p.kind === 'estimate' && p.source === 'stages') {
    return { ...result, eta: { ...total, ...p, plusMinusMs: (p.latestAtMs! - p.earliestAtMs!) / 2 } }
  }
  return { ...result, eta: p.kind === 'estimate' ? { ...total, ...p } : total }
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
  /** Unfinished dependencies (sibling subtasks / blocking tasks) the book names. */
  dependsOn: number
  /** The task's comments (each with its own `subtaskId`) — the real data keeps a legacy piece's delivered commit in its handback comment. */
  comments: readonly { subtaskId?: string; body: string; createdAt: string; kind?: string }[]
  hasOpenChildren?: boolean
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

function piecesOf(d: TaskDetail, roleOf?: StoredRoleOf, includeMembers = false): Piece[] {
  const sessionsOf = (subtaskId: string | null): PieceSession[] =>
    d.sessions
      .filter(s => (s.subtaskId ?? null) === subtaskId && !s.historical)
      .map(s => ({
        id: s.id, harness: s.harness, model: s.model, ...(s.label ? { label: s.label } : {}),
        ...(roleOf ? (() => { const r = roleOf({ id: s.id, ...(s.conversationId ? { conversationId: s.conversationId } : {}) }); return r ? { role: r } : {} })() : {}),
        ...(s.effort ? { effort: s.effort } : {}),
        live: !s.endedAt, startMs: ms(s.createdAt),
        ...(typeof s.lastSeenMs === 'number' && Number.isFinite(s.lastSeenMs) ? { seenMs: s.lastSeenMs } : {}),
        ...(s.activity ? { activity: s.activity } : {}),
      }))
  const timesOf = (id: string | null) => d.subtaskRollups.find(r => r.id === id)?.times
  const subs = includeMembers ? d.subtasks : d.subtasks.filter(s => !s.parentGroupId)
  const out: Piece[] = subs.map(s => ({
    task: d.task, sub: s, status: s.status, updatedAt: s.updatedAt,
    ...(s.deliveredAt ? { deliveredAt: s.deliveredAt } : {}),
    times: timesOf(s.id), sessions: sessionsOf(s.id),
    blockedReason: null,
    dependsOn: (s.blockedBy ?? []).filter(id => d.subtasks.some(x => x.id === id && !subtaskDone(x.status))).length,
    comments: d.comments,
    hasOpenChildren: d.subtasks.some(child => child.parentGroupId === s.id && !subtaskDone(child.status)),
  }))
  // Sessions filed on the task itself stand for a piece of their own; a task with NO subtasks is
  // that piece. A task that has subtasks and also direct sessions gets the extra piece only while
  // one of those sessions is alive (an ended direct session is history, not a delivery).
  const direct = sessionsOf(null)
  const openChildren = d.subtasks.some(s => !subtaskDone(s.status))
  if (subs.length === 0 || direct.some(s => s.live)) {
    out.push({
      task: d.task, sub: null, status: d.task.status === 'in_review' && openChildren ? 'in_progress' : d.task.status, updatedAt: d.task.updatedAt,
      ...(d.task.deliveredAt ? { deliveredAt: d.task.deliveredAt } : {}),
      times: timesOf(null) ?? d.times, sessions: direct,
      blockedReason: d.task.blockedReason ?? null,
      dependsOn: (d.task.blockedBy ?? []).length,
      comments: d.comments,
      hasOpenChildren: openChildren,
    })
  }
  return out
}

const SHA_AT = /(?:\bsha\b|\bcommit\b|@)\s*[:=]?\s*`?([0-9a-f]{7,40})\b/gi
/** PURE: the commit ids a piece's own words name ("sha 41c5466", "commit 9f3a…"); a hex word with no digit is a word, not a sha. */
export function shasIn(text: string | null | undefined): string[] {
  if (!text) return []
  const out = new Set<string>()
  for (const m of text.matchAll(SHA_AT)) if (/\d/.test(m[1]!)) out.add(m[1]!.toLowerCase())
  return [...out]
}

/** The most hidden rows a reply carries — a bound, not a policy: the newest are the ones that just left. */
export const HIDDEN_CAP = 300
/** A legacy `in_review` piece (no delivery record) with no live session older than this is a candidate for "Antigas sem registro" (owner 08/11: 24 h; ONE constant with the reconcile, `delivery/antigas.ts`). */
export const LEGACY_REVIEW_MS = ANTIGA_AFTER_MS
/** A piece untouched for longer than this was not on the board a moment ago, so its absence is not a departure. */
export const RECENT_HIDDEN_MS = 6 * 3600_000

/** What the Live reads off a delivery record (`delivery/machine.ts`), kept structural so this module stays pure. */
export interface LiveDeliveryFacts {
  phase: string
  dequeued?: { reason: string }
  origin?: string
  block?: { reason: string; text: string }
  ci?: unknown
  /** When the release that shipped it was published (ISO) — the Publicado window starts here when the record says so. */
  publishedAt?: string
  queueStarted?: { at: string }
  history?: readonly { to: string; at: string }[]
  step?: number
  /** FILA.PRIORIDADE — the leader's `nao`/`agendar` and the open question (see `delivery/fila-proximo.ts`). */
  queueHold?: { kind: 'nao' | 'agendar'; reason: string; at: string; actor: string; until?: string }
  queueAsk?: { at: string; delivered: boolean; approved?: unknown }
  revision?: number
  humanGates?: string[]
  asked?: Record<string, number>
  approvals?: Record<string, { revision: number; decision: string }>
  /** The facts the observed steps read (`task-live-steps.ts`): gate verdicts, the pushed head, the QA session and verdict, the review, the PR. */
  gates?: Partial<Record<string, { ok: boolean; reason?: string; at: string }>>
  headSha?: string
  qaSessionId?: string
  qa?: { at: string }
  review?: { at: string }
  pr?: number
  mergeSha?: string
}

/** PURE: the human gate of this record waiting on an answer — asked at the CURRENT revision, not yet answered at it. */
export function awaitingApprovalOf(rec: LiveDeliveryFacts | undefined): { phase: string } | null {
  if (!rec?.humanGates?.length || rec.revision === undefined) return null
  for (const phase of rec.humanGates) {
    if (rec.asked?.[phase] !== rec.revision) continue
    if (rec.approvals?.[phase]?.revision === rec.revision) continue
    return { phase }
  }
  return null
}

/** PURE: the Live stage a delivery phase projects to. */
export const PHASE_STAGE: Readonly<Record<string, LiveStage>> = {
  fila: 'queue', executando: 'running', qa: 'qa', ajuste: 'adjust', revisao_lider: 'leader', pr_merge: 'merge', ci: 'ci', publicado: 'published', bloqueado: 'blocked',
}


/** PURE: the activity log indexed by the piece it is about (`<taskId>` or `<taskId>/<subtaskId>`). */
function indexEvents(details: readonly TaskDetail[], events: readonly TaskEvent[]): { lastBySubject: Map<string, TaskEvent>; eventsBySubject: Map<string, TaskEvent[]> } {
  const subtaskTitles = new Map<string, string>()
  for (const d of details) for (const sub of d.subtasks) {
    const key = `${sub.taskId}\0${sub.title}`
    if (subtaskTitles.has(key)) subtaskTitles.set(key, '')
    else subtaskTitles.set(key, sub.id)
  }
  const lastBySubject = new Map<string, TaskEvent>()
  const eventsBySubject = new Map<string, TaskEvent[]>()
  for (const e of events) {
    const subtaskId = eventSubtaskId(e, subtaskTitles)
    const subject = subtaskId ? `${e.taskId}/${subtaskId}` : e.taskId
    const prev = lastBySubject.get(subject)
    if (!prev || e.at >= prev.at) lastBySubject.set(subject, e)
    const list = eventsBySubject.get(subject)
    if (list) list.push(e); else eventsBySubject.set(subject, [e])
  }
  return { lastBySubject, eventsBySubject }
}

/**
 * The commit ids a LEGACY review piece (status `in_review`, no delivery record) names, as GROUPS: the piece is
 * published when ANY group is wholly inside a published release tag. A sha in the notes or in one log line is a
 * group of its own; the NEWEST comment on the piece that names any commit (its handback — the real data keeps the
 * delivered commit there, not in the notes) is one group, so a "base <sha>" beside the delivered one cannot
 * publish a piece whose own commit is not in a tag.
 */
function legacyShaGroups(p: Piece, events: readonly TaskEvent[] | undefined): string[][] {
  const groups: string[][] = [...shasIn(p.sub?.notes), ...(events ?? []).flatMap(e => shasIn(e.detail))].map(s => [s])
  let newest: { at: string; shas: string[] } | null = null
  for (const c of p.comments) {
    if ((c.subtaskId ?? null) !== (p.sub?.id ?? null)) continue
    const shas = shasIn(c.body)
    if (shas.length > 0 && (!newest || c.createdAt >= newest.at)) newest = { at: c.createdAt, shas }
  }
  if (newest) groups.push(newest.shas)
  return groups
}

/**
 * PURE: every commit id the legacy in-review pieces name, so the caller can ask git ONCE (cached) which of
 * them a published release tag contains and hand the answer back as `publishedShas`.
 */
export function legacyReviewShas(details: readonly TaskDetail[], events: readonly TaskEvent[], deliveries?: ReadonlyMap<string, LiveDeliveryFacts>): string[] {
  return [...legacyReviewShaPieces(details, events, deliveries).keys()]
}

/** Where a commit id was named: the piece (task, or one of its subtasks) whose own words carry it. */
export interface ShaPiece { taskId: string; subtaskId: string | null; repo?: string }

/** PURE: `legacyReviewShas`, with the pieces that named each commit — the caller needs them to know WHICH clones to ask. */
export function legacyReviewShaPieces(details: readonly TaskDetail[], events: readonly TaskEvent[], deliveries?: ReadonlyMap<string, LiveDeliveryFacts>): Map<string, ShaPiece[]> {
  const { eventsBySubject } = indexEvents(details, events)
  const out = new Map<string, ShaPiece[]>()
  for (const d of details) for (const p of piecesOf(d)) {
    if (!['in_review', 'done'].includes(p.status) || deliveries?.has(p.sub ? p.sub.id : p.task.id)) continue
    const piece: ShaPiece = { taskId: p.task.id, subtaskId: p.sub?.id ?? null, ...(p.task.repo ? { repo: p.task.repo } : {}) }
    for (const g of legacyShaGroups(p, eventsBySubject.get(p.sub ? `${p.task.id}/${p.sub.id}` : p.task.id))) for (const sha of g) {
      const l = out.get(sha)
      if (l) l.push(piece); else out.set(sha, [piece])
    }
  }
  return out
}

export interface ForecastHistory { cohorts: ForecastCohorts; typicals: Partial<Record<LiveStage, StageTypical>> }

/** PURE: publication endpoints outrank session work spans. Never turn a handback into publication. */
export function prepareForecastHistory(o: {
  details: readonly TaskDetail[]; events: readonly TaskEvent[]; nowMs: number
  deliveries?: ReadonlyMap<string, LiveDeliveryFacts>; statusLabel?: (id: string) => string | undefined
}): ForecastHistory {
  function* samples(): Generator<Sample> {
    for (const d of o.details) for (const p of piecesOf(d, undefined, true)) {
      const id = p.sub?.id ?? p.task.id
      const rec = o.deliveries?.get(id)
      if (p.status !== 'done' && rec?.phase !== 'publicado' && p.status !== 'abandoned') continue
      const hasTerminalChild = (s: Subtask) => {
        const child = o.deliveries?.get(s.id)
        const times = d.subtaskRollups.find(r => r.id === s.id)?.times
        return (s.status === 'done' || child?.phase === 'publicado') &&
          ((times?.source === 'sessions' && ms(times.startedAt) !== null && ms(times.completedAt) !== null) ||
            (child?.phase === 'publicado' && ms(child.publishedAt) !== null &&
              (child.history?.some(h => h.to === 'executando') || child.queueStarted)))
      }
      const rollup = p.sub ? d.subtasks.some(s => s.parentGroupId === p.sub!.id && hasTerminalChild(s))
        : d.subtasks.some(hasTerminalChild)
      const sessionStart = p.times?.source === 'sessions' ? ms(p.times.startedAt) : null
      const firstRun = rec?.history?.find(h => h.to === 'executando')
      const published = rec?.phase === 'publicado' ? ms(rec.publishedAt) : null
      const start = published !== null ? ms(firstRun?.at) ?? ms(rec?.queueStarted?.at) ?? sessionStart : sessionStart
      const end = published ?? (p.times?.source === 'sessions' ? ms(p.times.completedAt) : null)
      const duration = start !== null && end !== null ? end - start : NaN
      yield { key: p.sub ? `${p.task.id}/${p.sub.id}` : p.task.id,
        harness: dominant(p.sessions.map(s => s.harness)) ?? '',
        model: dominant(p.sessions.map(s => s.model).filter((m): m is string => !!m)),
        taskType: p.task.type ?? null, endpoint: published !== null ? 'publication' : 'work-span',
        durationMs: duration, startedAtMs: start ?? NaN, completedAtMs: end ?? NaN,
        abandoned: p.status === 'abandoned', rollup,
        recovered: p.times?.source !== 'sessions' && !firstRun && !rec?.queueStarted,
        blockReasons: rec?.block ? [rec.block.reason] : [],
      }
    }
  }
  const cohorts = buildForecastCohorts(samples(), o.nowMs)
  const { eventsBySubject } = indexEvents(o.details, o.events)
  const typicals = stageTypicals(cohorts.samples.map(s => trailOf(eventsBySubject.get(s.key!) ?? [], o.nowMs, o.statusLabel)))
  return { cohorts, typicals }
}

/** PURE: details of the tasks → what the line shows now, plus the history the ETA rests on. */
export function buildLive(o: {
  details: readonly TaskDetail[]
  events: readonly TaskEvent[]
  nowMs: number
  /** id → label of the board's status vocabulary, for statuses people invented. */
  statusLabel?: (id: string) => string | undefined
  /** FLUXO.ENTREGA-DSL delivery records by subtask id: when one exists its PHASE decides the stage. */
  deliveries?: ReadonlyMap<string, LiveDeliveryFacts>
  /** Commit ids (as `legacyReviewShas` named them) that a published release tag contains — a legacy review piece naming one is Publicado. */
  publishedShas?: ReadonlySet<string>
  /** Per subtask: the last reconcile's weak evidence (`delivery/batch-proof.ts`), shown beside an old card. */
  suggestions?: ReadonlyMap<string, { repo: string; pr: number; tag?: string; via: string }>
  /** Subtasks the last reconcile proved shipped (not yet moved, e.g. the automatic run is off). */
  proven?: ReadonlySet<string>
  /** Incomplete lookups; uncheckedWhy distinguishes normal non-repository work from failed reads. */
  unchecked?: ReadonlySet<string>
  uncheckedWhy?: ReadonlyMap<string, 'no-repos' | 'gh' | 'budget'>
  /** The stored role of a session: a leader or worker is never taken for the QA by its name. */
  roleOf?: StoredRoleOf
  /** Cached by liveReplyForBook's source revision. */
  forecastHistory?: ForecastHistory
  /** Persisted cache anchors loaded by the host/background owner. */
  overrunAnchors?: ReadonlyMap<string, number>
}): LiveReply {
  const candidates: Piece[] = []
  for (const d of o.details) {
    for (const p of piecesOf(d, o.roleOf)) {
      candidates.push(p)
    }
  }

  const { lastBySubject, eventsBySubject } = indexEvents(o.details, o.events)
  const trails = new Map<string, StageVisit[]>()
  for (const [subject, list] of eventsBySubject) trails.set(subject, trailOf(list, o.nowMs, o.statusLabel))
  const { cohorts, typicals } = o.forecastHistory ?? prepareForecastHistory(o)

  const deliveries: LiveDelivery[] = []
  const history: LiveDelivery[] = []
  const oldReviews: LiveDelivery[] = []
  const hidden: LiveHidden[] = []
  const entry = (p: Piece, stage: LiveStage | null, reason: HiddenReason): LiveHidden =>
    ({ key: p.sub ? `${p.task.id}/${p.sub.id}` : p.task.id, taskId: p.task.id, ...(p.sub ? { subtaskId: p.sub.id } : {}), title: p.sub?.title ?? p.task.title, stage, reason, atMs: ms(p.updatedAt) })
  const hide = (p: Piece, stage: LiveStage | null, reason: HiddenReason) => { hidden.push(entry(p, stage, reason)) }
  for (const p of candidates) {
    // A task-level piece (a task with no subtasks) is keyed by its TASK id in the delivery book, exactly as a subtask is by its own.
    const stored = o.deliveries?.get(p.sub ? p.sub.id : p.task.id)
    // A stale queue record must never override work the board already sent for review or closed.
    const rec = stored?.dequeued || (stored?.phase === 'fila' && ['in_review', 'done', 'abandoned'].includes(p.status)) ? undefined : stored
    let stage = rec ? PHASE_STAGE[rec.phase] ?? null : stageOfStatus(p.status, o.statusLabel?.(p.status))
    const id = p.sub?.id ?? p.task.id
    // Board completion is not evidence of a public release. Preserve the card in Tudo, outside the queue.
    if (p.status === 'done' && rec?.phase !== 'publicado') {
      const subject = p.sub ? `${p.task.id}/${p.sub.id}` : p.task.id
      const released = o.uncheckedWhy?.get(id) !== 'no-repos' && legacyShaGroups(p, eventsBySubject.get(subject)).some(g => g.every(sha => o.publishedShas?.has(sha)))
      stage = released ? 'published' : 'completed'
    }
    if (stored?.dequeued && stage === 'queue') { hide(p, stage, 'queue-idle'); continue }
    const liveSessions = p.sessions.filter(s => s.live)
    let isOld = false
    if (!rec && stage === 'running' && liveSessions.some(isQaName)) stage = 'qa'
    // An ABANDONED piece is closed: a session still marked open on it (a native session that never
    // recorded its end) must not put it back on the board as running.
    // The same holds for a custom terminal status the vocabulary cannot map ("cancelado"): the board has no closing
    // concept, so a closing word in the id or label is the evidence.
    const closedWord = /abandon|cancel|closed|encerr|descart|arquiv|won'?t|wont/i
    const closed = p.status === 'abandoned' || closedWord.test(`${p.status} ${o.statusLabel?.(p.status) ?? ''}`)
    if (stage === null) stage = liveSessions.length > 0 && !closed ? 'running' : null
    // A NEW ROUND on a piece already in review: a live session created AFTER the piece entered review (the book's
    // own stamp) is new work, so the card follows it — qa for a QA session, running otherwise — and returns to its
    // review stage by itself when that session ends. A worker that handed back and is still open was created before
    // review; the leader is never a round. Derived on read only: nothing is written, the delivery record is untouched.
    if (!rec && p.status === 'in_review' && stage === 'leader') {
      const since = ms(p.updatedAt)
      const round = since === null ? [] : liveSessions.filter(s => s.startMs !== null && s.startMs > since
        // A `lost` row (reboot) has no endedAt but a frozen heartbeat: it is not a round. No stamp = unknown, stays live.
        && (s.seenMs === undefined || o.nowMs - s.seenMs <= STALE_HEARTBEAT_MS) && !(s.label && LEADER_NAME.test(s.label)))
      if (round.length > 0) stage = round.some(isQaName) ? 'qa' : 'running'
    }
    // LEGACY in-review work (no delivery record): published once a release tag contains the commit it names;
    // with no such commit and nothing alive for 72 h it is not review work any more — it is listed apart, never dropped.
    if (!rec && stage === 'leader' && p.status === 'in_review') {
      const subj = p.sub ? `${p.task.id}/${p.sub.id}` : p.task.id
      if (o.uncheckedWhy?.get(id) !== 'no-repos' && legacyShaGroups(p, eventsBySubject.get(subj)).some(g => g.every(sha => o.publishedShas?.has(sha)))) stage = 'published'
      else {
        // ONE rule with the reconcile (`delivery/antigas.ts`): age alone does not take a delivery still waiting on its leader out of the column.
        let handbackMs: number | null = null
        for (const c of p.comments) if (c.kind === 'handback' && (c.subtaskId ?? null) === (p.sub?.id ?? null)) handbackMs = Math.max(handbackMs ?? 0, ms(c.createdAt) ?? 0)
        isOld = isAntiga({ hasRecord: !!stored, status: p.status, hasOpenChildren: p.hasOpenChildren, proven: o.proven?.has(id), live: liveSessions.length > 0, updatedMs: ms(p.updatedAt), nowMs: o.nowMs, handbackMs, suggested: o.suggestions?.has(id), unchecked: o.unchecked?.has(id), uncheckedWhy: o.uncheckedWhy?.get(id) })
      }
    }
    // Only what could have been a card a moment ago is worth a departure line: an abandoned/backlog piece,
    // or a todo nobody staged, was never on the board and fills the reply with nothing anyone is missing.
    const recent = o.nowMs - (ms(p.updatedAt) ?? 0) < RECENT_HIDDEN_MS
    if (stage === null) { if (recent && p.status !== 'backlog' && p.status !== 'abandoned') hide(p, null, 'status-unplaced'); continue }
    // A recorded release states its own publish time; the board's `deliveredAt` is only when the status moved (late runs: "now").
    const deliveredAtMs = (rec?.publishedAt && stage === 'published' ? ms(rec.publishedAt) : null) ?? ms(p.deliveredAt) ?? (stage === 'published' ? ms(p.updatedAt) : null)
    const oldPublished = stage === 'published' && (deliveredAtMs === null || o.nowMs - deliveredAtMs > PUBLISHED_WINDOW_MS)
    if (oldPublished) {
      // Recently expired only: a year of finished work is not a departure anybody is waiting to explain.
      if (deliveredAtMs !== null && o.nowMs - deliveredAtMs <= 3 * PUBLISHED_WINDOW_MS) hide(p, stage, 'published-old')
      // It leaves the 24 h window, but not the board: Publicado's longer periods keep the last HISTORY_DAYS days.
      if (deliveredAtMs === null || o.nowMs - deliveredAtMs > HISTORY_DAYS * PUBLISHED_WINDOW_MS) continue
    }
    const gate = stage === 'qa' || stage === 'adjust' || stage === 'leader' || stage === 'merge' || stage === 'ci' || stage === 'blocked'
    const staged = p.sub?.stagedSession !== undefined
    if (stage === 'queue' && !staged && !p.sub?.ownerRequest && liveSessions.length === 0) { if (recent && p.status !== 'backlog') hide(p, stage, 'queue-idle'); continue }
    if (stage === 'running' && liveSessions.length === 0 && !gate) { if (recent) hide(p, stage, 'no-live-session'); continue }
    const subject = p.sub ? `${p.task.id}/${p.sub.id}` : p.task.id
    const trail = trails.get(subject) ?? []
    // The newest visit is the stage the book says now; when the log is empty or stale for it, the
    // status stamp is the only witness and the trail is left to say what it knows.
    const stageSinceMs = ms(p.updatedAt)
    // A new session is a new round, even when the board status never changed. Keep the
    // status clock for cards without a percent; scope the percent's facts to this round.
    const sessionStage = stage === 'running' || stage === 'adjust' || stage === 'qa'
    const roundSessions = sessionStage ? p.sessions.filter(s => {
      if (s.label && LEADER_NAME.test(s.label)) return false
      const qa = isQaName(s) || s.id === rec?.qaSessionId
      return stage === 'qa' ? qa : !qa
    }) : []
    const fresh = roundSessions.filter(s => s.live && (s.seenMs === undefined || o.nowMs - s.seenMs <= STALE_HEARTBEAT_MS))
    const currentSession = [...(fresh.length ? fresh : roundSessions)].sort((a, b) => (b.startMs ?? -Infinity) - (a.startMs ?? -Infinity))[0]
    const visits = trail.filter(v => v.stage === stage)
    const roundStart = currentSession ? currentSession.startMs : (stageSinceMs ?? visits.at(-1)?.enteredMs ?? null)
    const round = {
      number: currentSession ? roundSessions.filter(s => s.id === currentSession.id || (s.startMs !== null && currentSession.startMs !== null && s.startMs < currentSession.startMs)).length : Math.max(1, visits.length),
      startedAtMs: roundStart,
    }
    const originStage = stage === 'blocked'
      ? (rec?.origin ? PHASE_STAGE[rec.origin] ?? null : ([...trail].reverse().find(v => v.stage !== 'blocked')?.stage ?? null))
      : null
    // THE REAL WORK OF THIS PIECE: its sessions' active time. Never the task's age (a 52-day-old task
    // with a 4-hour piece is a 4-hour piece) and never the status stamp, which is the task's.
    const spans = p.sessions.map(s => s.startMs).filter((n): n is number => n !== null)
    const startedAtMs = p.times?.source === 'sessions' ? ms(p.times.startedAt) : (spans.length ? Math.min(...spans) : ms(p.sub?.startedAt))
    // Only MEASURED activity: a session the book thinks open is not proof anything runs (a forgotten one read
    // "total 33d 10h"). The fleet joins in `describeLive`, which alone knows whether an agent is alive.
    const workMs = p.times?.activeMinutes != null ? Math.round(p.times.activeMinutes * 60_000) : null
    const harness = dominant(liveSessions.concat(p.sessions).map(s => s.harness))
    const model = dominant(liveSessions.concat(p.sessions).map(s => s.model).filter((m): m is string => !!m))
    const ev = lastBySubject.get(subject)
    // THE STEP inside the stage: what a worker/the flow REPORTED (`step` events), or what the facts show (an edit, a test
    // run, a commit, the record's gates) — the larger of the two. Nothing observable and nothing reported = null: no line.
    const stepInfo = stage === 'published' || stage === 'completed' || stage === 'queue' || stage === 'blocked' ? null : (() => {
      const reported = stepOf(eventsBySubject.get(subject) ?? [], round.startedAtMs)
      const handback = p.comments.some(c => c.kind === 'handback' && (c.subtaskId ?? null) === (p.sub?.id ?? null) && (round.startedAtMs === null || (ms(c.createdAt) ?? 0) >= round.startedAtMs))
      const derived = deriveStep({
        stage, sinceMs: round.startedAtMs, handback,
        sessions: (sessionStage ? (currentSession ? [currentSession] : []) : p.sessions).map(s => ({ id: s.id, live: s.live, isQa: isQaName(s), ...(s.activity ? { activity: s.activity } : {}) })),
        ...(rec ? { rec: rec as StepRecord } : {}),
      })
      return mergeStep(reported, derived)
    })()
    const { eta, stageEta, publishEta } = resolvePieceForecast({
      stage, origin: originStage, sinceMs: stageSinceMs, nowMs: o.nowMs, typicals,
      startedAtMs: stage === 'queue' ? null : startedAtMs, harness, model, taskType: p.task.type ?? null, cohorts,
      scheduledAtMs: rec?.queueHold?.kind === 'agendar' ? ms(rec.queueHold.until) : null,
      blockReason: rec?.block?.text || rec?.block?.reason || p.blockedReason || (p.dependsOn > 0 ? 'dependencia' : null),
      overrunAnchorAtMs: o.overrunAnchors?.get(subject),
    })
    ;(isOld ? oldReviews : oldPublished ? history : deliveries).push({
      key: subject,
      taskId: p.task.id, taskTitle: p.task.title,
      subtaskId: p.sub?.id ?? null,
      title: p.sub?.title ?? p.task.title,
      status: p.status, stage,
      stageSinceMs,
      round,
      startedAtMs,
      sessionIds: liveSessions.map(s => s.id),
      harnesses: [...new Set(liveSessions.concat(p.sessions).map(s => s.harness))],
      models: [...new Set(liveSessions.concat(p.sessions).map(s => s.model).filter((m): m is string => !!m))],
      efforts: [...new Set(liveSessions.concat(p.sessions).map(s => s.effort).filter((m): m is string => !!m))],
      eta, workMs, trail, stageEta, publishEta,
      block: stage === 'blocked' ? blockOf({ text: rec?.block ? `${rec.block.reason}: ${rec.block.text}` : p.blockedReason, dependsOn: p.dependsOn, originStage }) : null,
      ci: stage === 'ci' ? (ciSignalOf(rec?.ci ?? ((p.sub ?? p.task) as { ci?: unknown }).ci) ?? { mergedMain: true, releaseGreen: false, tagPublished: false, tag: null, pr: null }) : null,
      step: stepInfo?.step ?? null,
      stepSource: stepInfo?.source ?? null,
      stepSignal: stepInfo?.signal ?? null,
      lastAction: ev ? {
        text: (ev.detail ?? ev.kind).split('\n')[0]!.slice(0, 240), atMs: ms(ev.at) ?? o.nowMs, kind: ev.kind,
        ...(ev.from ? { from: ev.from } : {}), ...(ev.to ? { to: ev.to } : {}),
      } : null,
      blockedReason: p.blockedReason,
      priority: migratePriority(p.sub?.priority ?? p.task.priority) as LiveDelivery['priority'],
      ...(isOld ? { old: true, ...(o.suggestions?.get(id) ? { suggestion: o.suggestions.get(id)! } : {}) } : {}),
      deliveredAtMs: stage === 'published' ? deliveredAtMs : null,
      staged: p.sub?.stagedSession ? {
        harness: p.sub.stagedSession.harness ?? null, model: p.sub.stagedSession.model ?? null,
        effort: p.sub.stagedSession.effort ?? null, account: p.sub.stagedSession.account ?? null,
      } : null,
      slot: rec?.gates?.vaga ? { ok: rec.gates.vaga.ok, reason: rec.gates.vaga.reason ?? null, at: rec.gates.vaga.at } : null,
      phase: rec?.phase ?? null,
      awaitingApproval: awaitingApprovalOf(rec),
      queue: stage === 'queue' ? queueOfRecord(rec, o.nowMs) : null,
    })
  }
  deliveries.sort((a, b) => (b.stageSinceMs ?? 0) - (a.stageSinceMs ?? 0))
  const sessionTasks: Record<string, string> = {}
  for (const d of o.details) for (const s of d.sessions) if (!s.historical && !s.endedAt) sessionTasks[s.id] = d.task.id
  // Published pieces: the most recently published first (the default order of Publicado reads the same way).
  history.sort((a, b) => (b.deliveredAtMs ?? 0) - (a.deliveredAtMs ?? 0))
  oldReviews.sort((a, b) => (b.stageSinceMs ?? 0) - (a.stageSinceMs ?? 0))
  const cutByTask: NonNullable<LiveReply['cutByTask']> = {}
  const countCut = (cut: LiveDelivery[], kind: 'history' | 'oldReviews') => {
    for (const d of cut) (cutByTask[d.taskId] ??= { title: d.taskTitle, history: 0, oldReviews: 0 })[kind]++
  }
  countCut(history.slice(HISTORY_CAP), 'history')
  return {
    generatedAt: new Date(o.nowMs).toISOString(), deliveries,
    history: history.slice(0, HISTORY_CAP),
    oldReviews,
    cutByTask,
    historyTotal: history.length, oldReviewsTotal: oldReviews.length,
    samples: cohorts.sampleCount, sessionTasks,
    hidden: hidden.sort((a, b) => (b.atMs ?? 0) - (a.atMs ?? 0)).slice(0, HIDDEN_CAP),
  }
}
