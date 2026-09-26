/**
 * projections/differential.ts — the first, still-offline row of the parity matrix (P1 §1 item 6, §8).
 *
 * For every Claude conversation it can read: the LEGACY `SessionMeta` (`parseSessionJsonl` over the
 * transcript's bytes — the same walk every Claude surface is fed from) against the PROJECTED one
 * (the Claude replay's events folded through `sessionMetaProjection`), field by field.
 *
 * ## The vocabulary (§40 of the master spec), and the one rule behind it
 *
 * Counters must be EQUAL, not close. There is no tolerance anywhere in this module, and a row is one
 * of exactly five verdicts:
 *
 * - `equal`            — the two sides agree (both absent counts as agreeing).
 * - `explained`        — they differ, AND the difference was PROVEN for this session by an
 *                        independent recount of the raw bytes, AND the explanation is one sentence
 *                        from `EXPLANATIONS`. An explanation that was not proven for the session in
 *                        hand never applies — "it is probably the streaming thing" is a `bug`.
 * - `bug`              — they differ and nothing proved why. Reported by field and session id.
 * - `not-projectable`  — the projection declares the field absent (`NOT_PROJECTABLE`), with its reason.
 * - `partial`          — the projection declares the field half-computed (`PARTIAL_FIELDS`); both
 *                        values are shown and nothing is asserted.
 *
 * ## What is a real-store run allowed to know
 *
 * The report names session ids and field names, never conversation text or paths. Values printed
 * are numbers, model ids, day keys and tool names — the same things the dashboard already shows.
 * The store is only ever READ.
 */
import { readdir, readFile, stat as fsStat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  calcCost,
  project,
  sessionCostUSD,
  type AnyAgentisticsEvent,
  type SessionMeta,
} from '@agentistics/core'
import { parseSessionJsonl } from '../jsonl'
import { countUsage, dedupeUsage } from '../usage-dedupe'
import { agentNumbers, summarizeSubagentTranscript, type SubagentSummary } from '../subagent-parse'
import { isNestedAgent, parseAgentMeta, type AgentEntry } from '../subagent-join'
import { createClaudeReplay } from '../integrations/claude'
import { subagentIdOf } from '../integrations/claude/replay-core'
import { fallbackSubagentAgentId } from '../integrations/claude/replay-agents'
import {
  NOT_PROJECTABLE, PARTIAL_FIELDS, sessionMetaProjection,
  type ProjectedInvocation, type SessionMetaProjection,
} from './session-meta'

// ── Vocabulary ──────────────────────────────────────────────────────────────────────────────────

export type Family = 'tokens' | 'time' | 'tools'
export type Verdict = 'equal' | 'explained' | 'bug' | 'not-projectable' | 'partial'

export interface FieldRow {
  family: Family
  /** A `SessionMeta` field, or a dotted path into one (`daily.2026-09-01.input_tokens`). */
  field: string
  verdict: Verdict
  legacy?: unknown
  projected?: unknown
  /** One sentence: the explanation, the not-projectable reason, or the partial reason. */
  reason?: string
}

export interface SessionDiff {
  sessionId: string
  rows: FieldRow[]
}

/**
 * Every explanation this module may attach, one sentence each. A row gets one ONLY when the
 * evidence for that very session proves it — see `explain*` below.
 */
export const EXPLANATIONS = {
  firstWins:
    'legacy countUsage keeps the FIRST usage line of a streamed message.id (a partial one), the '
    + 'replay keeps the LAST as usage-dedupe.ts documents; an independent recount of the raw lines '
    + 'reproduces both sides exactly',
  firstWinsCost:
    'the price of the first-wins/last-wins token difference: legacy priced with the last-wins '
    + 'counters equals the projected cost exactly',
  emptyTranscript:
    'LEGACY DEFECT: the transcript is 0 bytes and replays to no event; legacy still reports a measured '
    + '0 (finishClaudeSession writes duration/compactions unconditionally), the projection says nothing',
  apiErrorOnly:
    'LEGACY DEFECT: every usage line of this transcript is a synthetic API-error record with an all-zero '
    + 'cache_creation object; legacy counts it as an observed 0/0 TTL split, the replay emits no response',
  nestedRollup:
    'legacy sums a subagent invocation over the childAgentIds it discovers by scanning each descendant '
    + "transcript's own content (subagent-parse.ts); the replay sums over the harness's own declared "
    + 'meta.parentAgentId chain and, because model.completed is keyed on the provider response id ALONE '
    + 'when one is present (O-8, excluding the source file), keeps only the first file in claim order to '
    + 'report a given message.id; an independent recount under each side\'s own rule reproduces both totals exactly',
  nestedRollupCost:
    'the price of the nested-rollup difference above: repricing each side\'s own recount per model at '
    + "its own rate equals that side's reported costUSD exactly",
  forkReplaysMain:
    'a subagent transcript carries a response of the MAIN transcript under the '
    + 'same message.id; legacy counts it again inside the invocation, the replay keeps it once, in the main '
    + 'transcript (model.completed is keyed on the provider response id alone, O-8, and the main transcript '
    + 'is folded before any subagent); a recount under each side\'s own rule, the main transcript\'s ids '
    + 'pre-claimed on the replay side, reproduces both totals exactly',
  forkReplaysMainCost:
    'the price of the fork-replays-main difference above: repricing each side\'s own recount per model at '
    + "its own rate, the main transcript's ids pre-claimed on the replay side, equals that side's reported costUSD exactly",
} as const

