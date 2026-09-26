/**
 * integrations/claude/index.ts — the IO half of the Claude replay: which files exist, and reading
 * a LIVE one by what it has written SINCE LAST TIME (CLAUDE.md, "A LIVE transcript is read by what
 * it has WRITTEN SINCE LAST TIME"). `replay.ts` and its three sub-folds are the PURE half; nothing
 * here decides what an entry MEANS, only which bytes reach the fold and when the fold's `finish` is
 * told the transcript is settled.
 *
 * ## The cursor, and why a cold resume never needs the accumulator back
 *
 * `HarnessReplay.replay(source, cursor)` gets an opaque `ReplayCursor = string | null` and must
 * decide whether it may be RESUMED. This module's cursor is a JSON envelope of the same shape
 * `transcript-cursor.ts` already validates a resume against: `{ v: 1, offset, anchor, size,
 * mtimeMs, lineNo }` — the byte offset consumed, the file's size and mtime at that moment, the
 * anchor bytes immediately before it, and the raw LINE count `foldClaudeReplay` had reached (an
 * extra, redundant check beyond the byte-level ones, cheap and in the spirit of never trusting a
 * resume further than it has been verified).
 *
 * A resume additionally requires this PROCESS to still hold the in-memory fold state the cursor
 * describes — an offset without the accumulator behind it (the model fold's held-open response, the
 * lifecycle fold's `launchSites`, …) cannot be appended into safely. So a cursor is trusted only
 * when it matches this process's own retained walk EXACTLY; anything else — a fresh process, an
 * evicted walk (`STATE_TTL_MS` / `MAX_STATES`, reused from `transcript-state.ts` so both transcript
 * walks in this codebase are bounded by the same policy), a cursor from a different run — falls
 * through to `planTranscriptRead(null, stat)`, which is `{mode: 'full', reason: 'no-cursor'}`: the
 * file is read from byte 0 and EVERY event in it is re-emitted. That is safe, not merely tolerated:
 * every id in `replay-core.ts` is DERIVED from the source record, so re-emitting an event already
 * seen re-derives the identical `eventId` — the journal downstream dedupes by that id, which is the
 * whole reason `deriveEventId` exists (see its own header). A resume is an optimisation; a cold
 * re-read is never a correctness fallback, it is the SAME answer paid for again.
 *
 * ## The subagent pass — run on every `final` poll, not only the first
 *
 * `settledMs` (default 60s, matching `CLAUDE.md`'s "Claude Code writes a whole response in one
 * burst") decides `final`: the main transcript is quiet, so the *.ended events close it and the
 * `subagents/` directory is read. This runs on EVERY call where `final` holds, not merely the first
 * time it becomes true — a background agent can still be writing after the main conversation has
 * gone quiet, and the only bound on noticing it is however often the caller polls. The cost of
 * repeating the pass is bounded twice: `subagentLaunchEvents` is given only the launches this
 * conversation's own walk has not already reported (`ConversationWalk.launchesEmitted`), and each
 * subagent transcript is itself read through the SAME resumable byte-cursor as the main one, so an
 * unchanged subagent file costs one `stat` and nothing else.
 *
 * ## Nested agents, without folding a subagent's transcript twice to find them
 *
 * `subagent-join.ts`'s `planAgentJoin` deliberately EXCLUDES a nested transcript (one whose own
 * `agent-<id>.meta.json` names a `parentAgentId`) from every plan's candidates — it must never be
 * claimed as a TOP-LEVEL invocation's transcript, or its tokens would be counted twice (once under
 * the invocation that spawned its parent, once again as if the main conversation had launched it
 * directly). That exclusion means nested agents never appear in `AgentJoinPlan.reads` no matter
 * whose `launchedInvocations` is joined against the directory — so this module finds them by the
 * OTHER route the directory already offers: any entry whose own meta states a `parentAgentId` is a
 * nested launch by definition (`isNestedAgent`), and its meta already NAMES the spawning agent, so
 * no join, and no folding of the parent subagent's transcript, is needed to attribute it.
 */

