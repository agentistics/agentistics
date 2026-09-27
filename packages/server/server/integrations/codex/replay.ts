/**
 * integrations/codex/replay.ts — PURE. A Codex CLI rollout, read as canonical events.
 *
 * The shape is the Claude replay's: `emptyCodexReplay` / `foldCodexReplay` / `finishCodexReplay`,
 * every accumulator moving only forward, so folding a rollout in one call and in N uneven chunks
 * emits the same events in the same order (the property the IO half's byte cursor relies on). The
 * fold never collects events: each is handed to `emit` as it is made.
 *
 * ## Every rule here is `adapters/codex-parse.ts`'s, MOVED, never re-derived
 *
 * `parseCodexRollout` holds its rules inline (there is no function to import), so the lines below
 * repeat them verbatim and name where each one lives there. The parser's own tests stay the guard,
 * and `projections/differential-codex.ts` compares this fold's projection with `parseCodexRollout`
 * over the SAME bytes, field by field — a rule that drifted here shows up there as a `bug` row.
 *
 * - the envelope: `payload.type` is the semantic type under `event_msg` / `response_item`, the outer
 *   `type` otherwise (`codexType`);
 * - usage is CUMULATIVE and LAST-WINS (`payload.info.total_token_usage`), and `input_tokens` INCLUDES
 *   the cached portion, so a snapshot's non-cached input is `max(0, input - cached)` and the cached
 *   part is the cache read (`snapshotOf`);
 * - the context gauge is `last_token_usage.input_tokens` (a GAUGE, the latest positive one) and the
 *   window is `model_context_window` (the latest positive one) — both the harness's own statement;
 * - a tool is any record whose type ends in `_call`, named by `payload.name` or else the type, then
 *   `canonicalTool` (`toolOf`); a shell command is read from `arguments.cmd` / `.command` exactly as
 *   the parser reads it, and enters an event only through `commandSummary` (D5);
 * - a person's turn is a `user_message` record (D22); a turn is closed where `activeTime.ts` closes
 *   it given the `TurnEvent`s the parser builds — `task_complete.duration_ms` is Codex's own
 *   measurement (`measured`), otherwise the last timestamped line before the next prompt or the end
 *   (`last-line`) (D25).
 *
 * ## The trap (P2 §2): a cumulative counter summed per line would count the running total N times
 *
 * So there is ONE `model.completed` per TURN, carrying the DELTA of the cumulative counters since the
 * previous emission. It is emitted when the turn is proven over — at the next turn boundary record
 * (`user_message`, `task_started`, `task_complete`, `turn_aborted`) or at the FINAL finish — and is
 * keyed on the LAST `token_count` record that moved the counters, so the same rollout re-read derives
 * the same ids. The deltas telescope: their sum is exactly the last snapshot, which is legacy's
 * last-wins figure. `confidence: 'exact'` — a deterministic difference of exact counters (D17).
 *
 * A counter that goes DOWN (a reset: nothing on this machine does it, see the differential) starts a
 * new series: what was pending is emitted, the baseline returns to zero, and the post-reset snapshot
 * is counted whole. Legacy keeps only the last snapshot there and so drops the pre-reset usage; that
 * one difference is an `explained` row with its recount, never a tolerance.
 *
 * `cacheWrite` is ABSENT from every `model.completed` (D21): the parser never reads a cache-write
 * counter for Codex (it writes a flat 0), and newer rollouts state `cache_write_input_tokens` with
 * semantics nobody has verified (is it inside `input_tokens`, like the cached read?). An absent
 * counter is the honest statement; reading it is a decision for a later version of this adapter.
 *
 * ## What is not emitted, and why
 *
 * - No `tool.completed` / `tool.failed`: Codex states a call's outcome only inside its output TEXT
 *   ("Process exited with code 1"), which this fold does not read (D5). The parser counts no tool
 *   errors either (`tool_errors: 0`).
 * - No `model.invoked`: the per-turn delta is an aggregate of the turn's responses, not one call.
 * - No `context.compacted`: the parser records no Codex compaction.
 */