/**
 * A row this session PROVES is order-dependent rather than a proven-wrong bug: some message.id in the
 * invocation's member set carries DIFFERENT usage across two of its own transcripts, so the projection's
 * answer depends on which file's copy `s.seen` folds first (P1 §8). Verdict stays `bug` — this names WHY,
 * it does not explain it away.
 */
const CROSS_FILE_CONFLICT_REASON =
  'caveat: the same message.id carries different usage in two transcripts; the projection keeps '
  + 'whichever event id arrives first — order-dependent'

// ── Evidence: an independent recount of the raw bytes ───────────────────────────────────────────

export interface Tokens4 { input: number; output: number; cacheRead: number; cacheWrite: number }

/** The invocation-level `toolStats` shape, `linesAdded`/`linesRemoved` already stripped (those are
 * `partial` fields elsewhere in this module and are never asserted). */
export interface ToolStats4 {
  readCount: number; searchCount: number; bashCount: number; editFileCount: number; otherToolCount: number
}

/** What each side's OWN rule gives for one top-level subagent invocation, independently re-derived. */
export interface RootEvidence {
  legacy: { tokens: number; costUSD: number; toolUseCount: number; toolStats: ToolStats4 }
  projected: { tokens: number; costUSD: number; toolUseCount: number; toolStats: ToolStats4 }
  /** True when some message.id in this root's member set carries DIFFERENT usage in two of its own
   * transcripts (or differs from the main transcript's copy) — the projected recount is then
   * order-dependent, never a proof either way. */
  conflict: boolean
  /** How many of this root's message.ids the MAIN transcript already carries. The replay folds the
   * main transcript first and `model.completed` is keyed on the id alone (O-8), so the projection
   * reports each of these under the main transcript and never under the invocation. */
  mainSharedIds: number
}

/** What the two counting rules give over the same lines — the only thing that can EXPLAIN a token row. */
export interface UsageEvidence {
  main: { firstWins: Tokens4; lastWins: Tokens4; usageLines: number; apiErrorZeroTtlLines: number }
  /** Size of the main transcript in bytes. */
  mainBytes: number
  /** Keyed by the harness's own TOP-LEVEL agent id — the same id `AgentInvocation.agentId` carries. */
  roots: Record<string, RootEvidence>
}

interface RawUsage {
  input_tokens?: number; output_tokens?: number
  cache_read_input_tokens?: number; cache_creation_input_tokens?: number
}

const t4 = (u: RawUsage): Tokens4 => ({
  input: u.input_tokens ?? 0, output: u.output_tokens ?? 0,
  cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0,
})
const zero4 = (): Tokens4 => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
const add4 = (a: Tokens4, b: Tokens4): void => {
  a.input += b.input; a.output += b.output; a.cacheRead += b.cacheRead; a.cacheWrite += b.cacheWrite
}
const sum4 = (t: Tokens4): number => t.input + t.output + t.cacheRead + t.cacheWrite
const zeroToolStats4 = (): ToolStats4 =>
  ({ readCount: 0, searchCount: 0, bashCount: 0, editFileCount: 0, otherToolCount: 0 })

/**
 * PURE. Both counting rules over one transcript's lines. Assistant lines with a `message.usage` only —
 * the population `countUsage` is applied to in `jsonl.ts` and `subagent-parse.ts`.
 */
export function recountUsage(lines: Iterable<string>): UsageEvidence['main'] {
  const seen = new Set<string>()
  const first: Tokens4 = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const entries: { id?: unknown; usage?: RawUsage }[] = []
  let usageLines = 0
  let apiErrorZeroTtlLines = 0
  for (const line of lines) {
    if (!line.trim()) continue
    let e: { type?: unknown; isApiErrorMessage?: unknown; message?: { id?: unknown; usage?: RawUsage & { cache_creation?: Record<string, unknown> } } }
    try { e = JSON.parse(line) } catch { continue }
    if (e.type !== 'assistant' || !e.message?.usage) continue
    entries.push({ id: e.message.id, usage: e.message.usage })
    usageLines++
    const cc = e.message.usage.cache_creation
    if (e.isApiErrorMessage === true && cc && typeof cc === 'object'
      && Object.values(cc).every(v => v === 0)) apiErrorZeroTtlLines++
    if (countUsage(e.message.id, seen)) {
      const u = t4(e.message.usage)
      first.input += u.input; first.output += u.output; first.cacheRead += u.cacheRead; first.cacheWrite += u.cacheWrite
    }
  }
  return {
    firstWins: first,
    lastWins: t4(dedupeUsage(entries as Parameters<typeof dedupeUsage>[0]) as RawUsage),
    usageLines, apiErrorZeroTtlLines,
  }
}

/**
 * PURE. Which `subagents/` entries roll up under `rootId`, in the SAME order the real fold claims
 * them — the root itself, then every entry whose OWN `meta.parentAgentId` chain (session-meta.ts's
 * `rootOf`) resolves to `rootId`, in the order `entries` lists them (the directory's own listing
 * order — nested launches are appended to `planLaunches`'s list in exactly that order; see
 * `integrations/claude/index.ts`'s `planLaunches`). Order is load-bearing for the token/cost
 * evidence below: `deriveEventId` keys `model.completed` on the provider's own response id ALONE
 * when one is present (`canonical/event-id.ts`, O-8 — it excludes the source file from the key), so
 * `session-meta.ts`'s `s.seen` keeps whichever FILE's copy of a shared message.id is folded FIRST —
 * the root's own file (claimed ahead of every nested one), then each nested entry in this order.
 */
