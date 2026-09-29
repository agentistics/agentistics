/**
 * session/undo.ts — H4: `/undo` for a native session. Reverts the agent's LAST file change set — the
 * writes `file.patch` / `file.write` made in the newest run of the session that still has any not yet
 * undone — from the durable checkpoint (`checkpoint-store.ts`). Undoing again walks one change set
 * further back.
 *
 * ## What it does NOT cover (said in words, as `tools/file/checkpoint.ts` already says)
 *
 * Only writes made THROUGH the file tools of this runtime are recorded. A change the shell made
 * (`sed -i`, a formatter, `git checkout`) is invisible here by construction, and the result says so
 * every time (`UNDO_SCOPE_SENTENCE`). The conversation is not rewound either: the model is not told
 * its edits were reverted (whole-state checkpoints are spec ext. 9, "later"); the read ledger makes
 * it re-read a reverted file before it may edit it again.
 *
 * ## An undo is a WRITE, so it goes through the policy like one
 *
 * The files are put back by `file.undo`, a tool run through the ONE gate (`tools/gate.ts`) with the
 * session's own policy — kind `file`, class `ask`, the same class `file.write` has. So the floor
 * binds exactly as it does for the agent (an undo can never write inside `.git/` or into a credential
 * path), a deny rule on a path binds, a profile where `ask` means deny refuses it, and the default
 * asks the person, naming every file. The gate journals it like any call — `tool.requested`, the
 * policy's verdict, then `tool.completed` carrying `filesTouched` (paths, never contents). A policy
 * refusal refuses the WHOLE undo: nothing is written, nothing is marked undone.
 *
 * `file.undo` is never in the catalogue a model is offered — only a person reaches it, through
 * `SessionRuntime.undo`.
 *
 * ## A file somebody changed since is never overwritten
 *
 * Each file is compared with what the agent LAST left there. A mismatch — the person edited it, or
 * another process did — refuses THAT file in a sentence, and the rest is undone only when the caller
 * passes `confirm` (a person said yes). The comparison is made twice: once to plan, and again inside
 * the tool immediately before each write, so a file touched between the question and the answer is
 * still refused rather than overwritten.
 */

import { readFile } from 'node:fs/promises'
import { createToolEventEmitter } from '../loop/emit.ts'
import type { ProviderJournalSink } from '../provider/emit.ts'
import type { PersonAsker, PolicySubject, ToolPolicy } from '../tools/contract.ts'
import { defineTool } from '../tools/define.ts'
import type { DiskAccess } from '../tools/file/checkpoint.ts'
import { atomicWriteFile, removeFile } from '../tools/file/fs-io.ts'
import { runTool } from '../tools/gate.ts'
import type { CheckpointIndex, CheckpointRow, UndoOutcomeKind } from './checkpoint-store.ts'
import type { SessionContentStore } from './runtime.ts'

export const UNDO_TOOL_NAME = 'file.undo'

/** Stated on every result: what an undo can and cannot put back. */
export const UNDO_SCOPE_SENTENCE =
  'Undo covers only files the agent changed through its file tools; anything a shell command changed is not recorded and was not touched.'

// ── The pure half: which files can be put back ────────────────────────────────────────────────

export type UndoRefusalCode = 'changed' | 'unrecoverable'

export interface UndoRefusal {
  path: string
  code: UndoRefusalCode
  sentence: string
}

export interface UndoReady {
  path: string
  /** What the undo does to the file: remove one the agent created, recreate one it deleted, or put
   *  the earlier content back. */
  op: 'delete' | 'create' | 'overwrite'
  /** The content to put back; `null` = remove the file. */
  restore: string | null
  /** What the agent last left there; the tool re-checks the disk against it before writing. */
  expect: string | null
}

/** One path of a change set, with its bodies read back and the disk as it is now. */
export interface UndoCandidate {
  path: string
  /** `false`: some checkpoint of this path could not be kept or its body is gone. */
  recoverable: boolean
  before: string | null
  after: string | null
  current: string | null
}

export function refusalSentence(path: string, code: UndoRefusalCode): string {
  return code === 'changed'
    ? `${path} changed after the agent wrote it (you or another process edited it), so undo will not overwrite it.`
    : `${path} cannot be undone: its checkpoint could not be kept.`
}