import { readdir, readFile, stat as fsStat, open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AgentisticsEvent } from '@agentistics/core'
import { PROJECTS_DIR } from '../../config'
import { createTranscriptPathMemo, resolveMemoizedPath } from '../../sessions/transcript-path-memo'
import {
  anchorHex, consumedEnd, cursorFrom, evictTranscriptStates, planTranscriptRead,
  type TranscriptCursor, type TranscriptStat,
} from '../../transcript-cursor'
import { MAX_STATES, STATE_TTL_MS } from '../../transcript-state'
import { describedFrom, isNestedAgent, parseAgentMeta, planAgentJoin, type AgentEntry } from '../../subagent-join'
import type { HarnessReplay, ReplayBatch, ReplayCursor, ReplaySource } from '../types'
import { mainAgentIdOf, mainContext, subagentContext, subagentIdOf, type ClaudeReplayContext } from './replay-core'
import {
  emptyClaudeReplay, finishClaudeReplay, foldClaudeReplay,
  type ClaudeReplayState, type ClaudeTranscriptRole,
} from './replay'
import { cloneLifecycleFold, launchedInvocations, subagentLaunchEvents, type SubagentLaunch } from './replay-agents'
import { cloneModelFold } from './replay-model'
import { cloneToolFold } from './replay-tools'
import { cloneContextFold } from './replay-context'
import { iterLines } from '../../jsonl'

/** Claude Code writes a whole response in one burst — a transcript quiet this long is settled. */
const DEFAULT_SETTLED_MS = 60_000

export interface ClaudeReplayOptions {
  /** Default: `PROJECTS_DIR` (`~/.claude/projects`, or `CLAUDE_DIR`'s override — see `config.ts`). */
  projectsDir?: string
  /** Default: `Date.now`. Overridable so a test can drive `final` deterministically. */
  now?: () => number
  /** Default: `DEFAULT_SETTLED_MS`. */
  settledMs?: number
}

// ── The cursor envelope ─────────────────────────────────────────────────────────────────────────

interface EncodedCursor {
  v: 1
  offset: number
  anchor: string
  size: number
  mtimeMs: number
  lineNo: number
}

function encodeCursor(c: TranscriptCursor, lineNo: number): ReplayCursor {
  const enc: EncodedCursor = { v: 1, offset: c.offset, anchor: c.anchor, size: c.size, mtimeMs: c.mtimeMs, lineNo }
  return JSON.stringify(enc)
}

/** A cursor this process cannot make sense of is simply untrusted — never an error. */
function parseCursor(cursor: ReplayCursor): EncodedCursor | null {
  if (cursor === null) return null
  let raw: unknown
  try { raw = JSON.parse(cursor) } catch { return null }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.v !== 1) return null
  if (
    typeof o.offset !== 'number' || typeof o.anchor !== 'string' || typeof o.size !== 'number'
    || typeof o.mtimeMs !== 'number' || typeof o.lineNo !== 'number'
  ) return null
  return { v: 1, offset: o.offset, anchor: o.anchor, size: o.size, mtimeMs: o.mtimeMs, lineNo: o.lineNo }
}

/** Does the retained walk's own cursor agree with what the CALLER handed back? */
function cursorMatches(walkCursor: TranscriptCursor, lineNo: number, incoming: EncodedCursor | null): boolean {
  if (!incoming) return false
  return walkCursor.offset === incoming.offset && walkCursor.size === incoming.size
    && walkCursor.mtimeMs === incoming.mtimeMs && walkCursor.anchor === incoming.anchor
    && lineNo === incoming.lineNo
}

// ── Reading one transcript by what changed — the byte-cursor half, generalised from `ClaudeParseState` to `ClaudeReplayState` ──

function cloneClaudeReplayState(s: ClaudeReplayState): ClaudeReplayState {
  return {
    ctx: s.ctx,
    role: s.role,
    lineNo: s.lineNo,
    lifecycle: cloneLifecycleFold(s.lifecycle),
    model: cloneModelFold(s.model),
    tools: cloneToolFold(s.tools),
    context: cloneContextFold(s.context),
  }
}

/** Fill `buf` from `position`, looping until it is full or the file ends — mirrors `transcript-state.ts`. */
async function readFully(fh: FileHandle, buf: Buffer, position: number): Promise<number> {
  let got = 0
  while (got < buf.length) {
    const { bytesRead } = await fh.read(buf, got, buf.length - got, position + got)
    if (bytesRead <= 0) break
    got += bytesRead
  }
  return got
}

interface TranscriptFoldResult {
  state: ClaudeReplayState
  cursor: TranscriptCursor
  /** Whether this call actually folded new bytes — `false` on an `'unchanged'` read. */
  changed: boolean
}