export function metaChainMembers(rootId: string, entries: readonly AgentEntry[]): string[] {
  const allIds = new Set(entries.map(e => e.agentId))
  const parentOf = new Map(entries.map(e => [e.agentId, e.meta?.parentAgentId]))
  const rootOf = (id: string): string => {
    const seen = new Set([id])
    let cur = id
    for (;;) {
      const p = parentOf.get(cur)
      if (!p || !allIds.has(p) || seen.has(p)) return cur
      seen.add(p); cur = p
    }
  }
  const nested = entries.filter(e => e.agentId !== rootId && rootOf(e.agentId) === rootId).map(e => e.agentId)
  return [rootId, ...nested]
}

/** What one `model.completed`-worthy line states: its model and its four counters. */
interface IdUsage { model: string; tokens: Tokens4 }

/**
 * PURE. One transcript's own usage lines, LAST occurrence wins per `message.id` WITHIN this one
 * file — the common contiguous-streaming case of `replay-model.ts`'s HOLD mechanism (a response held
 * across several consecutive lines, the last one read being the complete usage). The rarer case that
 * mechanism handles — the SAME id reappearing NON-contiguously, which it drops entirely rather than
 * overwrites — is deliberately not mirrored: a mismatch from that case surfaces as an unproven `bug`,
 * never a false `explained`, which is the one direction this module may never be wrong in. A record
 * with no `message.id` is always counted, per `usage-dedupe.ts`'s own rule for such a line. A
 * synthetic (`isApiErrorMessage` / `model === '<synthetic>'`) line bills nothing on the replay side
 * (it becomes `model.failed`, not `model.completed`) and is excluded here to match.
 */
export function fileUsageById(lines: Iterable<string>): { byId: Map<string, IdUsage>; anonymous: IdUsage[] } {
  const byId = new Map<string, IdUsage>()
  const anonymous: IdUsage[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    let e: { type?: unknown; isApiErrorMessage?: unknown; message?: { id?: unknown; model?: unknown; usage?: RawUsage } }
    try { e = JSON.parse(line) } catch { continue }
    if (e.type !== 'assistant' || e.isApiErrorMessage === true || !e.message?.usage) continue
    const model = typeof e.message.model === 'string' ? e.message.model : ''
    if (!model || model === '<synthetic>') continue
    const tokens = t4(e.message.usage)
    const id = typeof e.message.id === 'string' && e.message.id ? e.message.id : undefined
    if (!id) { anonymous.push({ model, tokens }); continue }
    byId.set(id, { model, tokens })
  }
  return { byId, anonymous }
}

/**
 * PURE. The GLOBAL cross-file dedup `model.completed`'s provider-keyed event id performs (O-8):
 * `files` walked in CLAIM order (see `metaChainMembers`), and for a `message.id` shared by more than
 * one file, only the FIRST file's copy is kept — every later file's copy of that same id is dropped,
 * exactly as `s.seen` drops the later duplicate `eventId`. `conflict` is raised when a later copy's
 * tokens genuinely DISAGREE with the first one's — a fact worth reporting even though this function
 * still resolves it (deterministically, by claim order) rather than refusing to.
 */
export function globalDedupPerModel(
  files: readonly { byId: Map<string, IdUsage>; anonymous: IdUsage[] }[],
  preclaimed?: ReadonlyMap<string, IdUsage>,
): { byModel: Map<string, Tokens4>; conflict: boolean; preclaimedHits: number } {
  const firstSeen = new Map<string, Tokens4>()
  const byModel = new Map<string, Tokens4>()
  let conflict = false
  let preclaimedHits = 0
  // Ids a file folded EARLIER in the same session already reported (the main transcript): each one
  // is already seen, so every copy of it here is dropped exactly as a later file's copy is.
  for (const [id, u] of preclaimed ?? []) firstSeen.set(id, u.tokens)
  const counted = new Set<string>()
  const addTo = (model: string, t: Tokens4) => {
    const cur = byModel.get(model) ?? zero4()
    add4(cur, t)
    byModel.set(model, cur)
  }
  for (const f of files) {
    for (const [id, u] of f.byId) {
      const prior = firstSeen.get(id)
      if (prior) {
        if (sum4(prior) !== sum4(u.tokens)) conflict = true
        if (preclaimed?.has(id) && !counted.has(id)) { counted.add(id); preclaimedHits++ }
        continue
      }
      firstSeen.set(id, u.tokens)
      addTo(u.model, u.tokens)
    }
    for (const u of f.anonymous) addTo(u.model, u.tokens)
  }
  return { byModel, conflict, preclaimedHits }
}

// ── The comparison ──────────────────────────────────────────────────────────────────────────────