/** PURE: split a change set into what can be put back and what is refused, and why. */
export function classifyUndo(candidates: readonly UndoCandidate[]): { ready: UndoReady[]; refused: UndoRefusal[] } {
  const ready: UndoReady[] = []
  const refused: UndoRefusal[] = []
  for (const c of candidates) {
    if (!c.recoverable) {
      refused.push({ path: c.path, code: 'unrecoverable', sentence: refusalSentence(c.path, 'unrecoverable') })
      continue
    }
    if (c.current !== c.after) {
      refused.push({ path: c.path, code: 'changed', sentence: refusalSentence(c.path, 'changed') })
      continue
    }
    const op: UndoReady['op'] = c.before === null ? 'delete' : c.after === null ? 'create' : 'overwrite'
    ready.push({ path: c.path, op, restore: c.before, expect: c.after })
  }
  return { ready, refused }
}

/** PURE: group a run's rows by path, in first-touch order (the `planRestore` reduction, on refs). */
export function groupRowsByPath(rows: readonly CheckpointRow[]): Array<{ path: string; rows: CheckpointRow[] }> {
  const byPath = new Map<string, CheckpointRow[]>()
  for (const r of rows) {
    const list = byPath.get(r.path)
    if (list) list.push(r)
    else byPath.set(r.path, [r])
  }
  return [...byPath].map(([path, list]) => ({ path, rows: list }))
}

// ── The tool the undo writes through ──────────────────────────────────────────────────────────

export interface UndoToolInput {
  files: UndoReady[]
}

export interface UndoToolResult {
  restored: string[]
  /** Changed between the plan and the write — left as it is. */
  changed: string[]
  /** The write itself failed (a permission error, a full disk). */
  failed: string[]
}

export function fsDiskAccess(): DiskAccess {
  return {
    async read(path) {
      try { return await readFile(path, 'utf8') } catch { return null }
    },
    write: atomicWriteFile,
    remove: removeFile,
  }
}

/** `file.undo` — put a planned change set back. Built per undo; never offered to a model. */
export function createUndoTool(disk: DiskAccess) {
  return defineTool<UndoToolInput>({
    name: UNDO_TOOL_NAME,
    description: 'Reverts the agent\'s last file change set (a person\'s /undo). Never offered to a model.',
    kind: 'file',
    permission: 'ask',
    inputSchema: { type: 'object' },
    parse(input: unknown): UndoToolInput | string {
      const files = (input as { files?: unknown } | null)?.files
      if (!Array.isArray(files) || files.length === 0) return 'Nothing to undo.'
      return { files: files as UndoReady[] }
    },
    async subjects(input): Promise<readonly PolicySubject[]> {
      return input.files.map(f => ({ action: 'write' as const, path: f.path, op: f.op }))
    },
    async run(input) {
      const out: UndoToolResult = { restored: [], changed: [], failed: [] }
      for (const f of input.files) {
        const current = await disk.read(f.path)
        if (current !== f.expect) { out.changed.push(f.path); continue }
        try {
          if (f.restore === null) await disk.remove(f.path)
          else await disk.write(f.path, f.restore)
          out.restored.push(f.path)
        } catch {
          out.failed.push(f.path)
        }
      }
      const modelText = `Undo restored ${out.restored.length} file(s); ${out.changed.length} changed meanwhile and were left; ${out.failed.length} could not be written.`
      return {
        ok: out.failed.length === 0,
        modelText,
        ...(out.failed.length === 0 ? {} : { error: { class: 'internal' as const, detail: modelText } }),
        facts: { filesTouched: out.restored },
        result: out,
      }
    },
  })
}

// ── The orchestration ─────────────────────────────────────────────────────────────────────────

export interface UndoOptions {
  /** A person agreed to undo the rest when some files are refused, or to reach past the last turn. */
  confirm?: boolean
  signal?: AbortSignal
}

export type UndoResult =
  | { status: 'nothing'; sentence: string }
  | {
      /** Nothing was written. Asked again with `confirm: true`, the `ready` files are put back. */
      status: 'needs-confirmation'
      runId: string | null
      /** `false`: this change set is from an EARLIER turn than the session's last one. */
      lastTurn: boolean
      ready: UndoReady[]
      refused: UndoRefusal[]
      sentence: string
    }
  | { status: 'denied'; runId: string | null; sentence: string; policy?: string }
  | {
      status: 'done'
      runId: string | null
      lastTurn: boolean
      restored: string[]
      /** Refused before writing (consented) or changed while writing — left as they are. */
      kept: UndoRefusal[]
      /** The write failed; these stay undoable. */
      failed: string[]
      sentence: string
    }

export interface UndoDeps {
  index: CheckpointIndex
  content: SessionContentStore
  policy: ToolPolicy
  asker?: PersonAsker
  journal: ProviderJournalSink | null
  runtimeVersion: string
  workspaceRoot: string
  cwd: string
  /** The session's newest run id, to say whether this change set is from the last turn. */
  latestRunId: string | null
  disk?: DiskAccess
  now?: () => Date
}

