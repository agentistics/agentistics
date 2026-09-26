import { readFile } from 'fs/promises'
import type { SessionDayUsage, SessionMeta, TurnEvent } from '@agentistics/core'
import { activeMinutesOf, charCount, emptyActiveTime, foldActiveTime, finishActiveTime } from '@agentistics/core'
import type { ActiveTimeState } from '@agentistics/core'
import { getSessionFileStats } from './git'
import { countGitCommands } from './harness-activity'
import { countUsage } from './usage-dedupe'
import { emptyAgentMetrics, foldAgentEntry, finishAgentMetrics, type AgentMetricsState } from './agent-metrics'
import { enrichFromSubagentTranscripts } from './subagent-metrics'
import { addDelta, editDelta, type EditDelta } from './edit-lines'

// File extension → language name (used when session-meta is absent)
export const EXT_TO_LANG: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
  mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', java: 'Java',
  cs: 'C#', cpp: 'C++', cc: 'C++', cxx: 'C++', c: 'C', h: 'C', hpp: 'C++',
  php: 'PHP', swift: 'Swift', kt: 'Kotlin', scala: 'Scala',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell',
  sql: 'SQL', html: 'HTML', css: 'CSS', scss: 'CSS', sass: 'CSS',
  json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', xml: 'XML',
  md: 'Markdown', mdx: 'Markdown',
  r: 'R', lua: 'Lua', dart: 'Dart', ex: 'Elixir', exs: 'Elixir',
  clj: 'Clojure', hs: 'Haskell', ml: 'OCaml', fs: 'F#',
  vue: 'Vue', svelte: 'Svelte',
}

// Agent-like instruction file patterns (basename matching)
export const AGENT_FILE_CATEGORY: Map<string, string> = new Map([
  ['claude.md', 'CLAUDE.md'],
  ['claude_instructions.md', 'CLAUDE.md'],
  ['agents.md', 'AGENTS.md'],
  ['codex.md', 'CODEX.md'],
  ['.cursorrules', '.cursorrules'],
  ['.cursorignore', 'cursor-config'],
  ['conventions.md', 'CONVENTIONS.md'],
  ['copilot-instructions.md', 'copilot-instructions'],
  ['.copilot-instructions.md', 'copilot-instructions'],
  ['.windsurfrules', '.windsurfrules'],
])

