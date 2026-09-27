/**
 * integrations/antigravity/index.ts — the IO half of the Antigravity (agy) replay: which
 * conversations are RUNS, which are CHILDREN of which run, and reading each one's transcript and
 * `gen_metadata` rows into the pure folds (`replay.ts`, `replay-genmeta.ts`).
 *
 * ## Which conversations are runs — legacy's rollup, decided the same way
 *
 * `adapters/antigravity.ts` parses every conversation and then `rollUpAntigravitySessions` folds each
 * `invoke_subagent` CHILD into its nearest PARSED ancestor, so a child never surfaces as a session of
 * its own. The replay reproduces that decision with the SAME pieces:
 * - the child links are `buildAntigravityParentMap` (the parent's own INVOKE_SUBAGENT step, plus
 *   `conversation_summaries.db` when it has rows) — never `history.jsonl`, which rotates;
 * - a conversation is PARSED when it has a genuine user turn (or `history.jsonl` names a first prompt
 *   for it — legacy's own fallback), or when it is a child (children are dispatched, not prompted);
 *   a child with no transcript but a `gen_metadata` table is parsed too (legacy's tokens-only stub);
 * - a RUN is a parsed conversation with no parsed ancestor, and it needs a timestamped step (legacy
 *   drops a session with no `start_time`). Every other parsed conversation is a CHILD `Agent` under
 *   the run its ancestor chain ends at, its parent agent being its nearest parsed ancestor.
 *
 * ## The cursor — a fingerprint, and a whole re-read when it moves
 *
 * One agy conversation is a transcript plus a SQLite file, and a child adds two more. A byte cursor
 * over only one of them would say nothing about the others, so the cursor is a FINGERPRINT of every
 * file the run is read from (size + mtime) plus whether the last read was `final`. An identical
 * fingerprint read `final` returns no events; anything else re-reads the whole run and re-emits every
 * event. That is safe, not merely tolerated: every id is DERIVED from the source record, so an event
 * already seen re-derives the identical `eventId` and the journal dedupes it (the Claude replay's
 * cold-read rule, stated in its own header). A resume is an optimisation; this integration does not
 * implement one yet, and says so.
 *
 * ## Read-only, always
 *
 * The SQLite files are opened exactly as the legacy adapter opens them: `SQLITE_OPEN_READONLY` over a
 * `file:…?immutable=1` URI, so SQLite never creates a `-shm`/`-wal` beside the user's file. Nothing
 * here writes under `~/.gemini`. The cost of `immutable=1` is the legacy one: a generation still in
 * the WAL is read on the next pass.
 */
import { existsSync } from 'node:fs'
import { readFile, readdir, stat as fsStat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentisticsEvent, Id } from '@agentistics/core'
import {
  ANTIGRAVITY_BRAIN_DIR, ANTIGRAVITY_CONVERSATIONS_DIR, ANTIGRAVITY_HISTORY_FILE, ANTIGRAVITY_SUMMARIES_DB,
} from '../../config'
import { toSqliteUriPath } from '../../adapters/antigravity'
import {
  buildAntigravityParentMap, buildAntigravityWorkspaceMap, fileUriToPath, firstHistoryPrompt,
  parseAntigravityHistory, type AntigravityConversationSummary, type AntigravityHistoryEntry,
} from '../../adapters/antigravity-parse'
import type { HarnessReplay, ReplayBatch, ReplayCursor, ReplaySource } from '../types'
import {
  childAgentIdOf, childContext, mainAgentIdOf, mainContext, makeEvent,
  type AntigravityReplayContext, type EmitEvent,
} from './replay-core'
import { emptyAntigravityReplay, finishAntigravityReplay, foldAntigravityReplay, type AntigravityReplayState } from './replay'
import { dominantModel, emptyGenMetaFold, foldGenMetadataRows, type GenMetadataRow } from './replay-genmeta'

/** A transcript quiet this long is settled (the Claude replay's default). */
const DEFAULT_SETTLED_MS = 60_000

export interface AntigravityReplayOptions {
  /** `~/.gemini/antigravity-cli` (or `ANTIGRAVITY_DIR`). Every path below derives from it. */
  rootDir?: string
  now?: () => number
  settledMs?: number
}

interface Paths { brain: string; conversations: string; history: string; summaries: string }

function pathsOf(rootDir?: string): Paths {
  if (!rootDir) {
    return {
      brain: ANTIGRAVITY_BRAIN_DIR, conversations: ANTIGRAVITY_CONVERSATIONS_DIR,
      history: ANTIGRAVITY_HISTORY_FILE, summaries: ANTIGRAVITY_SUMMARIES_DB,
    }
  }
  return {
    brain: join(rootDir, 'brain'), conversations: join(rootDir, 'conversations'),
    history: join(rootDir, 'history.jsonl'), summaries: join(rootDir, 'conversation_summaries.db'),
  }
}

