/**
 * projections/differential-antigravity.ts — the parity row for Antigravity (agy), P2 §5.
 *
 * For every agy RUN the replay can read: the LEGACY `SessionMeta` (the very pipeline
 * `adapters/antigravity.ts`'s `loadSessions` runs, over the same bytes — `antigravity-parse.ts`,
 * rollup included) against the PROJECTED one (`integrations/antigravity`'s events folded through
 * `sessionMetaProjection`), field by field, in `differential.ts`'s vocabulary. No tolerance anywhere.
 *
 * ## What the projection needed to know about agy (landed in `session-meta.ts`, A3)
 *
 * Five things there were Claude-shaped; they were stubbed here first and now live in the shared
 * projection, so the rows below measure the replay and not a gap:
 * 1. `TURNS_SINCE` / `TURN_END_SINCE` gain `antigravity: '1.0.0'` — without it every human turn the
 *    replay emits is read as "not recorded by this adapter version";
 * 2. `tool_counts` is keyed by `canonicalName` (Claude's replay emits `canonicalName === name`, so
 *    this is a no-op for Claude) — legacy agy counts `canonicalTool` names;
 * 3. `uses_mcp` / `uses_web_search` / `uses_web_fetch` / `uses_task_agent` read agy's OWN raw names
 *    (`WEB_SEARCH_TOOLS`, `WEB_FETCH_TOOLS`, the `mcp_` prefix, `invoke_subagent`) — the projection
 *    tests Claude's `WebSearch` / `WebFetch` / `mcp__`;
 * 4. `tool_errors` / `tool_error_categories` count the main agent's `tool.failed` AND `model.failed`
 *    by `errorClass` — legacy agy counts an ERROR_MESSAGE step as an error and names its categories
 *    `error_<code>` / `exit_code` / `status_error`, never by tool;
 * 5. a `model.completed` whose `model` is `''` (a row with no `1.19`) never becomes the session's model
 *    — legacy counts its tokens and never its (absent) model id.
 *
 * ## The explanations — each one PROVEN per session, or the row stays a bug
 *
 * Every explanation below is applied only when an independent recount of the raw bytes reproduces
 * BOTH sides for the session in hand.
 */
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import {
  activeMinutesOf,
  project,
  sessionCostUSD,
  sessionTokenTotal,
  type AnyAgentisticsEvent,
  type SessionMeta,
  type TurnEvent,
} from '@agentistics/core'
import {
  WEB_FETCH_TOOLS, WEB_SEARCH_TOOLS, REPLAY_TYPES, extractUserRequest, isSlashCommandPrompt,
  parseAntigravityTranscriptDetailed, rollUpAntigravitySessions,
  type AntigravityParsed,
} from '../adapters/antigravity-parse'
import { readAntigravityTokensFromFile } from '../adapters/antigravity'
import { buildAntigravityIndex, replayRun, type AntigravityIndex } from '../integrations/antigravity'
import { childAgentIdOf } from '../integrations/antigravity/replay-core'
import {
  compareSession, summarize, type DifferentialReport, type FieldRow, type SessionDiff,
} from './differential'
import {
  TURN_END_SINCE, TURNS_SINCE, sessionMetaProjection, type SessionMetaProjection,
} from './session-meta'

export const ANTIGRAVITY_EXPLANATIONS = {
  durationRounded:
    'the projection rounds duration to whole minutes as Claude\'s legacy does, while agy\'s legacy keeps '
    + 'the fraction; (end - start) / 60000 over the recorded instants reproduces legacy and its Math.round the projection',
  dailyNew:
    'per-UTC-day slicing is new for agy (P2 §3): legacy agy writes no `daily`, and the projected days sum '
    + 'exactly to the projected session totals',
  childRollup:
    'legacy folds each invoke_subagent child conversation into the parent session '
    + '(rollUpAntigravitySessions); the replay reports it as a child Agent, so the parent alone — '
    + 'legacy\'s own parser over the parent\'s transcript and gen_metadata, unmerged — reproduces the projection',
  childAgentNew:
    'the child conversation is a child Agent under the run (P2 §2), an improvement over legacy, which '
    + 'has no agentMetrics for agy; each invocation equals legacy\'s own parse of that child conversation '
    + 'alone (tokens and cost), and the totals equal legacy\'s rollup minus the parent alone',
  slashTurn:
    'legacy opens an active-time turn only on a non-slash USER_INPUT while counting slash commands as '
    + 'user messages; the replay emits turn.started for every counted USER_INPUT (D22), and recomputing '
    + 'activeMinutesOf over the steps with slash prompts as openers reproduces the projection',
  interruptionsZero:
    'legacy agy hard-codes user_interruptions: 0 (it measures no interruption); the projection derives '
    + 'count - 1 from turn.started — declared not-projectable for agy',
} as const