// Agent-like instruction file path patterns (directory-based matching)
// Use (^|\/) to match both absolute and relative paths
export const AGENT_PATH_PATTERNS: [RegExp, string][] = [
  [/(^|\/)\.claude\//i, '.claude/*'],
  [/(^|\/)\.github\/copilot-instructions/i, 'copilot-instructions'],
  [/(^|\/)\.cursor\//i, '.cursorrules'],
  [/(^|\/)\.windsurf\//i, '.windsurfrules'],
  [/(^|\/)AGENTS\.md$/i, 'AGENTS.md'],
  [/(^|\/)CLAUDE\.md$/i, 'CLAUDE.md'],
]

/** Classify a file path as an agent instruction file category or null */
export function classifyAgentFile(filePath: string): string | null {
  if (!filePath) return null
  const normalized = filePath.replace(/\\/g, '/')
  const basename = normalized.split('/').pop()?.toLowerCase() ?? ''

  const category = AGENT_FILE_CATEGORY.get(basename)
  if (category) return category

  for (const [pattern, cat] of AGENT_PATH_PATTERNS) {
    if (pattern.test(normalized)) return cat
  }

  return null
}

/**
 * TWO QUESTIONS, TWO PREDICATES — and for one release they were one, which silently emptied the
 * chat of every system note.
 *
 * `isUserRoleMessage` asks the CHAT's question: is this a `user`-role entry that is not a pure
 * `tool_result` being fed back? Everything else the harness writes under that role — a
 * `<system-reminder>`, a skill being loaded, an image being attached, a message from another
 * session — IS one of these, and `chat-envelope.ts` is what then classifies it into a note.
 *
 * `isHumanUserEntry` asks the COUNTER's question: did a PERSON take a turn? It excludes `isMeta`
 * and `isCompactSummary` on top, which is a measured correction to `user_message_count` and to the
 * turn boundary (see the comment inside it).
 *
 * Collapsing the two broke the chat: `chat-tail.ts` gates on the first question and was handed the
 * second, so every injected entry was DROPPED before `classifyUserEntry` ever saw it and the whole
 * note machinery rendered nothing. Its own doc comment stated the assumption that had quietly
 * stopped holding — "isHumanUserEntry only excludes a pure tool_result". Now it does again, under
 * its own name.
 */
export function isUserRoleMessage(e: Record<string, unknown>): boolean {
  if (e.type !== 'user') return false
  const msgContent = (e.message as Record<string, unknown> | undefined)?.content
  const contentArr = Array.isArray(msgContent) ? msgContent as Record<string, unknown>[] : null
  const isPureToolResult = contentArr !== null && contentArr.length > 0 &&
    contentArr.every(p => p.type === 'tool_result')
  return !isPureToolResult
}

/** True when a `type: 'user'` entry is a PERSON's message — not a tool result, and not something
 *  the harness injected under their role. A turn boundary depends on this distinction, and so does
 *  `user_message_count`; they must never disagree, hence one helper for both. */
export function isHumanUserEntry(e: Record<string, unknown>): boolean {
  if (!isUserRoleMessage(e)) return false
  // `isMeta` is Claude Code's own marker for an entry IT inserted under the user's role — the
  // `<local-command-caveat>` block that precedes a slash command's output. Nobody typed it, so it
  // is not a round and it is not a turn boundary. Measured 2026-09-08 across four real sessions:
  // the parser's count exceeded a hand recount by 22, 15, 7 and 1 — the isMeta count of each,
  // exactly. On a session that ran 22 local commands, "rounds" read 65 for 43 real messages.
  //
  // `sessionLabel` already strips these wrappers out of `first_prompt`, so the product had two
  // readings of the same entry: not-prose when labelling it, a person's turn when counting it.
  //
  // `isCompactSummary` is the other one, found the same way: the "This session is being continued
  // from a previous conversation that ran out of context" block, which Claude Code writes under the
  // user's role when it compacts. It was the last remaining discrepancy on the fourth session —
  // exactly one entry, exactly one round of difference.
  return !(e.isMeta === true || e.isCompactSummary === true)
}

/**
 * Active time for a Claude transcript, computed on its own — see docs/harness-contract.md.
 *
 * `parseSessionJsonl` collects the same events inline during its single pass. This standalone
 * version exists for the `_source: 'meta'` path in data.ts: Claude's own session-meta files carry
 * no per-turn timing, so the value has to come from the transcript, and that path deliberately
 * does not run the full parser.
 */
/**
 * The context one `usage` record says was SENT — PURE.
 *
 * The three INPUT-side counters are the prompt: `input_tokens` is the uncached remainder and the
 * two cache figures are the rest of the same prefix. `output_tokens` is excluded — it came back,
 * it was not sent. `0` for a record with no input side, which callers read as "no reading" rather
 * than as an empty context.
 */
export function contextOfUsage(u: Record<string, number> | undefined): number {
  if (!u) return 0
  return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
}

/**
 * The LAST context reading in a Claude transcript — PURE, `undefined` when there is none.
 *
 * A sibling of `activeMinutesFromClaudeJsonl` and for the same reason: `session-meta` is the
 * preferred source and serves most Claude sessions, so a metric that exists only inside
 * `parseSessionJsonl` is a metric most sessions never get. That is the exact bug the comment on
 * the active-time branch in `data.ts` records; this function is what keeps the gauge out of it.
 */
export function contextTokensFromClaudeJsonl(lines: string[]): number | undefined {
  let last = 0
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    let e: Record<string, unknown>
    try { e = JSON.parse(line) } catch { continue }
    if (e.type !== 'assistant') continue
    const msg = e.message as Record<string, unknown> | undefined
    const sent = contextOfUsage(msg?.usage as Record<string, number> | undefined)
    if (sent > 0) last = sent
  }
  return last > 0 ? last : undefined
}

/** What a session's compactions cost it. `droppedTokens` is absent when no record reported one. */
export interface CompactStats {
  count: number
  ms: number
  droppedTokens?: number
}

/**
 * COMPACTIONS, off the raw transcript — PURE.
 *
 * `cumulativeDroppedTokens` is CUMULATIVE and monotonic, so it is a MAX and never a sum: measured
 * on a real five-compact session it runs 954.238 → 4.785.215, and adding those reports 14,4M for a
 * session that dropped 4,8M. The field is also frequently absent (27 of 46 real records), and an
 * absent measurement stays `undefined` — a `0` there would claim a session that compacted five
 * times dropped nothing.
 *
 * Takes an `Iterable<string>` rather than an array so the caller can pass `iterLines(content)`
 * directly. `parseSessionJsonl` deliberately never materialises its lines — the header on
 * `iterLines` records why, with the measurement — and an array parameter here would have forced it
 * to.
 */
export function compactsFromClaudeJsonl(lines: Iterable<string>): CompactStats {
  const state: ClaudeParseState['compact'] = { count: 0, ms: 0, dropped: undefined }
  for (const line of lines) {
    // Cheap reject before the parse: most lines are not this.
    if (!line.includes('compact_boundary')) continue
    let e: Record<string, unknown>
    try { e = JSON.parse(line) as Record<string, unknown> } catch { continue }
    foldCompactEntry(state, e)
  }
  return finishCompacts(state)
}

/**
 * SKILL INVOCATIONS, by the skill's own name — PURE.
 *
 * A skill is a `Skill` tool_use whose `input.skill` names it. A call with no readable name is
 * skipped rather than filed under a placeholder: an invented bucket would show up in the profile as
 * a skill somebody uses.
 */
export function skillUsesFromClaudeJsonl(lines: Iterable<string>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of lines) {
    if (!line.includes('"Skill"')) continue
    let e: Record<string, unknown>
    try { e = JSON.parse(line) as Record<string, unknown> } catch { continue }
    foldSkillEntry(out, e)
  }
  return out
}

export function activeMinutesFromClaudeJsonl(lines: string[]): number | undefined {
  const events: TurnEvent[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    let e: Record<string, unknown>
    try { e = JSON.parse(line) } catch { continue }
    const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN
    if (Number.isNaN(ts)) continue
    const event: TurnEvent = { ts }
    if (e.type === 'system' && e.subtype === 'turn_duration' && typeof e.durationMs === 'number') {
      event.measuredMs = e.durationMs
    } else if (isHumanUserEntry(e)) {
      event.userPrompt = true
    }
    events.push(event)
  }
  return activeMinutesOf(events)
}

export function makeEmptySession(
  sessionId: string,
  projectPath: string,
  startTime: string,
  firstPrompt: string,
  source: 'jsonl' | 'subdir'
): SessionMeta {
  return {
    session_id: sessionId,
    project_path: projectPath,
    start_time: startTime,
    duration_minutes: 0,
    user_message_count: 0,
    assistant_message_count: 0,
    tool_counts: {},
    tool_output_tokens: {},
    agent_file_reads: {},
    languages: [],
    git_commits: 0,
    git_pushes: 0,
    input_tokens: 0,
    output_tokens: 0,
    first_prompt: firstPrompt,
    user_interruptions: 0,
    user_response_times: [],
    tool_errors: 0,
    tool_error_categories: {},
    uses_task_agent: false,
    uses_mcp: false,
    uses_web_search: false,
    uses_web_fetch: false,
    lines_added: 0,
    lines_removed: 0,
    files_modified: 0,
    message_hours: [],
    user_message_timestamps: [],
    harness: 'claude',
    _source: source,
  }
}

/**
 * Walk a file's lines WITHOUT materialising them as an array.
 *
 * `content.split('\n')` allocates a second copy of every byte in the file, plus a string header
 * per line — and this parser used to do it TWICE on the same content (once for the main loop, once
 * for `extractAgentMetrics`). On a 25 MB transcript that is ~50 MB of strings for a file already
 * held whole in memory, and `scanProjects` runs 30 of these concurrently.
 *
 * Measured on a real store (862 MB of transcripts across 2.694 files): the boot warm-build peaked
 * at 1.095 MB RSS. The peak is what matters, not the settled figure — it is what makes a laptop
 * swap, and several agentop instances plus the assistants they are watching share that machine.
 *
 * A generator yields each line as it is found, so the peak holds one line at a time on top of the
 * file itself. `trim()` stays the caller's job — the two callers already do it, and doing it here
 * would allocate a second string per line for no gain.
 */
export function* iterLines(content: string): Generator<string> {
  let start = 0
  for (;;) {
    const nl = content.indexOf('\n', start)
    if (nl === -1) {
      if (start < content.length) yield content.slice(start)
      return
    }
    yield content.slice(start, nl)
    start = nl + 1
  }
}

/**
 * The characters of one message's TEXT, as a person would count them.
 *
 * Text parts only: a `tool_use` block's JSON input and a `tool_result`'s payload are not something
 * anybody wrote, and folding them in would make "characters per prompt" a measure of how much
 * machinery ran. Code points rather than `String.length`, matching the counter under the composer
 * (`promptCount.ts`) — two numbers about the same text have to agree.
 */
function textChars(content: unknown): number {
  if (typeof content === 'string') return charCount(content)
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const part of content as Record<string, unknown>[]) {
    if (part?.type === 'text' && typeof part.text === 'string') n += charCount(part.text)
  }
  return n
}