import type { AgentisticsEvent, ModelCompletedData, ProviderId, ToolKind, ToolRequestedData } from '@agentistics/core'
import { redactSecrets } from '@agentistics/core'
import { canonicalTool } from '../../harness-activity'
import { commandSummary } from '../../sessions/shell-writes'
import {
  lineRef, makeEvent, str, toolExecutionIdOf,
  type CodexReplayContext, type EmitEvent,
} from './replay-core'

// ── The parser's rules, moved ───────────────────────────────────────────────────────────────────

/** The semantic type of a rollout record — `codex-parse.ts`'s `outer` / `data` / `wrapped` / `type`. */
export function codexType(e: Record<string, unknown>): { type: string | undefined; data: Record<string, unknown> } {
  const outer = e.type as string | undefined
  const data = (e.payload && typeof e.payload === 'object') ? e.payload as Record<string, unknown> : e
  const wrapped = outer === 'event_msg' || outer === 'response_item'
  const type = wrapped ? (data.type as string | undefined) : outer
  return { type, data }
}

/** One cumulative snapshot, already in the parser's split: non-cached input, cache read, output. */
export interface UsageSnapshot { input: number; cacheRead: number; output: number }

/**
 * A `token_count` record's cumulative usage, or null when it states none (a rate-limits-only record).
 * `codex-parse.ts`, the `token_count` branch: `total_token_usage` from `info` (or the payload itself),
 * `cached ?? 0`, `input ?? 0`, input `max(0, input - cached)`, output `?? the previous output`.
 */
export function snapshotOf(data: Record<string, unknown>, previous: UsageSnapshot | null): UsageSnapshot | null {
  const info = data.info as Record<string, unknown> | null | undefined
  const u = (info?.total_token_usage ?? data.total_token_usage) as Record<string, number | undefined> | null | undefined
  if (!u) return null
  const cached = u.cached_input_tokens ?? 0
  const totalInput = u.input_tokens ?? 0
  return {
    input: Math.max(0, totalInput - cached),
    cacheRead: cached,
    output: u.output_tokens ?? previous?.output ?? 0,
  }
}

/** The record's own gauge and window — the parser's `last_token_usage` / `model_context_window` reads. */
function gaugeOf(data: Record<string, unknown>): { sent: number; window?: number } {
  const info = data.info as Record<string, unknown> | null | undefined
  const last = info?.last_token_usage as Record<string, number | undefined> | undefined
  const sent = last?.input_tokens ?? 0
  const win = info?.model_context_window
  return { sent, ...(typeof win === 'number' && win > 0 ? { window: win } : {}) }
}

/** The shell command a `Bash` call ran — the parser's `arguments` read, JSON-string and all. */
export function commandOf(data: Record<string, unknown>): string {
  if (typeof data.arguments !== 'string') return ''
  try {
    const args = JSON.parse(data.arguments) as Record<string, unknown>
    if (typeof args.cmd === 'string') return args.cmd
    if (Array.isArray(args.command)) return args.command.join(' ')
    if (typeof args.command === 'string') return args.command
  } catch { /* not JSON — nothing to count, exactly as the parser skips it */ }
  return ''
}

function kindOf(canonicalName: string): ToolKind {
  if (canonicalName === 'Bash') return 'shell'
  if (canonicalName === 'Read' || canonicalName === 'Write' || canonicalName === 'Edit') return 'file'
  if (canonicalName === 'Grep' || canonicalName === 'Glob') return 'search'
  if (canonicalName.startsWith('mcp__')) return 'mcp'
  return 'other'
}

/** A record that proves the previous turn's usage is complete. */
const USAGE_BOUNDARIES = new Set(['user_message', 'task_started', 'task_complete', 'turn_aborted'])

// ── State ───────────────────────────────────────────────────────────────────────────────────────

interface LineAt { lineNo: number; at: string }

export interface CodexReplayState {
  ctx: CodexReplayContext
  /** The last raw line folded, 1-based. */
  lineNo: number