// ── The projection ──────────────────────────────────────────────────────────────────────────────

/** The projection of one agy event stream. The five shared changes this module once stubbed (see the
 *  header) have landed in `session-meta.ts`: the `*_SINCE` entries, canonical `tool_counts`, and
 *  `HARNESS_TOOL_RULES.antigravity` for the `uses_*` flags, the error figures and the first model. */
export function projectAntigravity(events: readonly AnyAgentisticsEvent[]): SessionMetaProjection {
  return project(sessionMetaProjection, events)
}

// ── Legacy, over a chosen root ──────────────────────────────────────────────────────────────────

interface Legacy {
  sessions: Map<string, SessionMeta>
  /** Every parsed conversation's own parse, UNMERGED (runs and children) — the rollup proofs. */
  own: Map<string, SessionMeta>
}

/**
 * `antigravityAdapter.loadSessions`, step for step, over `rootDir` (the adapter reads the
 * process-wide `ANTIGRAVITY_DIR`, which a fixture cannot move). The discovery half is the replay's
 * own index, which is built from the same exported functions (`buildAntigravityParentMap`, the
 * history maps); the real-store run cross-checks this reconstruction against the adapter itself.
 */
export async function legacyAntigravitySessions(rootDir: string, index: AntigravityIndex): Promise<Legacy> {
  const conv = join(rootDir, 'conversations')
  const parsedById = new Map<string, AntigravityParsed>()
  const parentOf = new Map<string, string>()
  for (const [runId, children] of index.runs) {
    for (const c of children) parentOf.set(c.conversationId, c.parent)
    void runId
  }
  const ids = new Set<string>([...index.runs.keys()])
  for (const children of index.runs.values()) for (const c of children) ids.add(c.conversationId)
  for (const id of ids) {
    const path = index.transcriptOf.get(id)
    const tokens = await readAntigravityTokensFromFile(join(conv, `${id}.db`))
    if (!path) {
      // Legacy's tokens-only stub for a child whose brain/ was pruned.
      if (!tokens) continue
      parsedById.set(id, {
        modifiedFiles: [],
        session: {
          session_id: id, project_path: '', start_time: '', duration_minutes: 0, user_message_count: 0,
          assistant_message_count: 0, tool_counts: {}, tool_output_tokens: {}, agent_file_reads: {},
          languages: [], git_commits: 0, git_pushes: 0, input_tokens: tokens.inputTokens,
          output_tokens: tokens.outputTokens, cache_read_input_tokens: tokens.cachedTokens,
          cache_creation_input_tokens: 0, first_prompt: '', user_interruptions: 0, user_response_times: [],
          tool_errors: 0, tool_error_categories: {}, uses_task_agent: false, uses_mcp: false,
          uses_web_search: false, uses_web_fetch: false, lines_added: 0, lines_removed: 0, files_modified: 0,
          message_hours: [], user_message_timestamps: [], model: tokens.modelId || undefined,
          harness: 'antigravity', _source: 'jsonl',
        },
      })
      continue
    }
    const content = await readFile(path, 'utf-8').catch(() => '')
    if (!content) continue
    const parsed = parseAntigravityTranscriptDetailed(content, id, index.workspaces.get(id) ?? '', {
      historyEntries: index.history, tokens, summary: index.summaries.get(id) ?? null,
      allowNoUserTurn: parentOf.has(id),
    })
    if (parsed) parsedById.set(id, parsed)
  }
  const own = new Map<string, SessionMeta>()
  for (const [id, p] of parsedById) own.set(id, p.session)
  const rolled = rollUpAntigravitySessions(parsedById, parentOf)
  const sessions = new Map<string, SessionMeta>()
  for (const s of rolled) if (s && s.start_time) sessions.set(s.session_id, s)
  return { sessions, own }
}

// ── Proofs ──────────────────────────────────────────────────────────────────────────────────────