const NP = new Map(NOT_PROJECTABLE.map(n => [n.field, n.reason]))
const PARTIAL = new Map(PARTIAL_FIELDS.map(n => [n.field, n.reason]))

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined || a === null || b === null) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false
  const ka = Object.keys(a as object).sort(), kb = Object.keys(b as object).sort()
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false
  return ka.every(k => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

function row(family: Family, field: string, legacy: unknown, projected: unknown): FieldRow {
  return same(legacy, projected)
    ? { family, field, verdict: 'equal', legacy, projected }
    : { family, field, verdict: 'bug', legacy, projected }
}

function np(family: Family, field: string, legacy: unknown): FieldRow {
  return { family, field, verdict: 'not-projectable', legacy, reason: NP.get(field) ?? 'declared not projectable' }
}

/** A differing counter is explained by first-wins only when BOTH sides equal their recount. */
function explainByRecount(r: FieldRow, first: number, last: number): FieldRow {
  if (r.verdict !== 'bug') return r
  if (r.legacy === first && r.projected === last && first !== last) {
    return { ...r, verdict: 'explained', reason: EXPLANATIONS.firstWins }
  }
  return r
}

const TOKEN_FIELDS = [
  ['input_tokens', 'input'],
  ['output_tokens', 'output'],
  ['cache_read_input_tokens', 'cacheRead'],
  ['cache_creation_input_tokens', 'cacheWrite'],
] as const

/** Family (a): the four token counters, the TTL split, the model and the cost. */
export function compareTokens(legacy: SessionMeta, p: SessionMetaProjection, ev?: UsageEvidence): FieldRow[] {
  const out: FieldRow[] = []
  let allExplained = true
  for (const [field, k] of TOKEN_FIELDS) {
    let r = row('tokens', field, legacy[field] ?? 0, p.meta[field] ?? 0)
    if (ev) r = explainByRecount(r, ev.main.firstWins[k], ev.main.lastWins[k])
    if (r.verdict === 'bug') allExplained = false
    out.push(r)
  }
  for (const f of ['cache_creation_1h_input_tokens', 'cache_creation_5m_input_tokens'] as const) {
    let r = row('tokens', f, legacy[f], p.meta[f])
    if (r.verdict === 'bug' && ev && r.legacy === 0 && r.projected === undefined
      && ev.main.usageLines > 0 && ev.main.apiErrorZeroTtlLines === ev.main.usageLines) {
      r = { ...r, verdict: 'explained', reason: EXPLANATIONS.apiErrorOnly }
    }
    out.push(r)
  }
  out.push(row('tokens', 'model', legacy.model, p.meta.model))

  let cost = row('tokens', 'costUSD', sessionCostUSD(legacy), p.costUSD)
  if (cost.verdict === 'bug' && ev && allExplained) {
    const relabelled: SessionMeta = {
      ...legacy,
      input_tokens: ev.main.lastWins.input, output_tokens: ev.main.lastWins.output,
      cache_read_input_tokens: ev.main.lastWins.cacheRead, cache_creation_input_tokens: ev.main.lastWins.cacheWrite,
    }
    if (sessionCostUSD(relabelled) === p.costUSD) cost = { ...cost, verdict: 'explained', reason: EXPLANATIONS.firstWinsCost }
  }
  out.push(cost)
  return out
}

/** Family (b): the clock — start/end/duration, the per-day token split, and the human-turn family. */
export function compareTime(legacy: SessionMeta, p: SessionMetaProjection): FieldRow[] {
  const out: FieldRow[] = [
    row('time', 'start_time', legacy.start_time || undefined, p.meta.start_time),
    row('time', 'end_time', legacy.end_time || undefined, p.meta.end_time),
    row('time', 'duration_minutes', legacy.duration_minutes, p.meta.duration_minutes),
    np('time', 'active_minutes', legacy.active_minutes),
    // `rounds` is not a stored SessionMeta field (it is derived from the human turns), so no legacy value is shown.
    np('time', 'rounds', undefined),
    np('time', 'user_message_count', legacy.user_message_count),
    np('time', 'message_hours', legacy.message_hours?.length),
  ]
  // daily: tokens are projectable per day; messages/hours are not (the human-turn event).
  const legacyDays = legacy.daily ?? {}
  const projDays = p.meta.daily_tokens ?? {}
  const days = new Set([
    ...Object.keys(legacyDays).filter(d => {
      const u = legacyDays[d]!
      return u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens > 0
    }),
    ...Object.keys(projDays),
  ])
  for (const d of [...days].sort()) {
    const l = legacyDays[d], q = projDays[d]
    out.push(row('time', `daily.${d}.tokens`,
      l ? { input: l.input_tokens, output: l.output_tokens, cacheRead: l.cache_read_input_tokens, cacheWrite: l.cache_creation_input_tokens } : undefined,
      q))
  }
  if (legacy.daily) out.push(np('time', 'daily', Object.keys(legacyDays).length))
  return out
}

/**
 * The harness's agent id a projected invocation stands for, recovered through the entity id.
 *
 * Two candidate ids, tried in this order: `subagentIdOf` — the CLAIMED shape, when the legacy side
 * resolved a real harness `agentId` — and `fallbackSubagentAgentId` — the UNMEASURED shape the
 * replay assigns when nothing under `subagents/` could be paired with the launch (an interrupted
 * call with no `agentId` at all, or a `subagents/` directory that does not exist). Trying only the
 * first left an unmeasured invocation permanently one-sided: legacy still names it by its own
 * `toolUseId`/`agentId`, while the replay names the SAME launch by a hash of `toolUseId` alone, and
 * the two ids never coincide by construction.
 */
export function pairInvocations(conversationId: string, legacy: SessionMeta, p: SessionMetaProjection) {
  const proj = new Map((p.meta.agentMetrics?.invocations ?? []).map(i => [i.agentId, i]))
  const pairs: { key: string; l?: NonNullable<SessionMeta['agentMetrics']>['invocations'][number]; q?: ProjectedInvocation }[] = []
  const used = new Set<string>()
  for (const l of legacy.agentMetrics?.invocations ?? []) {
    const byAgentId = l.agentId ? subagentIdOf(conversationId, l.agentId) : undefined
    const byFallback = fallbackSubagentAgentId(conversationId, l.toolUseId)
    const id = byAgentId && proj.has(byAgentId) ? byAgentId : proj.has(byFallback) ? byFallback : byAgentId
    const q = id ? proj.get(id) : undefined
    if (q && id) used.add(id)
    pairs.push({ key: l.agentId ?? `toolUse:${l.toolUseId}`, l, q })
  }
  for (const [id, q] of proj) if (!used.has(id)) pairs.push({ key: id, q })
  return pairs
}

/** Family (c): tools, errors, the agent rollup (unmeasured apart), the context gauge, compactions. */
export function compareTools(
  conversationId: string, legacy: SessionMeta, p: SessionMetaProjection, ev?: UsageEvidence,
): FieldRow[] {
  const m = p.meta
  const out: FieldRow[] = [
    row('tools', 'tool_counts', legacy.tool_counts ?? {}, m.tool_counts ?? {}),
    row('tools', 'tool_errors', legacy.tool_errors ?? 0, m.tool_errors ?? 0),
    row('tools', 'tool_error_categories', legacy.tool_error_categories ?? {}, m.tool_error_categories ?? {}),
    row('tools', 'uses_task_agent', !!legacy.uses_task_agent, !!m.uses_task_agent),
    row('tools', 'uses_mcp', !!legacy.uses_mcp, !!m.uses_mcp),
    row('tools', 'uses_web_search', !!legacy.uses_web_search, !!m.uses_web_search),
    row('tools', 'uses_web_fetch', !!legacy.uses_web_fetch, !!m.uses_web_fetch),
    row('tools', 'context_tokens', legacy.context_tokens, m.context_tokens),
    row('tools', 'context_window', legacy.context_window, m.context_window),
    row('tools', 'compact_count', legacy.compact_count, m.compact_count),
    row('tools', 'compact_ms', legacy.compact_ms, m.compact_ms),
    row('tools', 'compact_dropped_tokens', legacy.compact_dropped_tokens, m.compact_dropped_tokens),
  ]
  for (const f of ['lines_added', 'lines_removed', 'files_modified'] as const) {
    out.push({ family: 'tools', field: f, verdict: 'partial', legacy: legacy[f], projected: m[f], reason: PARTIAL.get(f) })
  }
  // A caveat the projection raised for THIS walk turns a tool_errors difference into a stated one,
  // not a proven one: it stays a bug unless the caveat names it. Surfaced so the reader can judge.
  const toolCaveat = p.caveats.find(c => c.field === 'tool_errors')
  if (toolCaveat) {
    for (const r of out) if (r.field.startsWith('tool_error') && r.verdict === 'bug') r.reason = `caveat: ${toolCaveat.reason}`
  }

  const la = legacy.agentMetrics, pa = m.agentMetrics
  if (la || pa) {
    out.push(row('tools', 'agentMetrics.totalInvocations', la?.totalInvocations ?? 0, pa?.totalInvocations ?? 0))
    out.push(row('tools', 'agentMetrics.unmeasuredInvocations', la?.unmeasuredInvocations ?? 0, pa?.unmeasuredInvocations ?? 0))
    let tot = row('tools', 'agentMetrics.totalTokens', la?.totalTokens ?? 0, pa?.totalTokens ?? 0)
    let cost = row('tools', 'agentMetrics.totalCostUSD', la?.totalCostUSD ?? 0, pa?.totalCostUSD ?? 0)

    // Every MEASURED root's own evidence, summed in the SAME order `pairInvocations` walks legacy's
    // own invocation list — which is also the order `totalsOf`'s reduce summed `la.totalCostUSD` in,
    // so a match here is not a coincidence of magnitude, it is the identical arithmetic re-run.
    let legacySum = 0, projectedSum = 0, legacyCostSum = 0, projectedCostSum = 0
    let coverageComplete = true
    let anyMeasured = false
    let anyConflict = false
    let anyMainShared = false

    for (const { key, l, q } of pairInvocations(conversationId, legacy, p)) {
      const base = `agentMetrics.invocations[${key}]`
      if (!l || !q) {
        out.push({ family: 'tools', field: base, verdict: 'bug', legacy: l ? 'present' : undefined, projected: q ? 'present' : undefined })
        coverageComplete = false
        continue
      }
      out.push(row('tools', `${base}.unmeasured`, !!l.unmeasured, !!q.unmeasured))
      out.push(row('tools', `${base}.agentType`, l.agentType, q.agentType))
      const { linesAdded: _a, linesRemoved: _r, ...lStats } = l.toolStats as typeof l.toolStats & { linesAdded?: number; linesRemoved?: number }

      if (l.unmeasured || q.unmeasured) {
        // Nothing to recount — an unmeasured launch carries no transcript, on either side, by
        // definition. These rows are ordinary equal/bug comparisons with no evidence to apply.
        const rCount0 = row('tools', `${base}.totalToolUseCount`, l.totalToolUseCount, q.totalToolUseCount)
        const rStats0 = row('tools', `${base}.toolStats`, lStats, q.toolStats)
        const rTok0 = row('tools', `${base}.totalTokens`, l.totalTokens, q.totalTokens)
        out.push(rCount0, rStats0, rTok0)
        if (rCount0.verdict === 'bug' || rStats0.verdict === 'bug' || rTok0.verdict === 'bug') coverageComplete = false
        continue
      }

      anyMeasured = true
      const rootEv = l.agentId ? ev?.roots[l.agentId] : undefined

      let rCount = row('tools', `${base}.totalToolUseCount`, l.totalToolUseCount, q.totalToolUseCount)
      let rStats = row('tools', `${base}.toolStats`, lStats, q.toolStats)
      let rTok = row('tools', `${base}.totalTokens`, l.totalTokens, q.totalTokens)

      if (rootEv) {
        if (rootEv.conflict) anyConflict = true
        if (rCount.verdict === 'bug' && rCount.legacy === rootEv.legacy.toolUseCount && rCount.projected === rootEv.projected.toolUseCount) {
          rCount = { ...rCount, verdict: 'explained', reason: EXPLANATIONS.nestedRollup }
        }
        if (rStats.verdict === 'bug' && same(rStats.legacy, rootEv.legacy.toolStats) && same(rStats.projected, rootEv.projected.toolStats)) {
          rStats = { ...rStats, verdict: 'explained', reason: EXPLANATIONS.nestedRollup }
        }
        if (rootEv.mainSharedIds > 0) anyMainShared = true
        if (rTok.verdict === 'bug' && rTok.legacy === rootEv.legacy.tokens && rTok.projected === rootEv.projected.tokens) {
          rTok = {
            ...rTok, verdict: 'explained',
            reason: rootEv.mainSharedIds > 0 ? EXPLANATIONS.forkReplaysMain : EXPLANATIONS.nestedRollup,
          }
        } else if (rTok.verdict === 'bug' && rootEv.conflict) {
          rTok = { ...rTok, reason: CROSS_FILE_CONFLICT_REASON }
        }
        legacySum += rootEv.legacy.tokens; projectedSum += rootEv.projected.tokens
        legacyCostSum += rootEv.legacy.costUSD; projectedCostSum += rootEv.projected.costUSD
      } else {
        coverageComplete = false
      }

      out.push(rCount, rStats, rTok)
      if (rCount.verdict === 'bug' || rStats.verdict === 'bug' || rTok.verdict === 'bug') coverageComplete = false
    }

    if (coverageComplete && anyMeasured) {
      if (tot.verdict === 'bug' && typeof tot.legacy === 'number' && typeof tot.projected === 'number'
        && legacySum === tot.legacy && projectedSum === tot.projected) {
        tot = { ...tot, verdict: 'explained', reason: anyMainShared ? EXPLANATIONS.forkReplaysMain : EXPLANATIONS.nestedRollup }
      } else if (tot.verdict === 'bug' && anyConflict) {
        tot = { ...tot, reason: CROSS_FILE_CONFLICT_REASON }
      }
      if (cost.verdict === 'bug' && typeof cost.legacy === 'number' && typeof cost.projected === 'number'
        && legacyCostSum === cost.legacy && projectedCostSum === cost.projected) {
        cost = { ...cost, verdict: 'explained', reason: anyMainShared ? EXPLANATIONS.forkReplaysMainCost : EXPLANATIONS.nestedRollupCost }
      } else if (cost.verdict === 'bug' && anyConflict) {
        cost = { ...cost, reason: CROSS_FILE_CONFLICT_REASON }
      }
    }
    out.push(tot, cost)
  }
  return out
}

/** The fields legacy writes as a measured 0 even when it walked no line at all. */
const EMPTY_ZERO_FIELDS = new Set(['duration_minutes', 'compact_count', 'compact_ms'])

/** PURE. Every row for one session. */
export function compareSession(input: {
  sessionId: string
  legacy: SessionMeta
  projection: SessionMetaProjection
  evidence?: UsageEvidence
}): SessionDiff {
  const { sessionId, legacy, projection, evidence } = input
  const rows = [
    ...compareTokens(legacy, projection, evidence),
    ...compareTime(legacy, projection),
    ...compareTools(sessionId, legacy, projection, evidence),
  ]
  if (evidence?.mainBytes === 0 && projection.eventsFolded === 0) {
    for (const r of rows) {
      if (r.verdict === 'bug' && EMPTY_ZERO_FIELDS.has(r.field) && r.legacy === 0 && r.projected === undefined) {
        r.verdict = 'explained'
        r.reason = EXPLANATIONS.emptyTranscript
      }
    }
  }
  return { sessionId, rows }
}

// ── The report ──────────────────────────────────────────────────────────────────────────────────

export interface FieldSummary {
  family: Family
  /** The field with any `[key]` / day segment collapsed, so 10k sessions summarise into ~60 rows. */
  field: string
  counts: Record<Verdict, number>
  /** Session ids with a `bug` on this field (capped for print, count is in `counts`). */
  bugSessions: string[]
  reasons: string[]
}

export interface DifferentialReport {
  sessions: number
  skipped: { live: number; unreadable: number }
  fields: FieldSummary[]
  /** Sessions with at least one `bug` row. */
  sessionsWithBugs: number
}

const normalizeField = (f: string): string =>
  f.replace(/^daily\.\d{4}-\d{2}-\d{2}\./, 'daily.<day>.').replace(/\[[^\]]+\]/g, '[]')