/** Fold ONE already-parsed entry into a running compaction tally — see `compactsFromClaudeJsonl`. */
export function foldCompactEntry(state: ClaudeParseState['compact'], e: Record<string, unknown>): void {
  if (e.type !== 'system' || e.subtype !== 'compact_boundary') return
  const meta = e.compactMetadata as Record<string, unknown> | undefined
  if (!meta) return
  state.count++
  if (typeof meta.durationMs === 'number') state.ms += meta.durationMs
  const c = meta.cumulativeDroppedTokens
  if (typeof c === 'number') state.dropped = Math.max(state.dropped ?? 0, c)
}

/** Fold ONE already-parsed entry into a running skill tally — see `skillUsesFromClaudeJsonl`. */
export function foldSkillEntry(out: Record<string, number>, e: Record<string, unknown>): void {
  const msg = e.message as Record<string, unknown> | undefined
  const content = msg?.content
  if (!Array.isArray(content)) return
  for (const p of content as Record<string, unknown>[]) {
    if (p.type !== 'tool_use' || p.name !== 'Skill') continue
    const input = p.input as Record<string, unknown> | undefined
    const name = input?.skill
    if (typeof name !== 'string' || name === '') continue
    out[name] = (out[name] ?? 0) + 1
  }
}

/** How many lines of a transcript the enrichment path looks at for its model id. */
const MODEL_SCAN_LINES = 200

/**
 * The two model readings and the un-deduped context gauge, off one already-parsed entry.
 *
 * `state.modelId` — the first `claude-*` anywhere — is set by the main loop's own assistant branch
 * and is not touched here. These are the readings the ENRICHMENT path takes, which are different
 * questions with different answers; see `ClaudeParseState.modelFirst200` and `.contextTokensAny`.
 */
export function foldModelSeen(state: ClaudeParseState, e: Record<string, unknown>): void {
  if (e.type !== 'assistant') return
  const msg = e.message as Record<string, unknown> | undefined
  if (!state.modelFirst200 && state.lineNo <= MODEL_SCAN_LINES) {
    const m = msg?.model
    if (typeof m === 'string' && m && m.startsWith('claude-')) state.modelFirst200 = m
  }
  const sent = contextOfUsage(msg?.usage as Record<string, number> | undefined)
  if (sent > 0) state.contextTokensAny = sent
}

/**
 * Everything the walk over a Claude transcript carries from one line to the next.
 *
 * It is a TYPE rather than a pile of locals because the walk has to be RESUMABLE. A live
 * transcript grows on every turn, so the stamp `parse-cache.ts` keys on changes on every turn and
 * the cached row misses — and the parser then read the whole file again from byte zero, re-parsing
 * every line it had already parsed. Measured here: 400 / 1004 / 312 ms of CPU for ONE pass over the
 * three largest live transcripts on this machine (26,4 / 21,4 / 12,4 MB), re-paid on every rebuild
 * for as long as anybody is watching a dashboard. `transcript-cursor.ts` says which BYTES are new;
 * this says what to do with them without re-reading the rest.
 *
 * Every field is an accumulator that only ever moves FORWARD, which is what makes resuming sound:
 * folding lines 1..n then n+1..m gives the same state as folding 1..m. The two that are not sums
 * are `contextTokens` (a gauge — last wins) and the "first one seen" strings, and both are
 * last-write/first-write over the same ordered stream, so the property holds for them too.
 *
 * It also carries what USED TO BE SEPARATE PASSES. `parseSessionJsonl` ran `extractAgentMetrics`,
 * `compactsFromClaudeJsonl` and `skillUsesFromClaudeJsonl` over `iterLines(content)` after its own
 * loop — four `JSON.parse` of every line of the same file — and `cachedEnrich` ran five more over
 * a second copy. They fold off the entry this walk has already parsed.
 */
