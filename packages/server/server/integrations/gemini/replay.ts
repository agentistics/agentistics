/**
 * integrations/gemini/replay.ts — PURE. A Gemini CLI chat file, read as canonical events.
 *
 * ## TWO FILE SHAPES, and only one of them can state tokens or tool calls today
 *
 * `adapters/gemini-parse.ts`'s own header names them (CLAUDE.md's "Gemini caveat" section is the
 * fuller write-up):
 *
 * - **rich-json** — one JSON object per file: `{sessionId, projectHash, startTime, lastUpdated,
 *   messages: [...]}`. A `'gemini'` message carries `tokens{input,output,cached,thoughts,tool,
 *   total}`, `model` and `toolCalls[{id,name,args,status,timestamp,result}]` — verified against
 *   real files on this machine (`~/.gemini/tmp/<project>/chats/<file>.json`): `status` is one of
 *   `success`, `error` or `cancelled`, and a shell call's argument is `args.command`.
 * - **jsonl (the append-journal)** — a HEADER line, a `{"$set":{"messages":[...]}}` SEED (often
 *   empty for a fresh session), then each turn appended as its OWN top-level record
 *   `{id, timestamp, type, content}`, with `{"$set":{"lastUpdated":...}}` patches after every one.
 *   Measured on this machine (`~/.gemini/tmp/agentistics/chats/*.jsonl`): the appended `'gemini'`
 *   records DO carry a top-level `tokens{...}` object — CLAUDE.md's "Tokens are NOT yet read for
 *   gemini, and that is now a decision rather than an absence" is exactly this shape, and
 *   `buildJsonlSessionMeta` never reads it. **This replay does not read it either.** Flipping that
 *   is D8's decision (`docs/superpowers/specs/2026-09-25-owner-decisions.md`): it changes money on
 *   every cost surface and needs its own reconciliation against a bill, exactly like
 *   `antigravity-protobuf.ts`'s header requires — not a side effect of building the replay. So a
 *   jsonl-shape session emits its lifecycle (session/run/agent open+close) and NOTHING else:
 *   `model.completed`/`model.invoked`/`tool.*` are simply never emitted for it, mirroring legacy's
 *   own blindness exactly rather than quietly improving on it (P2 §2's own wording: "tokens are
 *   `partial` and the shape is recorded per run, or a session silently reports zero").
 *
 * The shape is detected the same way `parseGeminiChat` detects it (mirrored here, not imported: the
 * detection is inline branching inside that function, and the brief's only permitted edit to
 * `gemini-parse.ts` is adding `export` to an existing declaration — there is no standalone function
 * to export). `replay.test.ts` cross-checks this module's classification against fixtures the
 * legacy parser also accepts, so the two cannot silently disagree about which branch a file takes.
 *
 * ## No incremental replay (v1)
 *
 * Gemini's rich-json file is REWRITTEN WHOLE on every save (one `JSON.stringify` of the entire
 * `messages` array), not appended to — so there is no byte-offset cursor to resume from the way
 * Claude's transcript-cursor.ts resumes an append-only file. The jsonl shape genuinely is
 * append-only, but adding a second resumability code path for one of two shapes, when gemini chat
 * files are KB not MB, was judged not worth the risk in this pass. So `foldGeminiChat` is a
 * ONE-SHOT pure function: every call re-reads and re-folds the WHOLE file and re-emits EVERY event.
 * Correctness survives this because `deriveEventId` is derived from the record, never minted — the
 * journal's `UNIQUE(event_id)` dedupes a re-emitted event to a no-op, exactly the property
 * `integrations/claude/replay-core.ts`'s header calls "the SAME answer paid for again". Declared as
 * a limitation, not silently: see this module's own test for the "replay twice -> identical events"
 * property in place of a chunk-independence one (there is no chunking API to test).
 *
 * ## No conversation text (D5)
 *
 * See `replay-core.ts`'s header. `redactSecrets(commandSummary(...))` is the only route a shell
 * argument takes into an event.
 */
import { canonicalTool } from '../../harness-activity'
import { commandSummary } from '../../sessions/shell-writes'
import {
  redactSecrets,
  type AgentStartedData,
  type ModelCompletedData,
  type ModelInvokedData,
  type RunStartedData,
  type SessionStartedData,
  type ToolCompletedData,
  type ToolFailedData,
  type ToolKind,
  type ToolRequestedData,
} from '@agentistics/core'
import { extractMessageText, isGenuineUserMessage } from '../../adapters/gemini-parse'
import { counter, makeEvent, str, toolExecutionIdOf, type EmitEvent, type GeminiReplayContext } from './replay-core'

export type GeminiShape = 'rich-json' | 'jsonl' | 'empty' | 'unknown'