const emptyCounts = (): Record<Verdict, number> =>
  ({ equal: 0, explained: 0, bug: 0, 'not-projectable': 0, partial: 0 })

/** PURE. Folds per-session diffs into one row per (normalised) field. */
export function summarize(diffs: readonly SessionDiff[], skipped = { live: 0, unreadable: 0 }): DifferentialReport {
  const by = new Map<string, FieldSummary>()
  let withBugs = 0
  for (const d of diffs) {
    let bug = false
    for (const r of d.rows) {
      const field = normalizeField(r.field)
      const key = `${r.family}\0${field}`
      let s = by.get(key)
      if (!s) { s = { family: r.family, field, counts: emptyCounts(), bugSessions: [], reasons: [] }; by.set(key, s) }
      s.counts[r.verdict]++
      if (r.verdict === 'bug') { bug = true; if (!s.bugSessions.includes(d.sessionId)) s.bugSessions.push(d.sessionId) }
      if (r.reason && !s.reasons.includes(r.reason)) s.reasons.push(r.reason)
    }
    if (bug) withBugs++
  }
  const order: Family[] = ['tokens', 'time', 'tools']
  const fields = [...by.values()].sort((a, b) =>
    order.indexOf(a.family) - order.indexOf(b.family) || a.field.localeCompare(b.field))
  return { sessions: diffs.length, skipped, fields, sessionsWithBugs: withBugs }
}

