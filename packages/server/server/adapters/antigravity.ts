// packages/server/server/adapters/antigravity.ts
import { join } from 'path'
import { readFile, stat } from 'fs/promises'
import { existsSync } from 'fs'
import type { SessionMeta } from '@agentistics/core'
import type { HarnessAdapter } from './types'
import { harnessEnabled } from './types'
import {
  ANTIGRAVITY_DIR,
  ANTIGRAVITY_BRAIN_DIR,
  ANTIGRAVITY_HISTORY_FILE,
  ANTIGRAVITY_CONVERSATIONS_DIR,
  ANTIGRAVITY_SUMMARIES_DB,
} from '../config'
import { createLimiter, safeReadDir } from '../utils'
import { parseGenMetadataBlob } from './antigravity-protobuf'
import type {
  AntigravityConversationSummary,
  AntigravityTokenTotals,
} from './antigravity-parse'

/** Per-conversation transcript. `transcript_full.jsonl` is the same steps with untruncated
 *  content, so it is preferred; `transcript.jsonl` is the fallback. */
function transcriptPath(conversationId: string, full: boolean): string {
  return join(
    ANTIGRAVITY_BRAIN_DIR,
    conversationId,
    '.system_generated',
    'logs',
    full ? 'transcript_full.jsonl' : 'transcript.jsonl',
  )
}

/** Absolute filesystem path → the path part of a SQLite `file:` URI.
 *  Backslashes become `/` (Windows), and `?` / `#` are escaped so they cannot be mistaken for the
 *  query/fragment separators. Exported for the sidecar test. */