/**
 * Read `path` by what has changed since `prev`, folding new bytes into a CLONE via the same rules
 * `transcript-state.ts` applies to `ClaudeParseState`: a partial trailing line is never consumed
 * (`consumedEnd`), a same-length rewrite is caught by mtime, a longer one by the anchor, and either
 * failure falls back to one whole re-read rather than a number assembled out of two reads.
 *
 * `ctx` is THIS call's context — freshly built with the current `recordedAt` — and is stamped onto
 * the returned state before any folding happens, so every event this call emits (new ones from an
 * append, or the whole transcript's worth from a fresh/full read) carries the CALLER's clock, never
 * a `recordedAt` frozen at whenever this walk happened to be created.
 *
 * `null` only when the file cannot be opened or stat-ed — "nothing to say", exactly as
 * `claudeTranscriptState` answers it, never an empty state read as an empty transcript.
 */
async function readAndFold(
  path: string,
  prev: { cursor: TranscriptCursor; state: ClaudeReplayState } | null,
  ctx: ClaudeReplayContext,
  role: ClaudeTranscriptRole,
  emit: (e: AgentisticsEvent) => void,
): Promise<TranscriptFoldResult | null> {
  let fh: FileHandle
  try { fh = await open(path, 'r') } catch { return null }
  try {
    const st = await fh.stat()
    if (!st.isFile()) return null
    const stat: TranscriptStat = { size: st.size, mtimeMs: st.mtimeMs }
    let plan = planTranscriptRead(prev?.cursor, stat)

    if (plan.mode === 'unchanged' && prev) {
      prev.state.ctx = ctx
      return { state: prev.state, cursor: prev.cursor, changed: false }
    }

    if (plan.mode === 'append' && prev) {
      const length = plan.to - plan.readFrom
      const buf = Buffer.allocUnsafe(length)
      const chunk = buf.subarray(0, await readFully(fh, buf, plan.readFrom))
      const anchorOk = plan.verifyBytes === 0
        || anchorHex(chunk.subarray(0, plan.verifyBytes)) === prev.cursor.anchor
      if (anchorOk) {
        const fresh = chunk.subarray(plan.verifyBytes)
        const consumed = consumedEnd(fresh)
        const state = consumed > 0 ? cloneClaudeReplayState(prev.state) : prev.state
        state.ctx = ctx
        if (consumed > 0) {
          foldClaudeReplay(state, iterLines(fresh.subarray(0, consumed).toString('utf-8')), emit)
        }
        const offset = plan.lineFrom + consumed
        const cursor = cursorFrom(chunk, plan.readFrom + chunk.length, offset, stat)
        return { state, cursor, changed: consumed > 0 }
      }
      plan = { mode: 'full', reason: 'anchor-mismatch' }
    }

    const buf = Buffer.allocUnsafe(stat.size)
    const chunk = buf.subarray(0, await readFully(fh, buf, 0))
    const consumed = consumedEnd(chunk)
    const state = emptyClaudeReplay(ctx, role)
    if (consumed > 0) foldClaudeReplay(state, iterLines(chunk.subarray(0, consumed).toString('utf-8')), emit)
    const cursor = cursorFrom(chunk, chunk.length, consumed, stat)
    return { state, cursor, changed: consumed > 0 }
  } catch {
    return null
  } finally {
    await fh.close().catch(() => {})
  }
}

// ── The subagents/ directory ────────────────────────────────────────────────────────────────────