/**
 * Mirrors `parseGeminiChat`'s own dispatch, in the same order: empty content -> `'empty'`; content
 * not starting with `{` -> `'unknown'` (legacy returns `null` there too); a SINGLE-LINE object (the
 * ordinary case — `JSON.stringify` with no indentation never emits a raw newline) is `'rich-json'`
 * directly; a MULTI-line file is parsed WHOLE and classified `'rich-json'` only if that succeeds
 * AND the result carries a `messages` array (a pretty-printed rich-json file, which legacy also
 * accepts this way) — otherwise `'jsonl'`.
 */
export function detectGeminiShape(content: string): GeminiShape {
  const trimmed = content.trim()
  if (!trimmed) return 'empty'
  if (trimmed[0] !== '{') return 'unknown'
  const firstNewline = trimmed.indexOf('\n')
  if (firstNewline === -1) return 'rich-json'
  let parsed: unknown
  try { parsed = JSON.parse(trimmed) } catch { parsed = null }
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).messages)) {
    return 'rich-json'
  }
  return 'jsonl'
}

// ── Tool classification (new for the canonical model — legacy never computed a ToolKind) ─────────

const SHELL_NAMES = new Set(['Bash', 'BashOutput', 'KillShell'])
const FILE_NAMES = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const SEARCH_NAMES = new Set(['Grep', 'Glob'])

/** Classifies by the CANONICAL name — `canonicalTool('gemini', …)` already maps
 *  `run_shell_command` -> `Bash`, `read_file` -> `Read`, `replace` -> `Edit`, etc., into the same
 *  buckets Claude's own tool names already sit in, so one classification table serves both. */
function classifyTool(canonicalName: string): ToolKind {
  if (SHELL_NAMES.has(canonicalName)) return 'shell'
  if (FILE_NAMES.has(canonicalName)) return 'file'
  if (SEARCH_NAMES.has(canonicalName)) return 'search'
  return 'other'
}

// ── rich-json ───────────────────────────────────────────────────────────────────────────────────

interface RichMessage {
  id?: unknown
  timestamp?: unknown
  type?: unknown
  content?: unknown
  model?: unknown
  tokens?: { input?: unknown; output?: unknown; cached?: unknown }
  toolCalls?: Array<{ id?: unknown; name?: unknown; args?: unknown; status?: unknown; timestamp?: unknown }>
}

interface RichRoot {
  startTime?: unknown
  lastUpdated?: unknown
  messages?: unknown
}

function hasGenuineContentRich(messages: RichMessage[]): boolean {
  for (const msg of messages) {
    if (msg?.type === 'gemini') return true
    if (msg?.type === 'user' && isGenuineUserMessage(extractMessageText(msg))) return true
  }
  return false
}