// ── SQLite, read-only ────────────────────────────────────────────────────────────────────────────

async function openReadOnly(file: string): Promise<any | null> {
  if (!existsSync(file)) return null
  try {
    const { Database, constants } = await import('bun:sqlite')
    const flags = constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI
    return new Database(`file:${toSqliteUriPath(file)}?immutable=1`, flags)
  } catch {
    return null
  }
}

/** Every `gen_metadata` row, in `idx` order. Missing / locked / corrupt → `[]`, never a throw. */
export async function readGenMetadataRows(file: string): Promise<GenMetadataRow[]> {
  const db = await openReadOnly(file)
  if (!db) return []
  try {
    const rows = db.query('SELECT idx, data FROM gen_metadata ORDER BY idx').all() as { idx: unknown; data: unknown }[]
    const out: GenMetadataRow[] = []
    for (const r of rows) {
      if (typeof r.idx !== 'number') continue
      const d = r.data
      out.push({ idx: r.idx, data: d instanceof Uint8Array ? d : (d ? new Uint8Array(d as ArrayBufferLike) : null) })
    }
    return out
  } catch {
    return []
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

async function readSummaries(file: string): Promise<AntigravityConversationSummary[]> {
  const db = await openReadOnly(file)
  if (!db) return []
  try {
    return db.query(
      'SELECT conversation_id, title, preview, workspace_uris, parent_conversation_id, nesting_depth FROM conversation_summaries',
    ).all() as AntigravityConversationSummary[]
  } catch {
    return []
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

// ── Discovery ────────────────────────────────────────────────────────────────────────────────────

function transcriptPathOf(brain: string, id: string): string | null {
  const base = join(brain, id, '.system_generated', 'logs')
  const full = join(base, 'transcript_full.jsonl')
  if (existsSync(full)) return full
  const short = join(base, 'transcript.jsonl')
  return existsSync(short) ? short : null
}

/** What discovery learns from one transcript — the pure fold run with a discarding emit. */
interface Scan { size: number; mtimeMs: number; genuine: boolean; opened: boolean; invokeLines: string }

export interface AntigravityIndex {
  /** Run conversation id → its children, each with the agent that dispatched it. */
  runs: Map<string, { conversationId: string; parent: string }[]>
  history: AntigravityHistoryEntry[]
  workspaces: Map<string, string>
  summaries: Map<string, AntigravityConversationSummary>
  transcriptOf: Map<string, string>
}

async function scanTranscript(path: string, memo: Map<string, Scan>): Promise<Scan | null> {
  let st
  try { st = await fsStat(path) } catch { return null }
  const hit = memo.get(path)
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit
  const content = await readFile(path, 'utf-8').catch(() => '')
  if (!content) return null
  const state = emptyAntigravityReplay(mainContext('scan', '1970-01-01T00:00:00.000Z'), 'main')
  foldAntigravityReplay(state, content.split('\n'), () => {})
  const invokeLines = content.split('\n')
    .filter(l => l.includes('INVOKE_SUBAGENT') || l.includes('invoke_subagent')).join('\n')
  const scan: Scan = { size: st.size, mtimeMs: st.mtimeMs, genuine: state.genuine, opened: state.opened, invokeLines }
  memo.set(path, scan)
  return scan
}

export async function buildAntigravityIndex(paths: Paths, memo: Map<string, Scan> = new Map()): Promise<AntigravityIndex> {
  const historyRaw = await readFile(paths.history, 'utf-8').catch(() => '')
  const history = parseAntigravityHistory(historyRaw)
  const workspaces = buildAntigravityWorkspaceMap(history)
  const summariesList = await readSummaries(paths.summaries)
  const summaries = new Map(summariesList.map(s => [s.conversation_id, s]))

  let ids: string[]
  try { ids = (await readdir(paths.brain)).sort() } catch { ids = [] }
  const scans = new Map<string, Scan>()
  const transcriptOf = new Map<string, string>()
  for (const id of ids) {
    const p = transcriptPathOf(paths.brain, id)
    if (!p) continue
    const s = await scanTranscript(p, memo)
    if (!s) continue
    scans.set(id, s)
    transcriptOf.set(id, p)
  }

  // Legacy's own parent map, over the only lines `collectSubagentChildIds` ever reads.
  const parentOf = buildAntigravityParentMap([...scans].map(([id, s]) => [id, s.invokeLines] as const), summariesList)

  // PARSED — legacy's `parsedById`.
  const parsed = new Set<string>()
  for (const [id, s] of scans) {
    if (parentOf.has(id) || s.genuine || firstHistoryPrompt(history, id)) parsed.add(id)
  }
  for (const [childId] of parentOf) {
    if (parsed.has(childId) || scans.has(childId)) continue
    if (!existsSync(join(paths.conversations, `${childId}.db`))) continue
    if ((await readGenMetadataRows(join(paths.conversations, `${childId}.db`))).length === 0) continue
    parsed.add(childId)
  }

  // `rollUpAntigravitySessions`'s `anchorOf`: the nearest PARSED ancestor.
  const anchorOf = (id: string): string | null => {
    const seen = new Set<string>([id])
    let cur = parentOf.get(id)
    while (cur && !seen.has(cur)) {
      if (parsed.has(cur)) return cur
      seen.add(cur)
      cur = parentOf.get(cur)
    }
    return null
  }
  const rootOf = (id: string): string => {
    const seen = new Set<string>([id])
    let cur = id
    for (;;) {
      const a = anchorOf(cur)
      if (!a || seen.has(a)) return cur
      seen.add(a)
      cur = a
    }
  }

  const runs = new Map<string, { conversationId: string; parent: string }[]>()
  for (const id of [...parsed].sort()) {
    if (anchorOf(id) !== null) continue
    // Legacy drops a session with no start_time: a run needs a timestamped step.
    if (!scans.get(id)?.opened) continue
    runs.set(id, [])
  }
  for (const id of [...parsed].sort()) {
    const a = anchorOf(id)
    if (a === null) continue
    const root = rootOf(id)
    runs.get(root)?.push({ conversationId: id, parent: a })
  }
  return { runs, history, workspaces, summaries, transcriptOf }
}

// ── Reading one run ──────────────────────────────────────────────────────────────────────────────

function projectPathOf(index: AntigravityIndex, id: string): string {
  const w = index.workspaces.get(id)
  if (w) return w
  const s = index.summaries.get(id)
  if (s && typeof s.workspace_uris === 'string') {
    try {
      const uris = JSON.parse(s.workspace_uris)
      if (Array.isArray(uris) && typeof uris[0] === 'string') return fileUriToPath(uris[0])
    } catch { /* legacy keeps the empty path */ }
  }
  return ''
}

async function fingerprintOf(files: string[]): Promise<string[]> {
  const out: string[] = []
  for (const f of files) {
    const st = await fsStat(f).catch(() => null)
    out.push(st ? `${f}\0${st.size}\0${Math.floor(st.mtimeMs)}` : `${f}\0-`)
  }
  return out
}

/**
 * Read one run — its own conversation and every child — and emit its events. Exported so the
 * differential can drive it with a fixed clock and a fixed index.
 */
export async function replayRun(
  paths: Paths, index: AntigravityIndex, runId: string, recordedAt: string, final: boolean, emit: EmitEvent,
): Promise<boolean> {
  const children = index.runs.get(runId)
  const mainPath = index.transcriptOf.get(runId)
  if (!children || !mainPath) return false

  const mainRows = await readGenMetadataRows(join(paths.conversations, `${runId}.db`))
  const projectPath = projectPathOf(index, runId)
  const mainCtx: AntigravityReplayContext = {
    ...mainContext(runId, recordedAt, projectPath || undefined),
    ...(mainRows.length ? { modelHint: dominantModel(mainRows) || undefined } : {}),
  }
  const content = await readFile(mainPath, 'utf-8').catch(() => '')
  const main = emptyAntigravityReplay(mainCtx, 'main')
  const buffered: AgentisticsEvent[] = []
  foldAntigravityReplay(main, content.split('\n'), e => buffered.push(e))
  if (!main.opened || main.minMs === null) return false
  for (const e of buffered) emit(e)
  const mainStart = new Date(main.minMs).toISOString()
  foldGenMetadataRows(emptyGenMetaFold(mainCtx, mainStart), mainRows, emit)
  finishAntigravityReplay(main, { final }, emit)

  let endMs = main.maxMs!
  let endRef = main.maxRef!
  const agentOf = new Map<string, Id>([[runId, mainAgentIdOf(runId)]])
  for (const c of children) agentOf.set(c.conversationId, childAgentIdOf(runId, c.conversationId))

  for (const c of children) {
    const parentAgent = agentOf.get(c.parent) ?? mainAgentIdOf(runId)
    const rows = await readGenMetadataRows(join(paths.conversations, `${c.conversationId}.db`))
    const ctx: AntigravityReplayContext = {
      ...childContext(runId, c.conversationId, parentAgent, recordedAt),
      ...(rows.length ? { modelHint: dominantModel(rows) || undefined } : {}),
    }
    const p = index.transcriptOf.get(c.conversationId)
    const child = emptyAntigravityReplay(ctx, 'child')
    if (p) {
      const text = await readFile(p, 'utf-8').catch(() => '')
      foldAntigravityReplay(child, text.split('\n'), emit)
    }
    const fallback = child.minMs !== null ? new Date(child.minMs).toISOString() : mainStart
    const g = emptyGenMetaFold(ctx, fallback)
    // A child with no timestamped transcript step (a tokens-only child whose brain/ was pruned) is
    // opened by its first row and closed by its last — or, with neither, by the run's own start.
    const rowEvents: AgentisticsEvent[] = []
    foldGenMetadataRows(g, rows, e => rowEvents.push(e))
    if (!child.opened) {
      const at = g.firstAt ?? mainStart
      emit(makeEvent(ctx, 'agent.started', { kind: 'subagent', parentAgentId: parentAgent, agentType: 'invoke_subagent' }, {
        sourceRef: g.firstRef ?? `${ctx.sourceRefBase}:0`,
        occurredAt: at, confidence: g.firstAt ? 'exact' : 'estimated',
      }))
    }
    for (const e of rowEvents) emit(e)
    finishAntigravityReplay(child, { final }, emit)
    if (!child.opened && final) {
      emit(makeEvent(ctx, 'agent.ended', { status: 'completed' }, {
        sourceRef: g.lastRef ?? `${ctx.sourceRefBase}:0`,
        occurredAt: g.lastEventAt ?? mainStart, confidence: g.lastEventAt ? 'exact' : 'estimated',
      }))
    }
    // Legacy extends the session's window over a child's TRANSCRIPT steps only.
    if (child.maxMs !== null && child.maxMs > endMs) { endMs = child.maxMs; endRef = child.maxRef! }
  }

  if (final) {
    const base = { sourceRef: endRef, occurredAt: new Date(endMs).toISOString(), confidence: 'exact' as const, agentId: null }
    emit(makeEvent(mainCtx, 'run.ended', { status: 'completed' }, base))
    emit(makeEvent(mainCtx, 'session.ended', {}, base))
  }
  return true
}

// ── The integration ─────────────────────────────────────────────────────────────────────────────

export function createAntigravityReplay(opts: AntigravityReplayOptions = {}): HarnessReplay {
  const paths = pathsOf(opts.rootDir)
  const now = opts.now ?? Date.now
  const settledMs = opts.settledMs ?? DEFAULT_SETTLED_MS
  const scanMemo = new Map<string, Scan>()
  let index: AntigravityIndex | null = null

  async function discover(): Promise<ReplaySource[]> {
    index = await buildAntigravityIndex(paths, scanMemo)
    return [...index.runs.keys()].map(id => ({ sessionId: id, sourceRef: `antigravity:${id}` }))
  }

  async function replay(source: ReplaySource, cursor: ReplayCursor): Promise<ReplayBatch> {
    if (!index || !index.runs.has(source.sessionId)) index = await buildAntigravityIndex(paths, scanMemo)
    const runId = source.sessionId
    const children = index.runs.get(runId)
    const mainPath = index.transcriptOf.get(runId)
    if (!children || !mainPath) return { events: [], cursor }

    const files = [mainPath, join(paths.conversations, `${runId}.db`)]
    for (const c of children) {
      const p = index.transcriptOf.get(c.conversationId)
      if (p) files.push(p)
      files.push(join(paths.conversations, `${c.conversationId}.db`))
    }
    const nowMs = now()
    const prints = await fingerprintOf(files)
    let newest = 0
    for (const f of files) {
      const st = await fsStat(f).catch(() => null)
      if (st) newest = Math.max(newest, Math.floor(st.mtimeMs))
    }
    const final = nowMs - newest >= settledMs
    const out = JSON.stringify({ v: 1, final, files: prints })
    if (cursor === out && final) return { events: [], cursor: out }

    const events: AgentisticsEvent[] = []
    await replayRun(paths, index, runId, new Date(nowMs).toISOString(), final, e => events.push(e))
    return { events, cursor: out }
  }

  return { discover, replay }
}

/** The default instance, reading `ANTIGRAVITY_DIR` on the real clock — what `INTEGRATIONS.antigravity` would fill. */
export const antigravityReplay: HarnessReplay = createAntigravityReplay()