export interface ClaudeParseState {
  /** How many lines have been folded. Only `modelFirst200` reads it — see its note. */
  lineNo: number
  cwd: string
  lastCwd: string
  startTime: string
  lastTime: string
  firstPrompt: string
  modelId: string
  sessionTitle: string
  userChars: number
  userCharMsgs: number
  assistantChars: number
  assistantCharMsgs: number
  userMsgs: number
  assistantMsgs: number
  inputTokens: number
  outputTokens: number
  /** The session's work, SPLIT BY DAY — see `SessionMeta.daily`. */
  daily: Map<string, SessionDayUsage>
  cacheReadTokens: number
  cacheCreationTokens: number
  /**
   * The TTL split of `cacheCreationTokens` — see `ModelUsage.cacheCreation1hInputTokens`. Summed
   * from `message.usage.cache_creation.{ephemeral_1h,ephemeral_5m}_input_tokens`, under the SAME
   * dedupe gate as every other usage counter. `sawCacheCreationBreakdown` tracks whether at least
   * one counted line carried the nested object at all — an older transcript format has none, and
   * these stay unwritten rather than a guessed 0/0 split.
   */
  cacheCreation1hTokens: number
  cacheCreation5mTokens: number
  sawCacheCreationBreakdown: boolean
  /** How full the window was on the LAST turn — a gauge, reassigned rather than accumulated. */
  contextTokens: number
  /**
   * The same gauge under `contextTokensFromClaudeJsonl`'s rule: the last reading, WITHOUT the
   * usage dedupe.
   *
   * Two readings of one number, kept apart on purpose. `contextTokens` above is taken only from a
   * `usage` record this walk actually counted (`countUsage`), which is the rule `parseSessionJsonl`
   * has always applied; the standalone reader `cachedEnrich` calls applies neither. They agree on
   * every transcript measured — a repeated `message.id` repeats its usage byte for byte, so "the
   * last counted reading" and "the last reading" are the same number — and agreeing is not the same
   * as being one rule. Two integers is what it costs to keep both callers answering exactly what
   * they answered before this state existed.
   */
  contextTokensAny: number
  /** The message ids whose usage has already been counted — see `usage-dedupe.ts`. */
  countedUsageIds: Set<string>
  gitCommits: number
  gitPushes: number
  toolErrors: number
  userInterruptions: number
  hasMcp: boolean
  /** Did any tool result NAME an agent? See the gate in `finishClaudeSession`. */
  sawAgentLaunch: boolean
  claudeFilesModified: Set<string>
  /** Lines this session's OWN edits changed — see `edit-lines.ts`. */
  editLines: EditDelta
  toolCounts: Record<string, number>
  toolOutputTokens: Record<string, number>
  agentFileReads: Record<string, number>
  toolErrorCategories: Record<string, number>
  messageHours: number[]
  userMessageTimestamps: string[]
  userResponseTimes: number[]
  languageSet: Set<string>
  /** Maps tool_use_id → tool name for error attribution. */
  toolUseIdToName: Map<string, string>
  lastAssistantTs: string
  /**
   * Per-turn timing, folded rather than stored — see `activeTime.ts`.
   *
   * The events themselves are NOT kept: one object per timestamped line, held for as long as the
   * session runs, is the memory this whole change exists to stop spending. `foldClaudeParse`
   * builds the events for the lines it is reading right now, folds them, and lets them go.
   */
  active: ActiveTimeState
  /** What compaction has cost so far. `dropped` is CUMULATIVE — a max, never a sum. */
  compact: { count: number; ms: number; dropped: number | undefined }
  /** Skill invocations by name. */
  skillUses: Record<string, number>
  /** Agent launches — see `agent-metrics.ts`. Priced at finish, not here. */
  agents: AgentMetricsState
  /**
   * The first `claude-*` model in the transcript's opening 200 LINES.
   *
   * `modelId` above is the first one anywhere in the file, which is what `parseSessionJsonl` has
   * always used. The enrichment path capped its own search at 200 lines, and a session whose first
   * assistant message falls past that line has NO model there — which is a different answer, and it
   * is the answer that priced those sessions. Unifying the two would silently re-price them, so
   * both are kept and each caller reads its own.
   */
  modelFirst200: string
}

/** The day this line falls on, created on first sight. UTC, per `tagSessionDay`. */
function dayOf(daily: Map<string, SessionDayUsage>, iso: string | undefined): SessionDayUsage | null {
  if (!iso || iso.length < 10) return null
  const key = iso.slice(0, 10)
  let d = daily.get(key)
  if (!d) {
    d = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, messages: 0, hours: {} }
    daily.set(key, d)
  }
  return d
}

/** A walk that has read nothing. */
export function emptyClaudeParse(): ClaudeParseState {
  return {
    lineNo: 0,
    cwd: '', lastCwd: '', startTime: '', lastTime: '', firstPrompt: '', modelId: '', sessionTitle: '',
    userChars: 0, userCharMsgs: 0, assistantChars: 0, assistantCharMsgs: 0,
    userMsgs: 0, assistantMsgs: 0, inputTokens: 0, outputTokens: 0,
    daily: new Map(),
    cacheReadTokens: 0, cacheCreationTokens: 0,
    cacheCreation1hTokens: 0, cacheCreation5mTokens: 0, sawCacheCreationBreakdown: false,
    contextTokens: 0, contextTokensAny: 0,
    countedUsageIds: new Set(),
    gitCommits: 0, gitPushes: 0,
    toolErrors: 0, userInterruptions: 0,
    hasMcp: false, sawAgentLaunch: false,
    claudeFilesModified: new Set(),
    editLines: { added: 0, removed: 0 },
    toolCounts: {}, toolOutputTokens: {}, agentFileReads: {}, toolErrorCategories: {},
    messageHours: [], userMessageTimestamps: [], userResponseTimes: [],
    languageSet: new Set(),
    toolUseIdToName: new Map(),
    lastAssistantTs: '',
    active: emptyActiveTime(),
    compact: { count: 0, ms: 0, dropped: undefined },
    skillUses: {},
    agents: emptyAgentMetrics(),
    modelFirst200: '',
  }
}

/**
 * A copy of `state`, deep enough that folding into the copy can never mutate the original.
 *
 * `foldClaudeParse` (and the folds it delegates to) writes into most of this shape IN PLACE rather
 * than reassigning — `state.daily`'s own `SessionDayUsage` records (and their `hours` bucket), the
 * `Map`/`Set` accumulators, the plain-object tallies, and the three nested walks (`active`,
 * `compact`, `agents.pendingAgents`/`agents.recordedAgentIds`) are all mutated through methods or
 * key assignment, not replaced — so a shallow `{ ...state }` would still share every one of those
 * containers with the original, and folding into the "copy" would fold into the original too.
 *
 * This exists so a fold can be tried without committing it: clone first, fold the clone, and only
 * then let the caller publish it — see `transcript-state.ts`'s append path, which must leave the
 * retained walk completely untouched when a fold throws partway through, so the next poll retries
 * the identical read rather than doubling whatever had already been folded.
 */