async function entriesIn(dir: string): Promise<AgentEntry[]> {
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

// ── The per-conversation walk ───────────────────────────────────────────────────────────────────

interface ConversationWalk {
  mainState: ClaudeReplayState
  mainCursor: TranscriptCursor
  subagents: Map<string, { cursor: TranscriptCursor; state: ClaudeReplayState }>
  /** The join's own verdict on each CLAIMED top-level launch, remembered for `subagentFailed`. */
  subagentStatus: Map<string, 'completed' | 'failed'>
  /** Every launch already turned into `agent.started` — keyed by `agentId`, or `unmeasured:<toolUseId>`. */
  launchesEmitted: Set<string>
  usedMs: number
}

/**
 * Turn the join's plan plus the directory's own nested entries into the flat launches
 * `subagentLaunchEvents` wants — never including a fork (`plan.unclaimed`), and never repeating a
 * launch this walk has already reported.
 */
function planLaunches(
  walk: ConversationWalk,
  mainCtx: ClaudeReplayContext,
  conversationId: string,
  invocations: ReturnType<typeof launchedInvocations>,
  entries: AgentEntry[],
): SubagentLaunch[] {
  const plan = planAgentJoin(invocations, entries)
  const metaOf = new Map(entries.map(e => [e.agentId, e.meta]))
  const launches: SubagentLaunch[] = []

  for (const { invocation, agentId } of plan.reads) {
    const key = agentId ?? `unmeasured:${invocation.toolUseId}`
    if (agentId) walk.subagentStatus.set(agentId, invocation.status)
    if (walk.launchesEmitted.has(key)) continue
    walk.launchesEmitted.add(key)

    const meta = agentId ? metaOf.get(agentId) ?? null : null
    const described = describedFrom(invocation, meta)
    launches.push({
      agentId,
      parentAgentId: mainCtx.agentId,
      ...(described.agentType && described.agentType !== 'unknown' ? { agentType: described.agentType } : {}),
      ...(described.description ? { description: described.description } : {}),
      ...(meta?.model ? { model: meta.model } : {}),
      ...(walk.mainState.lifecycle.launchSites.get(invocation.toolUseId)
        ? { launchSite: walk.mainState.lifecycle.launchSites.get(invocation.toolUseId) }
        : {}),
      toolUseId: invocation.toolUseId,
    })
  }

  for (const e of entries) {
    if (!e.meta || !isNestedAgent(e.meta) || !e.meta.parentAgentId) continue
    if (walk.launchesEmitted.has(e.agentId)) continue
    walk.launchesEmitted.add(e.agentId)
    launches.push({
      agentId: e.agentId,
      parentAgentId: subagentIdOf(conversationId, e.meta.parentAgentId),
      ...(e.meta.agentType ? { agentType: e.meta.agentType } : {}),
      ...(e.meta.description ? { description: e.meta.description } : {}),
      ...(e.meta.model ? { model: e.meta.model } : {}),
      // A nested child was never launched by a `tool_use` this conversation's own transcript
      // carries, so it has no `toolUseId` of its own — the fallback id path is unreachable for it
      // (its `agentId` is always known, from the directory listing itself).
      toolUseId: '',
    })
  }

  return launches
}

/**
 * The main transcript has gone quiet: emit every launch not yet reported, and fold every claimed
 * transcript (new or still-known-from-a-previous-poll) by what it has newly written.
 */
async function runSubagentPass(
  walk: ConversationWalk,
  mainCtx: ClaudeReplayContext,
  mainPath: string,
  conversationId: string,
  recordedAt: string,
  emit: (e: AgentisticsEvent) => void,
): Promise<void> {
  // An UNMEASURED invocation must be reported even when `subagents/` holds nothing at all — an
  // empty (or missing) directory is not a reason to withhold "this was launched", only a reason
  // `planAgentJoin` will pair every launch with `agentId: null`. Only skip the pass entirely when
  // there is nothing launched to report in the first place.
  const invocations = launchedInvocations(walk.mainState.lifecycle)
  if (invocations.length === 0) return

  const dir = join(dirname(mainPath), conversationId, 'subagents')
  const entries = await entriesIn(dir)
  const launches = planLaunches(walk, mainCtx, conversationId, invocations, entries)
  if (launches.length > 0) subagentLaunchEvents(mainCtx, launches, emit)

  const claimed = new Set<string>()
  for (const l of launches) if (l.agentId) claimed.add(l.agentId)
  for (const id of walk.subagents.keys()) claimed.add(id)

  for (const agentId of claimed) {
    const filePath = join(dir, `agent-${agentId}.jsonl`)
    const subCtx = subagentContext(conversationId, agentId, recordedAt)
    const prevSub = walk.subagents.get(agentId) ?? null
    const result = await readAndFold(filePath, prevSub, subCtx, 'subagent', emit)
    if (!result) continue
    result.state.lifecycle.subagentFailed = walk.subagentStatus.get(agentId) === 'failed'
    walk.subagents.set(agentId, { cursor: result.cursor, state: result.state })
    finishClaudeReplay(result.state, { final: true }, emit)
  }
}

// ── The scan `discover()` performs, and the one `resolveMemoizedPath` falls back to ────────────

async function discoverSources(projectsDir: string): Promise<ReplaySource[]> {
  let projects: string[]
  try { projects = await readdir(projectsDir) } catch { return [] }
  const sources: ReplaySource[] = []
  for (const project of projects) {
    const dir = join(projectsDir, project)
    let files: string[]
    try { files = await readdir(dir) } catch { continue }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const conversationId = file.slice(0, -'.jsonl'.length)
      sources.push({ sessionId: conversationId, sourceRef: `claude:${conversationId}` })
    }
  }
  return sources
}