function doneSentence(restored: number, kept: number, failed: number): string {
  const parts = [`Undid ${restored} file(s).`]
  if (kept > 0) parts.push(`${kept} left as they are.`)
  if (failed > 0) parts.push(`${failed} could not be written and can be undone again.`)
  parts.push(UNDO_SCOPE_SENTENCE)
  return parts.join(' ')
}

/** Undo the newest change set of `sessionId`. See the module doc for every rule it keeps. */
export async function undoLastChange(sessionId: string, deps: UndoDeps, opts: UndoOptions = {}): Promise<UndoResult> {
  const now = deps.now ?? (() => new Date())
  const disk = deps.disk ?? fsDiskAccess()
  const rows = await deps.index.latestUndoable(sessionId)
  if (rows.length === 0) {
    return { status: 'nothing', sentence: `Nothing to undo: the agent has no file changes left to revert in this session. ${UNDO_SCOPE_SENTENCE}` }
  }
  const runId = rows[0]!.runId
  const lastTurn = runId !== null && runId === deps.latestRunId

  const candidates: UndoCandidate[] = []
  for (const g of groupRowsByPath(rows)) {
    const first = g.rows[0]!
    const last = g.rows[g.rows.length - 1]!
    let recoverable = g.rows.every(r => r.stored)
    let before: string | null = null
    let after: string | null = null
    if (recoverable && first.before !== null) {
      before = await deps.content.get(first.before.sha256)
      if (before === null) recoverable = false
    }
    if (recoverable && last.after !== null) {
      after = await deps.content.get(last.after.sha256)
      if (after === null) recoverable = false
    }
    candidates.push({ path: g.path, recoverable, before, after, current: await disk.read(g.path) })
  }
  const { ready, refused } = classifyUndo(candidates)

  if (!opts.confirm && (refused.length > 0 || !lastTurn)) {
    const why = [
      ...(lastTurn ? [] : ['This change set is from an earlier turn, not the last one.']),
      ...refused.map(r => r.sentence),
      ready.length > 0 ? `Confirm to undo the other ${ready.length} file(s).` : 'No file of this change set can be undone.',
    ]
    return { status: 'needs-confirmation', runId, lastTurn, ready, refused, sentence: why.join(' ') }
  }

  const rowsOf = (path: string) => rows.filter(r => r.path === path)
  const at = () => now().toISOString()

  if (ready.length === 0) {
    // Consented, and nothing can be put back: the change set is settled as kept so the next undo
    // can reach the one before it rather than stopping here forever.
    await deps.index.markUndone(rows.map(r => ({ id: r.id, outcome: 'kept' as const })), at())
    return { status: 'done', runId, lastTurn, restored: [], kept: refused, failed: [], sentence: doneSentence(0, refused.length, 0) }
  }

  const emitter = createToolEventEmitter({ journal: deps.journal, adapterVersion: deps.runtimeVersion, scope: { sessionId }, now })
  const gate = await runTool(createUndoTool(disk), { files: ready }, {
    workspaceRoot: deps.workspaceRoot,
    cwd: deps.cwd,
    signal: opts.signal ?? new AbortController().signal,
    sessionId,
    now,
  }, { policy: deps.policy, events: emitter, content: deps.content, asker: deps.asker })

  if (gate.status === 'denied') {
    const v = gate.verdict
    return { status: 'denied', runId, sentence: gate.outcome.modelText, ...(v ? { policy: v.policy } : {}) }
  }
  const result = gate.outcome.result as UndoToolResult | undefined
  if (!result) {
    return { status: 'denied', runId, sentence: gate.outcome.modelText }
  }

  const kept: UndoRefusal[] = [
    ...refused,
    ...result.changed.map(path => ({ path, code: 'changed' as const, sentence: refusalSentence(path, 'changed') })),
  ]
  const marks: Array<{ id: number; outcome: UndoOutcomeKind }> = []
  for (const path of result.restored) for (const r of rowsOf(path)) marks.push({ id: r.id, outcome: 'restored' })
  for (const k of kept) for (const r of rowsOf(k.path)) marks.push({ id: r.id, outcome: 'kept' })
  await deps.index.markUndone(marks, at())

  return {
    status: 'done',
    runId,
    lastTurn,
    restored: result.restored,
    kept,
    failed: result.failed,
    sentence: doneSentence(result.restored.length, kept.length, result.failed.length),
  }
}