/** PURE. The report as Markdown — ids and field names only. */
export function renderReport(r: DifferentialReport, maxIds = 8): string {
  const lines = [
    `sessions compared: ${r.sessions} · with at least one bug row: ${r.sessionsWithBugs} · skipped: ${r.skipped.live} live, ${r.skipped.unreadable} unreadable`,
    '',
    '| family | field | equal | explained | bug | not-projectable | partial | bug sessions (first ids) |',
    '|---|---|---:|---:|---:|---:|---:|---|',
  ]
  for (const f of r.fields) {
    const c = f.counts
    const ids = f.bugSessions.slice(0, maxIds).map(s => s.slice(0, 8)).join(' ')
      + (f.bugSessions.length > maxIds ? ` +${f.bugSessions.length - maxIds}` : '')
    lines.push(`| ${f.family} | \`${f.field}\` | ${c.equal} | ${c.explained} | ${c.bug} | ${c['not-projectable']} | ${c.partial} | ${ids} |`)
  }
  return lines.join('\n')
}

// ── IO: run it over a store ─────────────────────────────────────────────────────────────────────

export interface DifferentialOptions {
  /** A Claude `projects` directory. Read only. */
  projectsDir: string
  /** Restrict to these conversation ids. */
  sessionIds?: readonly string[]
  /** A transcript written to more recently than this is live and skipped (default 60 s). */
  settledMs?: number
  /** Default `Date.now`. */
  now?: () => number
  /** Called once per session compared — lets a CLI print progress without holding every diff. */
  onSession?: (d: SessionDiff) => void
  /** Keep every per-session diff on the result (tests); a real-store run keeps only the summary. */
  keepDiffs?: boolean
}