async function findTranscriptPath(projectsDir: string, conversationId: string): Promise<string | null> {
  let projects: string[]
  try { projects = await readdir(projectsDir) } catch { return null }
  for (const project of projects) {
    const candidate = join(projectsDir, project, `${conversationId}.jsonl`)
    try {
      const st = await fsStat(candidate)
      if (st.isFile()) return candidate
    } catch { continue }
  }
  return null
}

// ── The integration ─────────────────────────────────────────────────────────────────────────────

export function createClaudeReplay(opts: ClaudeReplayOptions = {}): HarnessReplay {
  const projectsDir = opts.projectsDir ?? PROJECTS_DIR
  const now = opts.now ?? Date.now
  const settledMs = opts.settledMs ?? DEFAULT_SETTLED_MS

  const walks = new Map<string, ConversationWalk>()
  const pathMemo = createTranscriptPathMemo()
  /** One read in flight per conversation — see this module's header on why a cursor is trusted
   *  only against THIS process's own retained walk; two concurrent reads of one file could each
   *  plan from the same stale cursor and fold the same new bytes twice. */
  const reading = new Map<string, Promise<ReplayBatch>>()

  function sweep(nowMs: number): void {
    if (walks.size === 0) return
    for (const path of evictTranscriptStates(walks, nowMs, { ttlMs: STATE_TTL_MS, max: MAX_STATES })) {
      walks.delete(path)
    }
  }

  async function discover(): Promise<ReplaySource[]> {
    return discoverSources(projectsDir)
  }

  async function doReplay(source: ReplaySource, cursor: ReplayCursor): Promise<ReplayBatch> {
    const conversationId = source.sessionId
    const nowMs = now()
    const recordedAt = new Date(nowMs).toISOString()

    const path = await resolveMemoizedPath(pathMemo, conversationId, {
      exists: p => fsStat(p).then(st => st.isFile(), () => false),
      scan: () => findTranscriptPath(projectsDir, conversationId),
      now: nowMs,
    })
    if (path === null) return { events: [], cursor }

    const events: AgentisticsEvent[] = []
    const emit = (e: AgentisticsEvent) => events.push(e)

    const mainCtx = mainContext(conversationId, recordedAt)
    const incoming = parseCursor(cursor)
    const existing = walks.get(conversationId)
    const trusted = existing && cursorMatches(existing.mainCursor, existing.mainState.lineNo, incoming)
      ? { cursor: existing.mainCursor, state: existing.mainState }
      : null

    const result = await readAndFold(path, trusted, mainCtx, 'main', emit)
    if (!result) return { events: [], cursor }

    // An untrusted cursor re-read the transcript from byte 0 and re-emitted every main-transcript
    // event, so the subagent half must start over too: keeping the old walk's `launchesEmitted` and
    // subagent cursors would answer a caller replaying from scratch (a journal that was lost) with
    // the conversation's own events and none of its subagents'.
    const walk: ConversationWalk = (trusted && existing) ? existing : {
      mainState: result.state,
      mainCursor: result.cursor,
      subagents: new Map(),
      subagentStatus: new Map(),
      launchesEmitted: new Set(),
      usedMs: nowMs,
    }
    walk.mainState = result.state
    walk.mainCursor = result.cursor
    walk.usedMs = nowMs
    walks.set(conversationId, walk)
    sweep(nowMs)

    const st = await fsStat(path).catch(() => null)
    // Compared at WHOLE-millisecond resolution: `Date.now()` is truncated to the millisecond while
    // `mtimeMs` carries a fraction, so a file read in the same millisecond it was written gave a
    // NEGATIVE age and read as still being written (seen on a fast CI runner, never on the WSL box).
    const final = st !== null && nowMs - Math.floor(st.mtimeMs) >= settledMs
    finishClaudeReplay(walk.mainState, { final }, emit)

    if (final) await runSubagentPass(walk, mainCtx, path, conversationId, recordedAt, emit)

    const outCursor = encodeCursor(walk.mainCursor, walk.mainState.lineNo)
    return { events, cursor: outCursor }
  }

  async function replay(source: ReplaySource, cursor: ReplayCursor): Promise<ReplayBatch> {
    const key = source.sessionId
    const busy = reading.get(key)
    if (busy) return busy
    const run = doReplay(source, cursor).finally(() => { reading.delete(key) })
    reading.set(key, run)
    return run
  }

  return { discover, replay }
}

/** The default instance, reading `PROJECTS_DIR` on the real clock — what `INTEGRATIONS.claude` fills. */
export const claudeReplay: HarnessReplay = createClaudeReplay()