export function cloneClaudeParseState(state: ClaudeParseState): ClaudeParseState {
  const daily = new Map<string, SessionDayUsage>()
  for (const [key, day] of state.daily) {
    daily.set(key, { ...day, hours: day.hours ? { ...day.hours } : day.hours })
  }
  return {
    ...state,
    daily,
    countedUsageIds: new Set(state.countedUsageIds),
    claudeFilesModified: new Set(state.claudeFilesModified),
    languageSet: new Set(state.languageSet),
    toolUseIdToName: new Map(state.toolUseIdToName),
    editLines: { ...state.editLines },
    toolCounts: { ...state.toolCounts },
    toolOutputTokens: { ...state.toolOutputTokens },
    agentFileReads: { ...state.agentFileReads },
    toolErrorCategories: { ...state.toolErrorCategories },
    messageHours: [...state.messageHours],
    userMessageTimestamps: [...state.userMessageTimestamps],
    userResponseTimes: [...state.userResponseTimes],
    active: { ...state.active },
    compact: { ...state.compact },
    skillUses: { ...state.skillUses },
    agents: {
      pendingAgents: new Map(state.agents.pendingAgents),
      invocations: [...state.agents.invocations],
      recordedAgentIds: new Set(state.agents.recordedAgentIds),
    },
    modelFirst200: state.modelFirst200,
  }
}

/**
 * A caller that wants the entries this walk already parsed, without paying for a second
 * `JSON.parse` of the same file — the canonical-events replay fold is exactly this caller (see
 * `integrations/claude/replay.ts`). It is called once per successfully parsed line, with the SAME
 * 1-based `lineNo` this walk counts every raw line by (blanks included), so a record this sink
 * names by line number and a record `lineRef()` names by the same number are the same line.
 *
 * It observes; it must never influence what is parsed. A blank line and a line that fails to parse
 * are never delivered — there is no entry to hand it — and a sink that THROWS is caught and
 * ignored, silently and per line, because a bug in an optional observer must not be the reason a
 * session's own metrics stop being computed. It receives the walk's own parsed object and must not
 * MUTATE it: the folds below read the same object after it.
 */
export type ClaudeParseSink = (entry: Record<string, unknown>, lineNo: number) => void

/**
 * Advance `state` over `lines`, in transcript order. Mutates `state`; returns nothing.
 *
 * The body is `parseSessionJsonl`'s own loop, unchanged except that its locals now live on
 * `state` — so a transcript folded in one call and the same transcript folded in ten produce the
 * same numbers, and the numbers are the ones this parser has always produced.
 *
 * `turnEvents` is deliberately still an ARRAY, and a local one: the loop builds an event and then
 * mutates it from a LATER branch (a `turn_duration` line closes the turn it opened, a human message
 * marks the event it arrived on), so the events of one chunk cannot be folded until the chunk is
 * done. Its length is the length of THIS chunk, never of the file.
 */