/** Legacy's turn events over the raw transcript, with slash prompts as openers or not. */
function recountActive(content: string, slashOpens: boolean): number | undefined {
  const seen = new Set<number>()
  const ev: TurnEvent[] = []
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let s: Record<string, unknown>
    try { s = JSON.parse(line) } catch { continue }
    if (!s || typeof s !== 'object') continue
    const type = typeof s.type === 'string' ? s.type : ''
    if (REPLAY_TYPES.has(type)) continue
    const idx = typeof s.step_index === 'number' ? s.step_index : null
    if (idx !== null) { if (seen.has(idx)) continue; seen.add(idx) }
    const ms = typeof s.created_at === 'string' && s.created_at ? Date.parse(s.created_at) : NaN
    if (Number.isNaN(ms)) continue
    const e: TurnEvent = { ts: ms }
    if (type === 'USER_INPUT') {
      const text = extractUserRequest(typeof s.content === 'string' ? s.content : '')
      if (text && (slashOpens || !isSlashCommandPrompt(text))) e.userPrompt = true
    }
    ev.push(e)
  }
  return activeMinutesOf(ev)
}

const ROLLUP_FIELDS = new Set([
  'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'costUSD', 'model',
  'tool_counts', 'tool_errors', 'tool_error_categories', 'uses_mcp', 'uses_web_search', 'uses_web_fetch',
  'lines_added', 'lines_removed', 'files_modified', 'end_time', 'duration_minutes', 'start_time',
  'context_tokens', 'context_window',
])

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function explain(
  rows: FieldRow[], legacy: SessionMeta, own: SessionMeta | undefined, p: SessionMetaProjection, content: string,
  children?: { agentId: string; own: SessionMeta | undefined }[],
): void {
  const hasChild = !!p.meta.agentMetrics
  const invs = new Map((p.meta.agentMetrics?.invocations ?? []).map(i => [i.agentId, i]))
  const total = (s: SessionMeta): number => sessionTokenTotal(s)
  const childOk = (c: { agentId: string; own: SessionMeta | undefined }): boolean => {
    const inv = invs.get(c.agentId)
    return !!inv && !!c.own && inv.totalTokens === total(c.own) && inv.costUSD === sessionCostUSD(c.own)
  }
  const childProof = (r: FieldRow, cs: NonNullable<typeof children>): boolean => {
    if (!cs.every(childOk)) return false
    const m = /^agentMetrics\.invocations\[(.+)\]$/.exec(r.field)
    if (m) return cs.some(c => c.agentId === m[1])
    const am = p.meta.agentMetrics!
    const ordered = am.invocations.map(i => cs.find(c => c.agentId === i.agentId)!.own!)
    if (r.field === 'agentMetrics.totalInvocations') return r.legacy === 0 && am.totalInvocations === cs.length
    if (r.field === 'agentMetrics.totalTokens') {
      return r.legacy === 0 && am.totalTokens === ordered.reduce((n, s) => n + total(s), 0)
        && (own ? total(legacy) - total(own) === am.totalTokens : false)
    }
    if (r.field === 'agentMetrics.totalCostUSD') {
      return r.legacy === 0 && am.totalCostUSD === ordered.reduce((n, s) => n + (sessionCostUSD(s) ?? 0), 0)
    }
    return false
  }
  for (const r of rows) {
    if (r.verdict !== 'bug') continue
    // (1) duration rounding.
    if (r.field === 'duration_minutes' && typeof r.legacy === 'number' && legacy.end_time) {
      const recount = (Date.parse(legacy.end_time) - Date.parse(legacy.start_time)) / 60000
      if (recount === r.legacy && Math.round(recount) === r.projected) {
        r.verdict = 'explained'; r.reason = ANTIGRAVITY_EXPLANATIONS.durationRounded; continue
      }
    }
    // (2) per-day slicing, new for agy.
    if (r.field.startsWith('daily.') && r.legacy === undefined && !legacy.daily) {
      const days = Object.values(p.meta.daily_tokens ?? {})
      const sum = days.reduce((a, d) => ({
        input: a.input + d.input, output: a.output + d.output, cacheRead: a.cacheRead + d.cacheRead, cacheWrite: a.cacheWrite + d.cacheWrite,
      }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
      if (sum.input === p.meta.input_tokens && sum.output === p.meta.output_tokens
        && sum.cacheRead === p.meta.cache_read_input_tokens && sum.cacheWrite === p.meta.cache_creation_input_tokens) {
        r.verdict = 'explained'; r.reason = ANTIGRAVITY_EXPLANATIONS.dailyNew; continue
      }
    }
    // (3) the child rollup: legacy's parent alone reproduces the projection.
    if (hasChild && own && ROLLUP_FIELDS.has(r.field)) {
      const ownVal = r.field === 'costUSD' ? null : (own as unknown as Record<string, unknown>)[r.field]
      const projVal = r.field === 'duration_minutes' && typeof ownVal === 'number' ? Math.round(ownVal) : ownVal
      if (r.field !== 'costUSD' && same(projVal ?? undefined, r.projected ?? undefined)) {
        r.verdict = 'explained'; r.reason = ANTIGRAVITY_EXPLANATIONS.childRollup; continue
      }
    }
    // (4) the child agent itself: each invocation is its child conversation parsed ALONE by legacy.
    if (hasChild && children && r.field.startsWith('agentMetrics.') && childProof(r, children)) {
      r.verdict = 'explained'; r.reason = ANTIGRAVITY_EXPLANATIONS.childAgentNew; continue
    }
    // (5) slash commands opening a turn.
    if (r.field === 'active_minutes' && recountActive(content, false) === r.legacy && recountActive(content, true) === r.projected) {
      r.verdict = 'explained'; r.reason = ANTIGRAVITY_EXPLANATIONS.slashTurn; continue
    }
  }
  // Declared, not a bug: legacy agy never measures interruptions.
  for (const r of rows) {
    if (r.field === 'user_interruptions' && r.verdict === 'bug' && r.legacy === 0) {
      r.verdict = 'not-projectable'; r.reason = ANTIGRAVITY_EXPLANATIONS.interruptionsZero
    }
  }
  // costUSD on a rollup session: the parent alone priced as legacy prices it equals the projection.
  const cost = rows.find(r => r.field === 'costUSD')
  if (cost && cost.verdict === 'bug' && hasChild && own) {
    if (sessionCostUSD(own) === cost.projected) { cost.verdict = 'explained'; cost.reason = ANTIGRAVITY_EXPLANATIONS.childRollup }
  }
}

// ── Run it ──────────────────────────────────────────────────────────────────────────────────────

export interface AntigravityDifferentialOptions {
  /** `~/.gemini/antigravity-cli` or a fixture. Read only. */
  rootDir: string
  /** Default: now. Every run older than `settledMs` is read `final`. */
  now?: () => number
  settledMs?: number
  keepDiffs?: boolean
  onSession?: (d: SessionDiff) => void
}

export async function runAntigravityDifferential(
  opts: AntigravityDifferentialOptions,
): Promise<DifferentialReport & { diffs?: SessionDiff[]; legacyOnly: string[]; replayOnly: string[] }> {
  const rootDir = opts.rootDir
  const paths = {
    brain: join(rootDir, 'brain'), conversations: join(rootDir, 'conversations'),
    history: join(rootDir, 'history.jsonl'), summaries: join(rootDir, 'conversation_summaries.db'),
  }
  const index = await buildAntigravityIndex(paths)
  const legacy = await legacyAntigravitySessions(rootDir, index)
  const recordedAt = new Date((opts.now ?? Date.now)()).toISOString()

  const diffs: SessionDiff[] = []
  const replayed = new Set<string>()
  for (const runId of [...index.runs.keys()].sort()) {
    const events: AnyAgentisticsEvent[] = []
    const ok = await replayRun(paths, index, runId, recordedAt, true, e => events.push(e as AnyAgentisticsEvent))
    if (!ok) continue
    replayed.add(runId)
    const l = legacy.sessions.get(runId)
    if (!l) continue
    const p = projectAntigravity(events)
    const d = compareSession({ sessionId: runId, legacy: l, projection: p })
    const path = index.transcriptOf.get(runId)
    const content = path && existsSync(path) ? await readFile(path, 'utf-8').catch(() => '') : ''
    const children = (index.runs.get(runId) ?? []).map(c => ({
      agentId: childAgentIdOf(runId, c.conversationId), own: legacy.own.get(c.conversationId),
    }))
    explain(d.rows, l, legacy.own.get(runId), p, content, children)
    diffs.push(d)
    opts.onSession?.(d)
  }
  const legacyOnly = [...legacy.sessions.keys()].filter(id => !replayed.has(id)).sort()
  const replayOnly = [...replayed].filter(id => !legacy.sessions.has(id)).sort()
  const report = summarize(diffs)
  return { ...report, legacyOnly, replayOnly, ...(opts.keepDiffs ? { diffs } : {}) }
}