interface Located { conversationId: string; path: string; subagentsDir: string }

async function locate(projectsDir: string, only?: ReadonlySet<string>): Promise<Located[]> {
  let projects: string[]
  try { projects = await readdir(projectsDir) } catch { return [] }
  const out: Located[] = []
  for (const project of projects.sort()) {
    const dir = join(projectsDir, project)
    let files: string[]
    try { files = await readdir(dir) } catch { continue }
    for (const file of files.sort()) {
      if (!file.endsWith('.jsonl')) continue
      const conversationId = file.slice(0, -'.jsonl'.length)
      if (only && !only.has(conversationId)) continue
      out.push({ conversationId, path: join(dir, file), subagentsDir: join(dir, conversationId, 'subagents') })
    }
  }
  return out
}

/** Every `subagents/` entry, with its parsed meta — the directory's own listing order preserved. */
async function subagentEntries(dir: string): Promise<AgentEntry[]> {
  let names: string[]
  try { names = await readdir(dir) } catch { return [] }
  const entries: AgentEntry[] = []
  for (const name of names) {
    const m = /^agent-(.+)\.jsonl$/.exec(name)
    if (!m) continue
    const agentId = m[1]!
    const metaText = await readFile(join(dir, `agent-${agentId}.meta.json`), 'utf-8').catch(() => '')
    entries.push({ agentId, meta: metaText ? parseAgentMeta(metaText) : null })
  }
  return entries
}

async function readSubagentLines(
  dir: string, agentId: string, cache: Map<string, string[] | null>,
): Promise<string[] | null> {
  const hit = cache.get(agentId)
  if (hit !== undefined) return hit
  let lines: string[] | null
  try { lines = (await readFile(join(dir, `agent-${agentId}.jsonl`), 'utf-8')).split('\n') } catch { lines = null }
  cache.set(agentId, lines)
  return lines
}

/**
 * IO. Legacy's own recount for one root — mirrors `subagent-metrics.ts`'s UNEXPORTED
 * `descendantsOf` (the childAgentIds BFS), but over the EXPORTED `summarizeSubagentTranscript` /
 * `agentNumbers` from `subagent-parse.ts`, so the numbers are legacy's own algorithm re-run on the
 * same bytes, not a second guess at what it does.
 */
async function legacyRootEvidence(
  dir: string, rootId: string, cache: Map<string, string[] | null>,
): Promise<RootEvidence['legacy'] | null> {
  const rootLines = await readSubagentLines(dir, rootId, cache)
  if (!rootLines) return null
  const root = summarizeSubagentTranscript(rootLines)
  const descendants: SubagentSummary[] = []
  const seen = new Set([rootId])
  const queue = [...root.childAgentIds]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    const lines = await readSubagentLines(dir, id, cache)
    if (!lines) continue
    const s = summarizeSubagentTranscript(lines)
    descendants.push(s)
    queue.push(...s.childAgentIds)
  }
  const nums = agentNumbers(root, descendants)
  const { linesAdded: _a, linesRemoved: _r, ...toolStats } = nums.toolStats
  return { tokens: nums.totalTokens, costUSD: nums.costUSD, toolUseCount: nums.totalToolUseCount, toolStats }
}