export function foldClaudeParse(state: ClaudeParseState, lines: Iterable<string>, sink?: ClaudeParseSink): void {
  const turnEvents: TurnEvent[] = []
  for (const raw of lines) {
    state.lineNo++
    const line = raw.trim()
    if (!line) continue
    let e: Record<string, unknown>
    try { e = JSON.parse(line) } catch { continue }

    if (sink) { try { sink(e, state.lineNo) } catch { /* an observer's bug must not break parsing */ } }

    // The passes this walk replaces. Each used to re-read the whole file and re-`JSON.parse` every
    // line of it to answer one question; each now folds off the entry already in hand. They are
    // first in the loop, before any of the branches below that `continue`, so nothing can skip one.
    foldCompactEntry(state.compact, e)
    foldSkillEntry(state.skillUses, e)
    foldAgentEntry(state.agents, e)
    foldModelSeen(state, e)

    // First state.cwd = the project the session belongs to; last state.cwd = where it is now. They differ when
    // the session moved (a git worktree), and the live-session detector needs the latter.
    if (e.cwd && typeof e.cwd === 'string') {
      if (!state.cwd) state.cwd = e.cwd
      state.lastCwd = e.cwd
    }
    // `as string` alone is a compile-time promise only — a malformed transcript line can carry a
    // number here just as Kimi's state.json did for its own timestamp fields (see
    // isoFromKimiTime/normalizeSessionTimes), and every consumer downstream calls a string method
    // on `state.startTime`/`endTime` (parseISO, .slice, .localeCompare). Verify the runtime type here,
    // at the one place this value enters the pipeline, rather than trusting it all the way down.
    const ts = typeof e.timestamp === 'string' ? e.timestamp : undefined
    let turnEvent: TurnEvent | null = null
    if (ts) {
      if (!state.startTime) state.startTime = ts
      state.lastTime = ts
      /**
       * WHEN this line happened, twice: once lifetime and once ON ITS OWN DAY.
       *
       * The same value into both, from the same parse, so the day split can never disagree with
       * the lifetime array about what hour a line fell in — the whole point of `hours` is that a
       * date-filtered chart can be rebuilt from it and read the same as the unfiltered one.
       * Local clock, per the harness contract (§ timestamps); the DAY key stays UTC, per
       * `tagSessionDay`, which is the rule every other day series in this product uses.
       */
      try {
        const hour = new Date(ts).getHours()
        state.messageHours.push(hour)
        const d = dayOf(state.daily, ts)
        if (d) { d.hours ??= {}; d.hours[hour] = (d.hours[hour] ?? 0) + 1 }
      } catch { /* skip */ }
      const tsMs = Date.parse(ts)
      if (!Number.isNaN(tsMs)) {
        turnEvent = { ts: tsMs }
        turnEvents.push(turnEvent)
      }
    }

    // Claude Code measures each turn itself and writes it out — that number beats anything we
    // could reconstruct, so it closes the open turn.
    if (e.type === 'system' && e.subtype === 'turn_duration' && typeof e.durationMs === 'number') {
      if (turnEvent) turnEvent.measuredMs = e.durationMs
      continue
    }

    // Claude writes the auto-generated session title as an `ai-title` line (current format)
    // or a `summary` line (legacy). ai-title can be regenerated as the chat grows, so the last
    // one wins; summary only fills the gap when no ai-title is present.
    if (e.type === 'ai-title' && typeof e.aiTitle === 'string' && e.aiTitle.trim()) {
      state.sessionTitle = e.aiTitle.trim()
      continue
    }
    if (e.type === 'summary' && typeof e.summary === 'string' && e.summary.trim()) {
      if (!state.sessionTitle) state.sessionTitle = e.summary.trim()
      continue
    }

    if (e.type === 'user') {
      // Counted for BOTH roles, matching `dailyActivity.messageCount`.
      { const d = dayOf(state.daily, ts); if (d) d.messages++ }
      const result = e.toolUseResult as Record<string, unknown> | undefined
      if (result && typeof result === 'object' && typeof result.agentId === 'string' && result.agentId) {
        state.sawAgentLaunch = true
      }
      const msgContent = (e.message as Record<string, unknown> | undefined)?.content
      const contentArr = Array.isArray(msgContent) ? msgContent as Record<string, unknown>[] : null

      // NOT a person's turn: a tool result being fed back, or an entry the harness injected under
      // the user's role (`isMeta`). The two are different things and only the first carries a
      // content ARRAY — `contentArr!` used to rest on "not human implies tool result", which stopped
      // being true the moment `isMeta` was excluded, and threw on the first local command.
      const notHuman = !isHumanUserEntry(e)

      if (notHuman) {
        // Count tool errors and attribute them to the originating tool
        for (const p of contentArr ?? []) {
          if (p.is_error === true) {
            state.toolErrors++
            const toolName = state.toolUseIdToName.get(p.tool_use_id as string) ?? 'unknown'
            state.toolErrorCategories[toolName] = (state.toolErrorCategories[toolName] ?? 0) + 1
          }
        }
      } else {
        // Real human message (initial prompt or interruption) — this is what opens a turn.
        state.userMsgs++
        { const n = textChars(msgContent); if (n > 0) { state.userChars += n; state.userCharMsgs++ } }
        if (turnEvent) turnEvent.userPrompt = true
        if (ts) {
          state.userMessageTimestamps.push(ts)
          // Response time: how long since the last assistant message
          if (state.lastAssistantTs) {
            const delta = (new Date(ts).getTime() - new Date(state.lastAssistantTs).getTime()) / 1000
            if (delta >= 0 && delta < 3600) state.userResponseTimes.push(Math.round(delta))
          }
        }
        // All messages after the first count as interruptions
        if (state.userMsgs > 1) state.userInterruptions++

        if (!state.firstPrompt && contentArr) {
          for (const p of contentArr) {
            if (p.type === 'text' && typeof p.text === 'string') {
              state.firstPrompt = (p.text as string).slice(0, 200)
              break
            }
          }
        } else if (!state.firstPrompt && typeof msgContent === 'string') {
          state.firstPrompt = msgContent.slice(0, 200)
        }
      }
    } else if (e.type === 'assistant') {
      state.assistantMsgs++
      { const n = textChars((e.message as Record<string, unknown> | undefined)?.content)
        if (n > 0) { state.assistantChars += n; state.assistantCharMsgs++ } }
      if (ts) state.lastAssistantTs = ts
      const msg = e.message as Record<string, unknown> | undefined
      if (!state.modelId && typeof msg?.model === 'string' && msg.model.startsWith('claude-')) state.modelId = msg.model
      const msgOutputTokens = (msg?.usage as Record<string, number> | undefined)?.output_tokens ?? 0
      { const d = dayOf(state.daily, ts); if (d) d.messages++ }
      // ONE BILLED RESPONSE IS COUNTED ONCE. Claude Code writes an assistant turn as several lines
      // when its content has several blocks, and every one repeats the SAME `message.usage`. This
      // walk summed per LINE, so a real session's tokens — and the cost priced from them — read
      // 60-90 % high; see `usage-dedupe.ts` for the three sessions that proved it.
      if (msg?.usage && countUsage(msg.id, state.countedUsageIds)) {
        const u = msg.usage as Record<string, number> & { cache_creation?: Record<string, unknown> }
        state.inputTokens         += u.input_tokens ?? 0
        state.outputTokens        += u.output_tokens ?? 0
        state.cacheReadTokens     += u.cache_read_input_tokens ?? 0
        state.cacheCreationTokens += u.cache_creation_input_tokens ?? 0
        // The TTL split of THIS line's cache-write portion, when the record states it — see
        // `usage.cache_creation` on `message.usage`. Under the SAME dedupe gate as every other
        // counter here, so a repeated line cannot double either portion.
        const ttl = u.cache_creation
        if (ttl && typeof ttl === 'object') {
          state.sawCacheCreationBreakdown = true
          state.cacheCreation1hTokens += typeof ttl.ephemeral_1h_input_tokens === 'number' ? ttl.ephemeral_1h_input_tokens : 0
          state.cacheCreation5mTokens += typeof ttl.ephemeral_5m_input_tokens === 'number' ? ttl.ephemeral_5m_input_tokens : 0
        }
        // The SAME four counters, against the day this turn happened on. A turn with no readable
        // timestamp contributes to the lifetime totals and to no day — it cannot be placed, and
        // placing it on the session's start day would be inventing the one fact this exists to
        // stop inventing.
        const d = dayOf(state.daily, ts)
        if (d) {
          d.input_tokens              += u.input_tokens ?? 0
          d.output_tokens             += u.output_tokens ?? 0
          d.cache_read_input_tokens   += u.cache_read_input_tokens ?? 0
          d.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0
        }
        // LAST wins, and only when the record actually carries an input side. A synthetic record of
        // all zeros would otherwise reset a real reading to "context empty" on the final turn.
        const sent = contextOfUsage(u)
        if (sent > 0) state.contextTokens = sent
      }
      // Collect tool names in this message for token attribution
      const toolsInMessage: string[] = []
      if (Array.isArray(msg?.content)) {
        for (const p of msg!.content as Record<string, unknown>[]) {
          if (p.type === 'tool_use' && typeof p.name === 'string') {
            const toolName = p.name as string
            state.toolCounts[toolName] = (state.toolCounts[toolName] ?? 0) + 1
            toolsInMessage.push(toolName)

            // Track id→name for error attribution
            if (typeof p.id === 'string') state.toolUseIdToName.set(p.id, toolName)

            if (toolName.startsWith('mcp__')) state.hasMcp = true

            // Count git commits/pushes from Bash tool calls. The rule itself lives in
            // `harness-activity.ts` so every harness counts the same thing the same way — it used to
            // be inline here, which is why no adapter could reuse it and all of them reported 0.
            if (toolName === 'Bash') {
              const cmd = (p.input as Record<string, string> | undefined)?.command ?? ''
              const g = countGitCommands(cmd)
              state.gitCommits += g.commits
              state.gitPushes += g.pushes
            }

            // Detect language and agent files from file-based tool calls
            if (['Read', 'Edit', 'Write', 'MultiEdit'].includes(toolName)) {
              const inp = p.input as Record<string, string> | undefined
              const fp = inp?.file_path ?? inp?.path ?? ''
              if (fp) {
                const ext = fp.split('.').pop()?.toLowerCase() ?? ''
                const lang = EXT_TO_LANG[ext]
                if (lang) state.languageSet.add(lang)

                // Count files Claude directly wrote or edited (not git-based)
                if (['Edit', 'Write', 'MultiEdit'].includes(toolName)) {
                  state.claudeFilesModified.add(fp)
                  // …and the LINES, from the same call. See `edit-lines.ts`: the git-diff figure
                  // measures uncommitted work, so a session that commits as it goes reported
                  // `+0 / −0` beside a real file count.
                  state.editLines = addDelta(state.editLines, editDelta(toolName, p.input))
                }

                // Detect agent instruction file reads (Read tool only — Glob/Grep/Search
                // operate on patterns/queries rather than file paths, so they are excluded
                // to avoid false positives)
                if (toolName === 'Read') {
                  const agentCategory = classifyAgentFile(fp)
                  if (agentCategory) {
                    state.agentFileReads[agentCategory] = (state.agentFileReads[agentCategory] ?? 0) + 1
                  }
                }
              }
            }

          }
        }
      }
      // Attribute output tokens evenly among tools in this message
      if (toolsInMessage.length > 0 && msgOutputTokens > 0) {
        const share = Math.floor(msgOutputTokens / toolsInMessage.length)
        const remainder = msgOutputTokens % toolsInMessage.length
        for (let i = 0; i < toolsInMessage.length; i++) {
          const tn = toolsInMessage[i]
          if (tn === undefined) continue
          state.toolOutputTokens[tn] = (state.toolOutputTokens[tn] ?? 0) + share + (i < remainder ? 1 : 0)
        }
      }
    }
  }
  foldActiveTime(state.active, turnEvents)
}