function foldRichJson(ctx: GeminiReplayContext, root: RichRoot, emit: EmitEvent): void {
  const messages = Array.isArray(root.messages) ? (root.messages as RichMessage[]) : []
  if (!hasGenuineContentRich(messages)) return // mirrors legacy's `null` — a bootstrap-only file

  const startTime = str(root.startTime)
  const lastUpdated = str(root.lastUpdated)
  const firstMsgTs = messages.find(m => str(m?.timestamp))?.timestamp
  const lastMsgTs = [...messages].reverse().find(m => str(m?.timestamp))?.timestamp

  const openAt = startTime ?? str(firstMsgTs) ?? lastUpdated ?? str(lastMsgTs)
  if (!openAt) return // no timestamp anywhere to anchor the session on — nothing to say

  const openRef = `${ctx.sourceRefBase}:open`
  const closeAt = lastUpdated ?? str(lastMsgTs) ?? openAt

  emit(makeEvent(ctx, 'session.started', {
    origin: 'adapter',
    // ALWAYS included, never omitted for an empty string: legacy's `project_path` is always a
    // defined string (possibly `''` when `adapters/gemini.ts`'s projects.json lookup misses), and
    // an omitted-when-falsy field here would read as `undefined` in the projection — a real
    // divergence from legacy's `''`, not a match.
    projectPath: ctx.projectPath ?? '',
  } satisfies SessionStartedData, { sourceRef: openRef, occurredAt: openAt, confidence: 'exact', agentId: null }))

  emit(makeEvent(ctx, 'run.started', {
    harness: 'gemini',
    conversationId: ctx.conversationId,
    conversationLink: 'observed',
    cwd: ctx.projectPath ?? '',
  } satisfies RunStartedData, { sourceRef: openRef, occurredAt: openAt, confidence: 'exact', agentId: null }))

  emit(makeEvent(ctx, 'agent.started', { kind: 'main' } satisfies AgentStartedData,
    { sourceRef: openRef, occurredAt: openAt, confidence: 'exact' }))

  let msgIndex = 0
  for (const msg of messages) {
    const thisIndex = msgIndex++
    if (msg?.type !== 'gemini') continue
    const ts = str(msg.timestamp) ?? openAt
    // Ends in the message's numeric ARRAY POSITION, not its own `id` string — the same convention
    // Claude's `lineRef` uses (a line number), and it is what lets `session-meta.ts`'s `keyOf`
    // (`/:(\d+)$/` on `sourceRef`) recover an order key for "last response wins" comparisons; an
    // id like `msg-g1` would not match that pattern and silently fall back to timestamp-only
    // ordering. Positional identity is stable here because a Gemini rich-json file only ever
    // APPENDS to `messages` between saves (never reorders or removes an earlier entry).
    const msgRef = `${ctx.sourceRefBase}:msg:${thisIndex}`

    // model.invoked/model.completed — only when the response NAMES a model (D21: a response we
    // cannot even attribute to a model is not one this replay can state as a `model.completed`,
    // whose `model` field is required, not optional).
    const model = str(msg.model)
    const tokens = msg.tokens
    if (model && tokens && typeof tokens === 'object') {
      const usage: ModelCompletedData['usage'] = {}
      const input = counter(tokens.input); if (input !== undefined) usage.input = input
      const output = counter(tokens.output); if (output !== undefined) usage.output = output
      const cacheRead = counter(tokens.cached); if (cacheRead !== undefined) usage.cacheRead = cacheRead
      // `tokens.thoughts`/`tokens.tool`/`tokens.total` are deliberately NOT mapped — legacy never
      // reads them either, and Google's thinking tokens are separately billed (master §14.2's
      // correction); adding them here would be a quiet improvement over legacy, not a move.
      const opts = { sourceRef: msgRef, occurredAt: ts, confidence: 'exact' as const }
      emit(makeEvent(ctx, 'model.invoked', { provider: 'google', model } satisfies ModelInvokedData, opts))
      emit(makeEvent(ctx, 'model.completed', {
        provider: 'google', model, usage, status: 'completed',
      } satisfies ModelCompletedData, opts))
    }

    if (!Array.isArray(msg.toolCalls)) continue
    let toolOrdinal = 0
    for (const tc of msg.toolCalls) {
      const toolCallId = str(tc?.id)
      const name = str(tc?.name)
      if (!toolCallId || !name) continue // nothing to key or name this call by
      const thisOrdinal = toolOrdinal++
      const canonicalName = canonicalTool('gemini', name)
      const kind = classifyTool(canonicalName)
      const toolExecutionId = toolExecutionIdOf(ctx.conversationId, toolCallId)
      const tcTs = str(tc?.timestamp) ?? ts
      const tcRef = `${msgRef}:tool:${thisOrdinal}`
      const tcOpts = { sourceRef: tcRef, occurredAt: tcTs, confidence: 'exact' as const, ordinal: thisOrdinal }

      const reqData: ToolRequestedData = { toolExecutionId, name, canonicalName, kind }
      if (kind === 'shell') {
        const args = tc?.args as Record<string, unknown> | undefined
        const cmd = str(args?.command)
        if (cmd) reqData.summary = redactSecrets(commandSummary(cmd))
      }
      emit(makeEvent(ctx, 'tool.requested', reqData, tcOpts))

      const status = str(tc?.status)
      if (status === 'error') {
        emit(makeEvent(ctx, 'tool.failed', { toolExecutionId, status: 'failed' } satisfies ToolFailedData, tcOpts))
      } else if (status === 'cancelled') {
        emit(makeEvent(ctx, 'tool.failed', { toolExecutionId, status: 'cancelled' } satisfies ToolFailedData, tcOpts))
      } else {
        // `success`, or a status this replay does not recognise — a tool call the harness itself
        // did not mark as an error is read as completed, never withheld for want of a known label.
        emit(makeEvent(ctx, 'tool.completed', { toolExecutionId } satisfies ToolCompletedData, tcOpts))
      }
    }
  }

  const closeRef = `${ctx.sourceRefBase}:close`
  const closeOpts = { sourceRef: closeRef, occurredAt: closeAt, confidence: 'exact' as const }
  emit(makeEvent(ctx, 'agent.ended', { status: 'completed' }, closeOpts))
  emit(makeEvent(ctx, 'run.ended', { status: 'completed' }, { ...closeOpts, agentId: null }))
  emit(makeEvent(ctx, 'session.ended', {}, { ...closeOpts, agentId: null }))
}

// ── jsonl (append-journal) — lifecycle ONLY, see this module's header ─────────────────────────────

interface JsonlMessage { id?: unknown; timestamp?: unknown; type?: unknown; content?: unknown }