  // lifecycle
  opened: boolean
  /** The last line whose envelope `timestamp` is a non-empty string — legacy's `endTime`. */
  lastStamped: LineAt | null
  /** The `lastStamped.lineNo` the `*.ended` events were emitted for. */
  closedThroughLine: number | null
  cliVersion?: string

  // model
  provider: ProviderId
  /** The latest `turn_context.model` — legacy's `model`. */
  model?: string
  snap: UsageSnapshot | null
  /** The `token_count` record that last set `snap`, and the model in force there. */
  snapAt: (LineAt & { model?: string }) | null
  /** The snapshot the last `model.completed` was cut at — the baseline of the next delta. */
  emitted: UsageSnapshot
  /** Latest positive `last_token_usage.input_tokens` / `model_context_window`. */
  contextTokens: number
  contextWindow: number

  // turns
  turnOpen: boolean
  /** The last line with a PARSEABLE timestamp — where `activeTime.ts` closes an open turn. */
  lastTimed: LineAt | null
  /** The `lastTimed.lineNo` a final `last-line` close was already emitted for. */
  finalClosedAt: number | null
}

const ZERO: UsageSnapshot = { input: 0, cacheRead: 0, output: 0 }

export function emptyCodexReplay(ctx: CodexReplayContext): CodexReplayState {
  return {
    ctx, lineNo: 0,
    opened: false, lastStamped: null, closedThroughLine: null,
    provider: 'other', snap: null, snapAt: null, emitted: { ...ZERO }, contextTokens: 0, contextWindow: 0,
    turnOpen: false, lastTimed: null, finalClosedAt: null,
  }
}

/** An independent copy — every field is a primitive or a flat object, never shared by reference. */
export function cloneCodexReplay(s: CodexReplayState): CodexReplayState {
  return {
    ...s,
    lastStamped: s.lastStamped ? { ...s.lastStamped } : null,
    snap: s.snap ? { ...s.snap } : null,
    snapAt: s.snapAt ? { ...s.snapAt } : null,
    emitted: { ...s.emitted },
    lastTimed: s.lastTimed ? { ...s.lastTimed } : null,
  }
}

// ── The usage half ──────────────────────────────────────────────────────────────────────────────

/** Emit the delta since the last emission, keyed on the record that last moved the counters. */
function flushUsage(s: CodexReplayState, emit: EmitEvent): void {
  if (!s.snap || !s.snapAt) return
  const d = {
    input: s.snap.input - s.emitted.input,
    cacheRead: s.snap.cacheRead - s.emitted.cacheRead,
    output: s.snap.output - s.emitted.output,
  }
  if (d.input === 0 && d.cacheRead === 0 && d.output === 0) return
  const data: ModelCompletedData = {
    provider: s.provider,
    // The model in force at the snapshot. `''` only if usage arrives before any `turn_context` —
    // never seen in a real rollout (it would project `model: ''` against legacy's last model and
    // surface as a `bug` row, not be papered over here).
    model: s.snapAt.model ?? '',
    // cacheWrite deliberately absent — see this module's header (D21).
    usage: { input: d.input, output: d.output, cacheRead: d.cacheRead },
    status: 'completed',
  }
  if (s.contextTokens > 0) data.contextTokens = s.contextTokens
  if (s.contextWindow > 0) data.contextWindow = s.contextWindow
  emit(makeEvent(s.ctx, 'model.completed', data, {
    sourceRef: lineRef(s.ctx, s.snapAt.lineNo), occurredAt: s.snapAt.at, confidence: 'exact',
    ...(s.cliVersion ? { harnessVersion: s.cliVersion } : {}),
  }))
  s.emitted = { ...s.snap }
}

function foldTokenCount(s: CodexReplayState, data: Record<string, unknown>, at: LineAt, emit: EmitEvent): void {
  const next = snapshotOf(data, s.snap)
  if (next && s.snap && (next.input < s.snap.input || next.cacheRead < s.snap.cacheRead || next.output < s.snap.output)) {
    // A cumulative counter went DOWN: the series restarted. Close the old one, count the new whole.
    flushUsage(s, emit)
    s.emitted = { ...ZERO }
  }
  const g = gaugeOf(data)
  if (g.sent > 0) s.contextTokens = g.sent
  if (g.window !== undefined) s.contextWindow = g.window
  if (next) {
    s.snap = next
    s.snapAt = { ...at, ...(s.model !== undefined ? { model: s.model } : {}) }
  }
}