/**
 * The compaction figures as of right now. See `compactsFromClaudeJsonl` for the rules.
 *
 * `dropped` is absent rather than `0` when no record reported one — a session that compacted five
 * times and never said how much it dropped has not dropped nothing.
 */
export function finishCompacts(state: ClaudeParseState['compact']): CompactStats {
  return state.dropped === undefined
    ? { count: state.count, ms: state.ms }
    : { count: state.count, ms: state.ms, droppedTokens: state.dropped }
}

/**
 * A snapshot of the day split — the values too, not only the map.
 *
 * `Object.fromEntries` copies the map and hands back the SAME `SessionDayUsage` objects, which a
 * resumed walk goes on incrementing. See the note on isolation in `finishClaudeSession`.
 */
function copyDaily(daily: Map<string, SessionDayUsage>): Record<string, SessionDayUsage> {
  const out: Record<string, SessionDayUsage> = {}
  for (const [k, d] of daily) out[k] = { ...d, ...(d.hours ? { hours: { ...d.hours } } : {}) }
  return out
}

/**
 * One transcript's `SessionMeta`, from a walk that has read all of it.
 *
 * This is `parseSessionJsonl`'s own tail, unchanged: the same fields, the same conditionals, the
 * same two async reads (the git stats, and each subagent's own transcript). It is separated from
 * the walk only so the walk can be resumed — a live session is finished once per poll over state
 * that was folded once per line.
 *
 * EVERY COLLECTION IS COPIED OUT, and that is the price of the walk being resumable. When the
 * parser held its accumulators as locals, each call built them fresh and the caller owned them
 * outright; now they belong to a walk that the NEXT poll will go on appending to. Handing out the
 * live array would give a caller a `message_hours` that grows under it and a `tool_counts` that
 * gains keys, and would let anything that edits what it was given corrupt the numbers this walk
 * reports from then on. The copies cost one pass over a few thousand entries per FINISH, against
 * the megabytes of re-parsing they replace. `languages` and `daily` were already rebuilt here and
 * stay that way; `agentMetrics` comes out of `finishAgentMetrics`, which builds its own rows.
 */