/**
 * IO. The replay's own recount for one root — `metaChainMembers` for WHICH files roll up, then a
 * GLOBAL cross-file dedup (`globalDedupPerModel`) for the token/cost half and a plain per-file sum
 * for tool counts (`tool.requested`/`tool.completed` are not provider-keyed, so the replay never
 * dedupes them across files either — see `canonical/event-id.ts`, O-8).
 */
async function projectedRootEvidence(
  dir: string, rootId: string, entries: readonly AgentEntry[], cache: Map<string, string[] | null>,
  mainById: ReadonlyMap<string, IdUsage>,
): Promise<(RootEvidence['projected'] & { conflict: boolean; mainSharedIds: number }) | null> {
  const members = metaChainMembers(rootId, entries)
  const perFile: ReturnType<typeof fileUsageById>[] = []
  const toolStats = zeroToolStats4()
  let toolUseCount = 0
  let any = false
  for (const id of members) {
    const lines = await readSubagentLines(dir, id, cache)
    if (!lines) continue
    any = true
    perFile.push(fileUsageById(lines))
    const s = summarizeSubagentTranscript(lines)
    toolUseCount += s.toolUseCount
    toolStats.readCount += s.toolStats.readCount
    toolStats.searchCount += s.toolStats.searchCount
    toolStats.bashCount += s.toolStats.bashCount
    toolStats.editFileCount += s.toolStats.editFileCount
    toolStats.otherToolCount += s.toolStats.otherToolCount
  }
  if (!any) return null
  const { byModel, conflict, preclaimedHits } = globalDedupPerModel(perFile, mainById)
  let tokens = 0, costUSD = 0
  for (const [model, t] of byModel) {
    tokens += sum4(t)
    costUSD += calcCost(
      { inputTokens: t.input, outputTokens: t.output, cacheReadInputTokens: t.cacheRead, cacheCreationInputTokens: t.cacheWrite, webSearchRequests: 0, costUSD: 0 },
      model,
    )
  }
  return { tokens, costUSD, toolUseCount, toolStats, conflict, mainSharedIds: preclaimedHits }
}

async function evidenceFor(loc: Located): Promise<UsageEvidence> {
  const text = await readFile(loc.path, 'utf-8')
  const main = recountUsage(text.split('\n'))
  // The replay folds the main transcript BEFORE any subagent (integrations/claude/index.ts), so every
  // id it carries is already claimed when a subagent's copy of the same id arrives.
  const mainById = fileUsageById(text.split('\n')).byId
  const entries = await subagentEntries(loc.subagentsDir)
  const cache = new Map<string, string[] | null>()
  const roots: UsageEvidence['roots'] = {}
  for (const e of entries) {
    // Only a genuine TOP-LEVEL entry can be a root: legacy's `agentMetrics.invocations[].agentId`
    // is always the harness id of something the MAIN transcript launched directly, and a nested
    // entry's own evidence is folded INTO whichever root claims it, never reported as its own.
    if (e.meta && isNestedAgent(e.meta) && e.meta.parentAgentId) continue
    try {
      const legacy = await legacyRootEvidence(loc.subagentsDir, e.agentId, cache)
      const projected = await projectedRootEvidence(loc.subagentsDir, e.agentId, entries, cache, mainById)
      if (legacy && projected) {
        roots[e.agentId] = {
          legacy,
          projected: { tokens: projected.tokens, costUSD: projected.costUSD, toolUseCount: projected.toolUseCount, toolStats: projected.toolStats },
          conflict: projected.conflict,
          mainSharedIds: projected.mainSharedIds,
        }
      }
    } catch { /* unreadable subagent: no evidence, so nothing about it can be explained */ }
  }
  return { main, mainBytes: Buffer.byteLength(text), roots }
}

export async function runDifferential(opts: DifferentialOptions): Promise<DifferentialReport & { diffs?: SessionDiff[] }> {
  const now = opts.now ?? Date.now
  const settledMs = opts.settledMs ?? 60_000
  const replay = createClaudeReplay({ projectsDir: opts.projectsDir, settledMs, now })
  const only = opts.sessionIds ? new Set(opts.sessionIds) : undefined
  const diffs: SessionDiff[] = []
  const summaries: SessionDiff[] = []
  const skipped = { live: 0, unreadable: 0 }

  for (const loc of await locate(opts.projectsDir, only)) {
    const st = await fsStat(loc.path).catch(() => null)
    if (!st) { skipped.unreadable++; continue }
    if (now() - st.mtimeMs < settledMs) { skipped.live++; continue }
    let diff: SessionDiff
    try {
      const batch = await replay.replay({ sessionId: loc.conversationId, sourceRef: `claude:${loc.conversationId}` }, null)
      const projection = project(sessionMetaProjection, batch.events as AnyAgentisticsEvent[])
      // A path outside any repository: git-derived halves are `partial` and never asserted.
      const legacy = await parseSessionJsonl(loc.path, loc.conversationId, '/nonexistent-differential', 'jsonl')
      const evidence = await evidenceFor(loc)
      diff = compareSession({ sessionId: loc.conversationId, legacy, projection, evidence })
    } catch {
      skipped.unreadable++
      continue
    }
    opts.onSession?.(diff)
    if (opts.keepDiffs) diffs.push(diff)
    // The summary needs the rows; values are dropped so a 500-session run does not hold them all.
    summaries.push({ sessionId: diff.sessionId, rows: diff.rows.map(r => ({ family: r.family, field: r.field, verdict: r.verdict, reason: r.reason })) })
  }
  const report = summarize(summaries, skipped)
  return opts.keepDiffs ? { ...report, diffs } : report
}