// ── The fold ────────────────────────────────────────────────────────────────────────────────────

/** Advance over ONE already-parsed record. `lineNo` is the caller's 1-based count of that line. */
export function foldCodexReplayEntry(
  s: CodexReplayState, e: Record<string, unknown>, lineNo: number, emit: EmitEvent,
): void {
  s.lineNo = lineNo
  const { ctx } = s
  const { type, data } = codexType(e)
  const lineTs = typeof e.timestamp === 'string' ? e.timestamp : undefined
  const stamped = str(lineTs)
  const timed = stamped !== undefined && !Number.isNaN(Date.parse(stamped))
  const ref = lineRef(ctx, lineNo)
  const hv = () => (s.cliVersion ? { harnessVersion: s.cliVersion } : {})

  if (type === 'session_meta') {
    const v = str(data.cli_version)
    if (v) s.cliVersion = v
    if (typeof data.model_provider === 'string') s.provider = data.model_provider === 'openai' ? 'openai' : 'other'
  }

  // ── lifecycle: opened on the first record that can say WHEN (legacy's `start_time` rule) ──
  const openAt = type === 'session_meta' ? (str(data.timestamp) ?? stamped) : stamped
  if (!s.opened && openAt !== undefined) {
    s.opened = true
    const cwd = type === 'session_meta' ? str(data.cwd) : undefined
    const conversationId = (type === 'session_meta' ? str(data.id) : undefined) ?? ctx.fallbackId
    const base = { sourceRef: ref, occurredAt: openAt, confidence: 'exact' as const, ...hv() }
    emit(makeEvent(ctx, 'session.started', { origin: 'adapter', ...(cwd ? { projectPath: cwd } : {}) }, { ...base, agentId: null }))
    emit(makeEvent(ctx, 'run.started', {
      harness: 'codex',
      ...(s.cliVersion ? { harnessVersion: s.cliVersion } : {}),
      conversationId,
      conversationLink: 'observed',
      ...(cwd ? { cwd } : {}),
    }, { ...base, agentId: null }))
    emit(makeEvent(ctx, 'agent.started', { kind: 'main' }, base))
  }

  // ── the turn boundary proves the previous turn's usage complete ──
  if (type && USAGE_BOUNDARIES.has(type)) flushUsage(s, emit)

  if (type === 'turn_context') {
    if (typeof data.model === 'string') s.model = data.model
  } else if (type === 'token_count') {
    foldTokenCount(s, data, { lineNo, at: stamped ?? ctx.recordedAt }, emit)
  }

  // ── turns (D22/D25): the parser's TurnEvent per timed line, run through activeTime.ts's rule ──
  if (type === 'user_message') {
    if (timed) {
      if (s.turnOpen && s.lastTimed) {
        emit(makeEvent(ctx, 'turn.ended', { close: 'last-line' }, {
          sourceRef: lineRef(ctx, s.lastTimed.lineNo), occurredAt: s.lastTimed.at, confidence: 'exact', ...hv(),
        }))
      }
      s.turnOpen = true
    }
    // Counted whatever its timestamp — the parser counts every `user_message`. One it did not stamp
    // carries the replay's clock and says so (`estimated`); the projection leaves it out of the
    // timestamps exactly as the parser does.
    emit(makeEvent(ctx, 'turn.started', { by: 'user' }, {
      sourceRef: ref, occurredAt: stamped ?? ctx.recordedAt, confidence: stamped ? 'exact' : 'estimated', ...hv(),
    }))
  } else if (type === 'task_complete' && timed && typeof data.duration_ms === 'number'
    && Number.isFinite(data.duration_ms) && data.duration_ms >= 0) {
    // Codex measured the turn itself — its number wins, and only for a turn that is open.
    if (s.turnOpen) {
      emit(makeEvent(ctx, 'turn.ended', { close: 'measured', durationMs: data.duration_ms }, {
        sourceRef: ref, occurredAt: stamped!, confidence: 'exact', ...hv(),
      }))
      s.turnOpen = false
    }
  }
  if (timed) s.lastTimed = { lineNo, at: stamped! }

  // ── tools: every `*_call` record, by the name the parser counts it under ──
  if (type && type.endsWith('_call')) {
    const rawName = typeof data.name === 'string' && data.name ? data.name : type
    const canonicalName = canonicalTool('codex', rawName)
    const callKey = str(data.call_id) ?? `line:${lineNo}`
    const req: ToolRequestedData = {
      toolExecutionId: toolExecutionIdOf(ctx.rolloutId, callKey),
      name: rawName,
      canonicalName,
      kind: kindOf(canonicalName),
    }
    if (canonicalName === 'Bash') {
      const cmd = commandOf(data)
      if (cmd) req.summary = redactSecrets(commandSummary(cmd))
    }
    emit(makeEvent(ctx, 'tool.requested', req, {
      sourceRef: ref, occurredAt: stamped ?? ctx.recordedAt, confidence: stamped ? 'exact' : 'estimated', ...hv(),
    }))
  }

  if (stamped) s.lastStamped = { lineNo, at: stamped }
}