export async function finishClaudeSession(
  state: ClaudeParseState,
  filePath: string,
  sessionId: string,
  fallbackPath: string,
  source: 'jsonl' | 'subdir',
): Promise<SessionMeta> {
  const durationMinutes = (state.startTime && state.lastTime)
    ? Math.max(0, Math.round((new Date(state.lastTime).getTime() - new Date(state.startTime).getTime()) / 60000))
    : 0

  const projectPath = state.cwd || fallbackPath
  /**
   * Asked where the session was WORKING, not where it was filed — see `sessionGitPaths`.
   *
   * `projectPath` is the transcript's FIRST state.cwd; `state.lastCwd` is where it ended up, and the two
   * differ exactly when the session moved into a git worktree, which is how this repository
   * mandates concurrent work is done. The worktree's branch is one the main checkout's HEAD has
   * never seen, so asking the project answered with nothing and the card read `Commits 2 · Lines
   * +0 / −0 · Files 0`.
   */
  const gitFileStats = state.gitCommits > 0
    ? await getSessionFileStats(projectPath, state.lastCwd, state.startTime, state.lastTime)
    : { linesAdded: 0, linesRemoved: 0, filesModified: 0 }
  // Use whichever count is higher: git-tracked files changed or files Claude directly edited
  const filesModifiedCount = Math.max(gitFileStats.filesModified, state.claudeFilesModified.size)

  // Extract agent metrics if this session used the Agent tool.
  //
  // The parse alone can no longer produce the NUMBERS: since Claude Code made the Agent tool
  // asynchronous the parent transcript names the subagent and nothing else, so the invocations come
  // back marked `unmeasured` and are filled in from each subagent's own transcript, which sits
  // beside this file. See `subagent-metrics.ts`.
  const agentMetrics = (state.toolCounts['Agent'] || state.sawAgentLaunch)
    ? await enrichFromSubagentTranscripts(finishAgentMetrics(state.agents, state.modelId), filePath, sessionId)
    : undefined

  const compaction = finishCompacts(state.compact)
  const skillUses = state.skillUses

  return {
    session_id: sessionId,
    project_path: projectPath,
    ...(state.lastCwd && state.lastCwd !== projectPath ? { current_cwd: state.lastCwd } : {}),
    start_time: state.startTime,
    end_time: state.lastTime || undefined,
    duration_minutes: durationMinutes,
    active_minutes: finishActiveTime(state.active).activeMinutes,
    user_message_count: state.userMsgs,
    user_chars: state.userChars,
    user_char_messages: state.userCharMsgs,
    assistant_message_count: state.assistantMsgs,
    assistant_chars: state.assistantChars,
    assistant_char_messages: state.assistantCharMsgs,
    tool_counts: { ...state.toolCounts },
    // `0` and `{}` ARE REAL ANSWERS HERE, and are written as such. This parser has just walked the
    // whole transcript, so "it compacted zero times" / "it invoked no skill" is a measurement, and
    // an ABSENT field means only that no transcript was read for this session. Writing them only
    // above zero made `session-profile.ts`'s `n` identical to its `nonZero` for both metrics: the
    // panel printed `compacts: 2 (n=23)` beside `messages: 2 (n=479)`, reading as "your typical
    // session compacts twice" when 23 of 479 sessions ever compacted at all and the typical one
    // compacts none. `compact_dropped_tokens` stays conditional — no record carrying one is a
    // different fact from a record carrying zero.
    //
    // `source === 'subdir'` is the exception, and it is the one `backfill-compaction.ts` records:
    // there the file just read is a SUBAGENT's stand-in for a session whose own transcript is gone,
    // and a subagent runs its own context and compacts on its own (5 of this machine's 255 subagent
    // transcripts carry a `compact_boundary`). Stamping its count on the session would be a
    // confident wrong number where the honest answer is that the evidence is gone.
    ...(source === 'jsonl'
      ? {
          compact_count: compaction.count,
          compact_ms: compaction.ms,
          ...(compaction.droppedTokens !== undefined
            ? { compact_dropped_tokens: compaction.droppedTokens }
            : {}),
          skill_uses: { ...skillUses },
        }
      : {}),
    tool_output_tokens: { ...state.toolOutputTokens },
    agent_file_reads: { ...state.agentFileReads },
    languages: Array.from(state.languageSet),
    git_commits: state.gitCommits,
    git_pushes: state.gitPushes,
    input_tokens: state.inputTokens,
    output_tokens: state.outputTokens,
    cache_read_input_tokens: state.cacheReadTokens,
    cache_creation_input_tokens: state.cacheCreationTokens,
    // BOTH-OR-NEITHER, and only when the running split RECONCILES exactly against the total this
    // session already reports — see `SessionMeta.cache_creation_1h_input_tokens`. A transcript
    // that mixed pre- and post-breakdown usage lines (or any line whose ephemeral fields did not
    // parse as numbers) would sum to less than `cacheCreationTokens`, and writing a partial split
    // as if it were the whole session's would price the unaccounted remainder at $0 instead of the
    // conservative 5-minute rate a MISSING split already falls back to.
    ...(state.sawCacheCreationBreakdown && state.cacheCreation1hTokens + state.cacheCreation5mTokens === state.cacheCreationTokens
      ? {
          cache_creation_1h_input_tokens: state.cacheCreation1hTokens,
          cache_creation_5m_input_tokens: state.cacheCreation5mTokens,
        }
      : {}),
    // Absent rather than zero when nothing was measured — a confident "0% of the window" on a
    // session that simply recorded no usage is the same lie `HARNESS_CAPABILITIES` prevents.
    ...(state.contextTokens > 0 ? { context_tokens: state.contextTokens } : {}),
    // Only when there is something to say. An empty map on every session would be a field that
    // means "no days" on a record that simply has no timestamps — see `SessionMeta.daily`.
    ...(state.daily.size > 0 ? { daily: copyDaily(state.daily) } : {}),
    first_prompt: state.firstPrompt,
    title: state.sessionTitle || undefined,
    user_interruptions: state.userInterruptions,
    user_response_times: [...state.userResponseTimes],
    tool_errors: state.toolErrors,
    tool_error_categories: { ...state.toolErrorCategories },
    uses_task_agent: 'Task' in state.toolCounts || 'Agent' in state.toolCounts || state.sawAgentLaunch,
    uses_mcp: state.hasMcp,
    uses_web_search: 'WebSearch' in state.toolCounts,
    uses_web_fetch: 'WebFetch' in state.toolCounts,
    // The session's OWN edits win over the working-tree diff, and fall back to it: the diff is 0
    // for a session that committed its work, while the edits are what it actually changed. Taking
    // the larger keeps a session that edited outside git (or through the shell) from reporting less
    // than git can see — the same `Math.max` shape `filesModifiedCount` already uses, and for the
    // same reason.
    lines_added: Math.max(gitFileStats.linesAdded, state.editLines.added),
    lines_removed: Math.max(gitFileStats.linesRemoved, state.editLines.removed),
    files_modified: filesModifiedCount,
    message_hours: [...state.messageHours],
    user_message_timestamps: [...state.userMessageTimestamps],
    model: state.modelId || undefined,
    harness: 'claude',
    _source: source,
    agentMetrics,
  }
}

/**
 * Parse an entire JSONL session file and extract full metrics.
 *
 * The one-shot reader: it holds the whole file, so it is the right shape for a transcript that is
 * read once — a finished session, a backfill script, a test. A LIVE transcript goes through
 * `transcript-state.ts` instead, which folds only the bytes that are new.
 */
export async function parseSessionJsonl(
  filePath: string,
  sessionId: string,
  fallbackPath: string,
  source: 'jsonl' | 'subdir'
): Promise<SessionMeta> {
  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch {
    return makeEmptySession(sessionId, fallbackPath, '', '', source)
  }
  const state = emptyClaudeParse()
  foldClaudeParse(state, iterLines(content))
  return finishClaudeSession(state, filePath, sessionId, fallbackPath, source)
}