/** Mirrors `parseJsonl`'s own walk: a header line updates `startTime`/`lastUpdated` (MIN/MAX
 *  across every header seen — a resumed session can write several), a `$set.messages` snapshot or
 *  a top-level typed record is a candidate message, and `seenIds` dedupes a resumed session's seed
 *  repeating turns that then arrive again as their own lines (CLAUDE.md's "A TURN IS APPENDED AS
 *  ITS OWN LINE" section — the exact trap this module exists to not re-fall into). */
function foldJsonl(ctx: GeminiReplayContext, lines: readonly string[], emit: EmitEvent): void {
  let startTime = ''
  let lastUpdated = ''
  const seenIds = new Set<unknown>()
  let hasGenuineContent = false
  let firstTs: string | undefined
  let lastTs: string | undefined

  const noteTs = (ts: string | undefined): void => {
    if (!ts) return
    if (!firstTs || ts < firstTs) firstTs = ts
    if (!lastTs || ts > lastTs) lastTs = ts
  }

  const consider = (msg: JsonlMessage): void => {
    const id = msg?.id
    if (id !== undefined) {
      if (seenIds.has(id)) return
      seenIds.add(id)
    }
    const ts = str(msg?.timestamp)
    noteTs(ts)
    const isAssistant = msg?.type === 'model' || msg?.type === 'gemini'
    const isUser = msg?.type === 'user'
    if (isAssistant) hasGenuineContent = true
    else if (isUser && isGenuineUserMessage(extractMessageText(msg))) hasGenuineContent = true
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    let parsed: Record<string, unknown> | null
    try { parsed = JSON.parse(line) } catch { continue }
    if (!parsed || typeof parsed !== 'object') continue

    if (parsed.sessionId !== undefined || parsed.startTime !== undefined) {
      const st = str(parsed.startTime)
      if (st && (!startTime || st < startTime)) startTime = st
      const lu = str(parsed.lastUpdated)
      if (lu && (!lastUpdated || lu > lastUpdated)) lastUpdated = lu
      continue
    }

    const set = parsed['$set'] as Record<string, unknown> | undefined
    if (set !== undefined) {
      const messages = set.messages
      if (Array.isArray(messages)) for (const msg of messages) consider(msg as JsonlMessage)
      continue
    }

    if (typeof parsed.type === 'string') consider(parsed as JsonlMessage)
  }

  if (!hasGenuineContent) return

  const openAt = str(startTime) ?? firstTs ?? str(lastUpdated) ?? lastTs
  if (!openAt) return
  const closeAt = str(lastUpdated) ?? lastTs ?? openAt

  const openRef = `${ctx.sourceRefBase}:open`
  emit(makeEvent(ctx, 'session.started', {
    origin: 'adapter',
    // See the rich-json fold's identical comment: never omitted for an empty string.
    projectPath: ctx.projectPath ?? '',
  } satisfies SessionStartedData, { sourceRef: openRef, occurredAt: openAt, confidence: 'exact', agentId: null }))
  emit(makeEvent(ctx, 'run.started', {
    harness: 'gemini',
    conversationId: ctx.conversationId,
    conversationLink: 'observed',
    cwd: ctx.projectPath ?? '',
  } satisfies RunStartedData, { sourceRef: openRef, occurredAt: openAt, confidence: 'exact', agentId: null }))
  emit(makeEvent(ctx, 'agent.started', { kind: 'main' } satisfies AgentStartedData,
    { sourceRef: openRef, occurredAt: openAt, confidence: 'exact' }))

  const closeRef = `${ctx.sourceRefBase}:close`
  const closeOpts = { sourceRef: closeRef, occurredAt: closeAt, confidence: 'exact' as const }
  emit(makeEvent(ctx, 'agent.ended', { status: 'completed' }, closeOpts))
  emit(makeEvent(ctx, 'run.ended', { status: 'completed' }, { ...closeOpts, agentId: null }))
  emit(makeEvent(ctx, 'session.ended', {}, { ...closeOpts, agentId: null }))
}

/**
 * The one entry point: detect the shape, fold it, and say which shape it was (the caller — the
 * differential and the IO half — records this per run, per P2 §2's own wording: "the shape is
 * recorded per run"). An `'empty'` or `'unknown'` file, and a `'genuine content'`-less one of
 * either recognised shape, emits nothing — mirroring legacy's `null` exactly.
 */
export function foldGeminiChat(ctx: GeminiReplayContext, content: string, emit: EmitEvent): GeminiShape {
  const shape = detectGeminiShape(content)
  if (shape === 'rich-json') {
    let parsed: unknown
    try { parsed = JSON.parse(content.trim()) } catch { return 'unknown' }
    if (!parsed || typeof parsed !== 'object') return 'unknown'
    foldRichJson(ctx, parsed as RichRoot, emit)
  } else if (shape === 'jsonl') {
    foldJsonl(ctx, content.split('\n'), emit)
  }
  return shape
}