/** Advance over raw lines. Numbering counts EVERY line, blanks included; bad JSON is skipped. */
export function foldCodexReplay(s: CodexReplayState, lines: Iterable<string>, emit: EmitEvent): void {
  for (const raw of lines) {
    const lineNo = s.lineNo + 1
    s.lineNo = lineNo
    const line = raw.trim()
    if (!line) continue
    let e: unknown
    try { e = JSON.parse(line) } catch { continue }
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue
    foldCodexReplayEntry(s, e as Record<string, unknown>, lineNo, emit)
  }
}

export interface FinishOptions {
  /** The rollout is COMPLETE. Only then are the held usage, the open turn and the `*.ended` emitted. */
  final: boolean
}

/**
 * What only the end can say. A `final: false` finish emits nothing (a live rollout's last turn is
 * still going). A `final: true` one is idempotent: repeated with nothing new folded it emits nothing,
 * and after more lines it closes again at the new end — the projection keeps a turn's LAST close.
 */
export function finishCodexReplay(s: CodexReplayState, opts: FinishOptions, emit: EmitEvent): void {
  if (!opts.final) return
  const { ctx } = s
  const hv = s.cliVersion ? { harnessVersion: s.cliVersion } : {}
  flushUsage(s, emit)
  if (s.turnOpen && s.lastTimed && s.finalClosedAt !== s.lastTimed.lineNo) {
    emit(makeEvent(ctx, 'turn.ended', { close: 'last-line' }, {
      sourceRef: lineRef(ctx, s.lastTimed.lineNo), occurredAt: s.lastTimed.at, confidence: 'exact', ...hv,
    }))
    s.finalClosedAt = s.lastTimed.lineNo
  }
  if (!s.opened || !s.lastStamped || s.closedThroughLine === s.lastStamped.lineNo) return
  const base = { sourceRef: lineRef(ctx, s.lastStamped.lineNo), occurredAt: s.lastStamped.at, confidence: 'exact' as const, ...hv }
  emit(makeEvent(ctx, 'agent.ended', { status: 'completed' }, base))
  emit(makeEvent(ctx, 'run.ended', { status: 'completed' }, { ...base, agentId: null }))
  emit(makeEvent(ctx, 'session.ended', {}, { ...base, agentId: null }))
  s.closedThroughLine = s.lastStamped.lineNo
}

/** Convenience for tests and the differential: a whole rollout, folded once, finished final. */
export function replayCodexRollout(ctx: CodexReplayContext, lines: Iterable<string>): AgentisticsEvent[] {
  const out: AgentisticsEvent[] = []
  const s = emptyCodexReplay(ctx)
  foldCodexReplay(s, lines, e => out.push(e))
  finishCodexReplay(s, { final: true }, e => out.push(e))
  return out
}