export function toSqliteUriPath(file: string): string {
  const normalized = String(file ?? '').replace(/\\/g, '/')
  const withRoot = normalized.startsWith('/') ? normalized : `/${normalized}`
  return withRoot.replace(/\?/g, '%3f').replace(/#/g, '%23')
}

/**
 * Open a SQLite file READ-ONLY via bun:sqlite — and, crucially, without touching the directory.
 *
 * The whole call is guarded: `bun:sqlite` is a Bun builtin (this server always runs on Bun, but
 * the module is imported dynamically so a non-Bun runtime degrades instead of crashing at import
 * time), and the file may be missing, locked by a running agy, or corrupt. Any of those returns
 * null and the caller falls back to "no data".
 *
 * Caveat of `immutable=1`: SQLite then ignores any `-wal` file, so generations agy has written but
 * not yet checkpointed are read on the NEXT refresh instead of this one. That is the right trade:
 * a few seconds of lag beats writing into the user's data directory, and the SSE watcher on
 * conversations/ re-reads as soon as the DB changes.
 */
async function openReadOnly(file: string): Promise<any | null> {
  if (!existsSync(file)) return null
  try {
    const { Database, constants } = await import('bun:sqlite')
    // `{ readonly: true }` alone is NOT read-only on disk: agy's DBs are in WAL mode, and opening
    // a WAL database — even for reading — makes SQLite create the `-shm` shared-memory index (and
    // an empty `-wal`) NEXT TO THE USER'S FILE. Agentistics must never write into ~/.gemini.
    // The `immutable=1` URI promises the file will not change under us, which makes SQLite skip
    // the WAL/locking machinery entirely: no sidecar is created. Verified empirically against a
    // pristine copy of a real conversation DB (see antigravity-sqlite.test.ts).
    // The URI form needs SQLITE_OPEN_URI, which bun:sqlite only sets when flags are passed as a
    // number, so the numeric flag form is used instead of `{ readonly: true }`.
    const flags = constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI
    return new Database(`file:${toSqliteUriPath(file)}?immutable=1`, flags)
  } catch {
    return null
  }
}

/** Query helper that never throws (a missing table is an ordinary outcome here). */
function queryAll(db: any, sql: string): any[] {
  try {
    const rows = db.query(sql).all()
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

function closeQuietly(db: any): void {
  try { db.close() } catch { /* already closed / never opened */ }
}

/**
 * Sum every `gen_metadata` row of one conversation into token totals.
 *
 * Per the verified wire format: input += f1.4.2, cache_read += f1.4.5, output += f1.4.3. Field
 * 1.4.3 ALREADY contains the thinking tokens (f1.4.9), so f1.4.9 is never added; f1.4.1 is the
 * CONSTANT system-instruction size and belongs in no sum at all. The context gauge (f1.9.10.1) and
 * the window agy declares (f1.9.10.4) are levels, read off the last row that carried them rather
 * than accumulated. The model id is the most frequent f1.19 across the rows (a conversation can
 * switch models mid-way; the dominant one is the honest single label).
 *
 * A missing / locked / corrupt DB yields null → the session reports zero tokens.
 */
export async function readAntigravityTokens(
  conversationId: string,
): Promise<AntigravityTokenTotals | null> {
  return readAntigravityTokensFromFile(join(ANTIGRAVITY_CONVERSATIONS_DIR, `${conversationId}.db`))
}

/** Same as {@link readAntigravityTokens} but for an explicit DB path (used by the tests, which
 *  must not depend on the process-wide ANTIGRAVITY_DIR resolved at import time). */
export async function readAntigravityTokensFromFile(
  file: string,
): Promise<AntigravityTokenTotals | null> {
  const db = await openReadOnly(file)
  if (!db) return null
  try {
    const rows = queryAll(db, 'SELECT data FROM gen_metadata')
    if (rows.length === 0) return null
    let inputTokens = 0
    let cachedTokens = 0
    let outputTokens = 0
    let rowCount = 0
    // The gauge and the window agy declares beside it, off the LAST row that carried each — never
    // accumulated. `SELECT` with no ORDER BY walks the table in rowid order, which is insertion
    // order, so the last row is the newest generation. A row missing either one leaves the previous
    // reading standing rather than zeroing it.
    let contextTokens = 0
    let contextWindow = 0
    const modelCounts = new Map<string, number>()
    const byModel: Record<string, { inputTokens: number; cachedTokens: number; outputTokens: number }> = {}
    for (const row of rows) {
      const blob = row?.data
      const meta = parseGenMetadataBlob(
        blob instanceof Uint8Array ? blob : (blob ? new Uint8Array(blob) : null),
      )
      if (!meta) continue
      rowCount++
      if (meta.contextTokens > 0) contextTokens = meta.contextTokens
      if (meta.contextWindow > 0) contextWindow = meta.contextWindow
      inputTokens += meta.inputTokens
      cachedTokens += meta.cachedTokens
      outputTokens += meta.outputTokens
      if (meta.modelId) {
        modelCounts.set(meta.modelId, (modelCounts.get(meta.modelId) ?? 0) + 1)
        const e = byModel[meta.modelId]
          ?? (byModel[meta.modelId] = { inputTokens: 0, cachedTokens: 0, outputTokens: 0 })
        e.inputTokens += meta.inputTokens
        e.cachedTokens += meta.cachedTokens
        e.outputTokens += meta.outputTokens
      }
    }
    let modelId = ''
    let best = 0
    for (const [id, n] of modelCounts) if (n > best) { best = n; modelId = id }
    return {
      inputTokens, cachedTokens, outputTokens, modelId, byModel, rowCount,
      ...(contextTokens > 0 ? { contextTokens } : {}),
      ...(contextWindow > 0 ? { contextWindow } : {}),
    }
  } catch {
    return null
  } finally {
    closeQuietly(db)
  }
}

/** Read conversation_summaries.db. Missing DB / empty table → []. Never throws. */
export async function readAntigravitySummaries(): Promise<AntigravityConversationSummary[]> {
  const db = await openReadOnly(ANTIGRAVITY_SUMMARIES_DB)
  if (!db) return []
  try {
    return queryAll(
      db,
      'SELECT conversation_id, title, preview, workspace_uris, parent_conversation_id, nesting_depth'
      + ' FROM conversation_summaries',
    ) as AntigravityConversationSummary[]
  } finally {
    closeQuietly(db)
  }
}

/**
 * A tokens-only parsed stub for a conversation whose transcript is gone but whose DB still holds
 * `gen_metadata` rows. It exists solely to be folded into a parent by the rollup — it carries no
 * timestamps, so if its parent chain were missing too it would be dropped by the `start_time`
 * guard rather than pretending to be a session.
 */
function tokenOnlyStub(conversationId: string, tokens: AntigravityTokenTotals): {
  session: SessionMeta
  modifiedFiles: string[]
} {
  const byModel = tokens.byModel ?? {}
  const modelUsage: Record<string, import('@agentistics/core').ModelUsage> = {}
  for (const [model, t] of Object.entries(byModel)) {
    if (!model) continue
    modelUsage[model] = {
      inputTokens: t.inputTokens, outputTokens: t.outputTokens,
      cacheReadInputTokens: t.cachedTokens, cacheCreationInputTokens: 0,
      webSearchRequests: 0, costUSD: 0,
    }
  }
  return {
    modifiedFiles: [],
    session: {
      session_id: conversationId,
      project_path: '',
      start_time: '',
      duration_minutes: 0,
      user_message_count: 0,
      assistant_message_count: 0,
      tool_counts: {},
      tool_output_tokens: {},
      agent_file_reads: {},
      languages: [],
      git_commits: 0,
      git_pushes: 0,
      input_tokens: tokens.inputTokens,
      output_tokens: tokens.outputTokens,
      cache_read_input_tokens: tokens.cachedTokens,
      cache_creation_input_tokens: 0,
      first_prompt: '',
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
      model: tokens.modelId || undefined,
      ...(Object.keys(modelUsage).length > 1 ? { model_usage: modelUsage } : {}),
      harness: 'antigravity',
      _source: 'jsonl',
    },
  }
}

/**
 * The rebuild storm (v2.103.1): every `/api/data` build re-read every agy transcript and re-opened
 * every conversation DB — ~100–160 ms a build, every ~2 s, for conversations nobody had touched.
 * The whole result is a function of those files, so it is remembered under a fingerprint of their
 * (mtime, size) — one `stat` per file — and handed out as a COPY (callers stamp fields onto it).
 */
let lastLoad: { fp: string; sessions: SessionMeta[] } | null = null
async function antigravityFingerprint(ids: readonly string[]): Promise<string> {
  const one = async (p: string) => { const st = await stat(p).catch(() => null); return st ? `${st.mtimeMs}:${st.size}` : '-' }
  const limit = createLimiter(40)
  const parts = await Promise.all(ids.map(id => limit(async () =>
    `${id}|${await one(transcriptPath(id, true))}|${await one(transcriptPath(id, false))}|${await one(join(ANTIGRAVITY_CONVERSATIONS_DIR, `${id}.db`))}`)))
  // Children with a DB and no transcript directory are read too, so the DB DIRECTORY's listing counts.
  const dbs = (await safeReadDir(ANTIGRAVITY_CONVERSATIONS_DIR)).filter(f => f.endsWith('.db')).sort().join(',')
  return [await one(ANTIGRAVITY_HISTORY_FILE), await one(ANTIGRAVITY_SUMMARIES_DB), dbs, ...parts].join('\n')
}

export const antigravityAdapter: HarnessAdapter = {
  id: 'antigravity',
  dataRoot: ANTIGRAVITY_DIR,
  isAvailable() {
    return harnessEnabled('antigravity') && existsSync(ANTIGRAVITY_BRAIN_DIR)
  },
  async loadSessions(): Promise<SessionMeta[]> {
    const {
      parseAntigravityHistory,
      buildAntigravityWorkspaceMap,
      buildAntigravityParentMap,
      parseAntigravityTranscriptDetailed,
      rollUpAntigravitySessions,
    } = await import('./antigravity-parse')
    type Parsed = import('./antigravity-parse').AntigravityParsed

    const fpIds = (await safeReadDir(ANTIGRAVITY_BRAIN_DIR)).sort()
    const fp = await antigravityFingerprint(fpIds)
    if (lastLoad && lastLoad.fp === fp) return structuredClone(lastLoad.sessions)

    // history.jsonl is global (all conversations) — read it once and index by conversationId.
    // It rotates, so it is only ever a hint (first_prompt + workspace), never a drop reason.
    const historyRaw = await readFile(ANTIGRAVITY_HISTORY_FILE, 'utf-8').catch(() => '')
    const historyEntries = parseAntigravityHistory(historyRaw)
    const workspaces = buildAntigravityWorkspaceMap(historyEntries)

    const conversationIds = await safeReadDir(ANTIGRAVITY_BRAIN_DIR)
    const limit = createLimiter(20)

    // Pass 1 — read every transcript (needed in full before parsing, because the parent→child
    // subagent links live in the PARENTS' transcripts).
    const transcripts = new Map<string, string>()
    await Promise.all(conversationIds.map(id => limit(async () => {
      let file = transcriptPath(id, true)
      if (!existsSync(file)) file = transcriptPath(id, false)
      if (!existsSync(file)) return
      const content = await readFile(file, 'utf-8').catch(() => '')
      if (content) transcripts.set(id, content)
    })))

    const summaries = await readAntigravitySummaries()
    const summaryById = new Map(summaries.map(s => [s.conversation_id, s]))
    // child id → parent id. A child's tokens live in ITS OWN conversations/<child>.db, so the
    // link is what lets that spend be folded into the parent instead of being thrown away.
    const parentOf = buildAntigravityParentMap(transcripts, summaries)

    // Pass 2 — decode tokens and parse EVERY conversation, children included. Children are parsed
    // with allowNoUserTurn (they are dispatched, not prompted) and are folded into their parent by
    // rollUpAntigravitySessions below; they never surface as sessions of their own.
    const parsedEntries = await Promise.all([...transcripts].map(([id, content]) => limit(async () => {
      const tokens = await readAntigravityTokens(id)
      const parsed = parseAntigravityTranscriptDetailed(content, id, workspaces.get(id) ?? '', {
        historyEntries,
        tokens,
        summary: summaryById.get(id) ?? null,
        allowNoUserTurn: parentOf.has(id),
      })
      return parsed ? ([id, parsed] as const) : null
    })))

    const parsedById = new Map<string, Parsed>()
    for (const entry of parsedEntries) if (entry) parsedById.set(entry[0], entry[1])

    // A child conversation can have a DB but no transcript directory (agy prunes brain/ before
    // conversations/). Its spend is real, so pick it up as a tokens-only stub that the rollup
    // folds into the parent — dropping it would under-report cost.
    for (const [childId] of parentOf) {
      if (parsedById.has(childId)) continue
      if (!existsSync(join(ANTIGRAVITY_CONVERSATIONS_DIR, `${childId}.db`))) continue
      const tokens = await readAntigravityTokens(childId)
      if (!tokens) continue
      parsedById.set(childId, tokenOnlyStub(childId, tokens))
    }

    const sessions = rollUpAntigravitySessions(parsedById, parentOf)
    const out = sessions.filter((s): s is SessionMeta => s !== null && !!s.start_time)
    lastLoad = { fp, sessions: structuredClone(out) }
    return out
  },
}
