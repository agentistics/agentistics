/**
 * tools/file/patch.ts — `file.patch` (kind `file`, permission `ask`; spec §2 D-T1, §4). Parses the
 * model's patch TEXT (`./patch-grammar.ts`, pure) into per-file hunks, then for each `Update` hunk
 * locates its context by CONTENT via the three-tier matcher (`./match.ts`) — never by line number.
 *
 * ## All-or-nothing (spec §4)
 *
 * Every file of the patch is fully VALIDATED first — existence, the read-before-write staleness
 * check, and (for `update`) locating every hunk — before anything is written. Only once every file
 * validates does the WRITE phase start; each file is written atomically (temp file + rename in the
 * same directory), and if a later file's write throws, every file already written in this call is
 * rolled back to what it held before this patch, in reverse order, and the call fails. A patch
 * that does not apply cleanly therefore leaves NO half-written file on disk, ever.
 *
 * ## Read-before-write (spec §2 D-T1)
 *
 * Updating or deleting an EXISTING file requires its path to be in the shared `ReadLedger` (a
 * prior `file.read`, or a prior successful `file.write`/`file.patch` on it — the ledger is
 * per-session, shared by all three tools) AND the disk content to still hash to what the ledger
 * recorded — checked again at write time, not only at validation, because a `stale` verdict caught
 * a moment before the write is the whole point of re-checking rather than trusting the read. Both
 * "never read" and "changed since read" refuse with the `stale` class (`../contract.ts`'s
 * `TOOL_ERROR_CLASSES` has no separate class for "never read" — see the handback for that call).
 *
 * ## Rename (spec §2 D-T1: "rename is a hunk kind, not a shell `mv`")
 *
 * A `Move to` on an `Update File` section is carried on its first hunk (`../file/patch-grammar.ts`)
 * and applied as: write the final content at the NEW path, then remove the old one. It is recorded
 * in the ledger and the checkpoint as two independent facts — "the old path stopped existing" and
 * "the new path now holds this content" — which is what lets `Checkpoint.restore` undo a rename
 * without knowing renames exist at all (see `./checkpoint.ts`'s header).
 */

import { readFile } from 'node:fs/promises'
import type { PolicySubject, Tool, ToolContext, ToolError } from '../contract.ts'
import { defineTool } from '../define.ts'
import { resolveToolPath } from '../paths.ts'
import type { Checkpoint } from './checkpoint.ts'
import {
  atomicWriteFile,
  checkNotStale,
  classifyFsError,
  joinFileLines,
  ledgerEntryOf,
  pathExists,
  removeFile,
  splitFileLines,
} from './fs-io.ts'
import type { ReadLedger } from './ledger.ts'
import { locateSnippet, type MatchTier } from './match.ts'
import { parsePatchText, type FileHunk, type FilePatch } from './patch-grammar.ts'

export type { FileHunk, FilePatch } from './patch-grammar.ts'

export interface FilePatchFileResult {
  path: string
  applied: boolean
  matchedTier?: MatchTier
  linesAdded: number
  linesRemoved: number
}

/** Matches spec §4's `FilePatchResult` shape at the top level (aggregated across every file of the
 *  call), plus `files` — the per-file breakdown a multi-file patch needs. */
export interface FilePatchToolResult {
  applied: boolean
  matchedTier?: MatchTier
  linesAdded: number
  linesRemoved: number
  files: FilePatchFileResult[]
}

function tierRank(t: MatchTier): number {
  return t === 'exact' ? 0 : t === 'trailing-ws' ? 1 : 2
}

function worseTier(a: MatchTier | undefined, b: MatchTier | undefined): MatchTier | undefined {
  if (!a) return b
  if (!b) return a
  return tierRank(b) > tierRank(a) ? b : a
}

interface AddPlan {
  kind: 'add'
  originalPath: string
  finalPath: string
  afterContent: string
  linesAdded: number
  linesRemoved: number
}
interface DeletePlan {
  kind: 'delete'
  originalPath: string
  finalPath: string
  beforeContent: string
  linesAdded: number
  linesRemoved: number
}
interface UpdatePlan {
  kind: 'update'
  originalPath: string
  finalPath: string
  beforeContent: string
  afterContent: string
  renamed: boolean
  matchedTier?: MatchTier
  linesAdded: number
  linesRemoved: number
}
type FilePlan = AddPlan | DeletePlan | UpdatePlan

function moveToOf(hunks: FileHunk[]): string | undefined {
  for (const h of hunks) if (h.kind === 'update' && h.moveTo) return h.moveTo
  return undefined
}

function countLines(text: string): number {
  return text === '' ? 0 : splitFileLines(text).lines.length
}

async function validateFile(
  file: FilePatch,
  cwd: string,
  ledger: ReadLedger
): Promise<{ ok: true; plan: FilePlan } | { ok: false; error: ToolError }> {
  const first = file.hunks[0]!
  const resolved = await resolveToolPath(cwd, file.path)

  if (first.kind === 'add') {
    if (await pathExists(resolved)) {
      return {
        ok: false,
        error: { class: 'invalid-input', detail: `Add File "${file.path}": a file already exists there — use an Update hunk instead.` },
      }
    }
    const body = first.body
    return {
      ok: true,
      plan: { kind: 'add', originalPath: resolved, finalPath: resolved, afterContent: body, linesAdded: countLines(body), linesRemoved: 0 },
    }
  }

  if (first.kind === 'delete') {
    if (!(await pathExists(resolved))) {
      return { ok: false, error: { class: 'not-found', detail: `Delete File "${file.path}": no such file.` } }
    }
    const stale = await checkNotStale(ledger, resolved)
    if (stale.stale) return { ok: false, error: { class: 'stale', detail: `Delete File "${file.path}": ${stale.reason}` } }
    const beforeContent = (await readFile(resolved)).toString('utf8')
    return {
      ok: true,
      plan: { kind: 'delete', originalPath: resolved, finalPath: resolved, beforeContent, linesAdded: 0, linesRemoved: countLines(beforeContent) },
    }
  }

  // update
  if (!(await pathExists(resolved))) {
    return { ok: false, error: { class: 'not-found', detail: `Update File "${file.path}": no such file.` } }
  }
  const stale = await checkNotStale(ledger, resolved)
  if (stale.stale) return { ok: false, error: { class: 'stale', detail: `Update File "${file.path}": ${stale.reason}` } }

  const beforeText = (await readFile(resolved)).toString('utf8')
  const split = splitFileLines(beforeText)
  let currentLines = split.lines
  let linesAdded = 0
  let linesRemoved = 0
  let matchedTier: MatchTier | undefined

  for (let hi = 0; hi < file.hunks.length; hi++) {
    const hunk = file.hunks[hi]!
    if (hunk.kind !== 'update') continue // never happens: all hunks of an update section are 'update'
    if (hunk.lines.length === 0) continue // pure rename marker — nothing to locate
    const before = hunk.lines.filter(l => l.op !== '+').map(l => l.text)
    const outcome = locateSnippet(currentLines, before)
    if (!outcome.ok) {
      if (outcome.reason === 'ambiguous') {
        return {
          ok: false,
          error: {
            class: 'ambiguous',
            detail: `Update File "${file.path}", hunk ${hi + 1}: its context matched ${outcome.count} places at the "${outcome.tier}" tier.`,
          },
        }
      }
      return {
        ok: false,
        error: {
          class: 'no-match',
          detail: `Update File "${file.path}", hunk ${hi + 1}: no tier matched its context (tried exact, trailing-ws, surrounding-ws).`,
        },
      }
    }
    // Rebuild the replacement from the MATCHED DISK TEXT for context lines (never the patch's own
    // spelling of them) — a looser tier means the disk's whitespace differs from the hunk's, and a
    // context line that was not meant to change must not be silently rewritten to the hunk's own
    // (possibly differently-whitespaced) copy of it. Only '+' lines contribute the patch's text.
    const matchedRegion = currentLines.slice(outcome.start, outcome.start + before.length)
    const after: string[] = []
    let bIdx = 0
    for (const hl of hunk.lines) {
      if (hl.op === ' ') {
        after.push(matchedRegion[bIdx]!)
        bIdx++
      } else if (hl.op === '-') {
        bIdx++
      } else {
        after.push(hl.text)
      }
    }
    currentLines = [...currentLines.slice(0, outcome.start), ...after, ...currentLines.slice(outcome.start + before.length)]
    linesAdded += hunk.lines.filter(l => l.op === '+').length
    linesRemoved += hunk.lines.filter(l => l.op === '-').length
    matchedTier = worseTier(matchedTier, outcome.tier)
  }

  const afterContent = joinFileLines({ lines: currentLines, trailingNewline: split.trailingNewline })
  const moveTo = moveToOf(file.hunks)
  let finalPath = resolved
  if (moveTo) {
    finalPath = await resolveToolPath(cwd, moveTo)
    if (finalPath !== resolved && (await pathExists(finalPath))) {
      return { ok: false, error: { class: 'invalid-input', detail: `Update File "${file.path}": Move to "${moveTo}" already exists.` } }
    }
  }

  return {
    ok: true,
    plan: {
      kind: 'update',
      originalPath: resolved,
      finalPath,
      beforeContent: beforeText,
      afterContent,
      renamed: finalPath !== resolved,
      matchedTier,
      linesAdded,
      linesRemoved,
    },
  }
}

async function writePlan(plan: FilePlan): Promise<void> {
  if (plan.kind === 'add') {
    await atomicWriteFile(plan.finalPath, plan.afterContent)
  } else if (plan.kind === 'delete') {
    await removeFile(plan.originalPath)
  } else {
    await atomicWriteFile(plan.finalPath, plan.afterContent)
    if (plan.renamed) await removeFile(plan.originalPath)
  }
}

async function rollbackPlan(plan: FilePlan): Promise<void> {
  if (plan.kind === 'add') {
    await removeFile(plan.finalPath).catch(() => {})
    return
  }
  if (plan.kind === 'delete') {
    await atomicWriteFile(plan.originalPath, plan.beforeContent).catch(() => {})
    return
  }
  if (plan.renamed) await removeFile(plan.finalPath).catch(() => {})
  await atomicWriteFile(plan.originalPath, plan.beforeContent).catch(() => {})
}

function summarize(plan: FilePlan): string {
  if (plan.kind === 'add') return `Added "${plan.finalPath}" (+${plan.linesAdded} lines).`
  if (plan.kind === 'delete') return `Deleted "${plan.originalPath}" (-${plan.linesRemoved} lines).`
  const tierNote = plan.matchedTier && plan.matchedTier !== 'exact' ? ` (matched via "${plan.matchedTier}")` : ''
  if (plan.renamed) {
    return `Renamed "${plan.originalPath}" to "${plan.finalPath}" (+${plan.linesAdded}/-${plan.linesRemoved} lines)${tierNote}.`
  }
  return `Updated "${plan.finalPath}" (+${plan.linesAdded}/-${plan.linesRemoved} lines)${tierNote}.`
}

function parseInput(raw: unknown): FilePatch[] | string {
  if (typeof raw !== 'object' || raw === null) return 'file.patch expects an object with a "patch" string.'
  const r = raw as Record<string, unknown>
  if (typeof r.patch !== 'string' || r.patch.length === 0) return 'file.patch requires a non-empty "patch" string.'
  const parsed = parsePatchText(r.patch)
  if (!Array.isArray(parsed)) return `Malformed patch at line ${parsed.line}: ${parsed.message}`
  return parsed
}

async function subjectsOf(input: FilePatch[], ctx: ToolContext): Promise<readonly PolicySubject[]> {
  const subjects: PolicySubject[] = []
  for (const file of input) {
    const first = file.hunks[0]!
    const resolved = await resolveToolPath(ctx.cwd, file.path)
    if (first.kind === 'add') {
      subjects.push({ action: 'write', path: resolved, op: 'create' })
      continue
    }
    if (first.kind === 'delete') {
      subjects.push({ action: 'read', path: resolved })
      subjects.push({ action: 'write', path: resolved, op: 'delete' })
      continue
    }
    subjects.push({ action: 'read', path: resolved })
    const moveTo = moveToOf(file.hunks)
    if (moveTo) {
      const dest = await resolveToolPath(ctx.cwd, moveTo)
      subjects.push({ action: 'write', path: resolved, op: 'rename-from' })
      subjects.push({ action: 'write', path: dest, op: 'rename-to' })
    } else {
      subjects.push({ action: 'write', path: resolved, op: 'update' })
    }
  }
  return subjects
}

export function createFilePatchTool(ledger: ReadLedger, checkpoint: Checkpoint): Tool<FilePatch[]> {
  return defineTool<FilePatch[]>({
    name: 'file.patch',
    description:
      'Apply a context-located patch (add/update/delete/rename files). Text grammar: *** Begin Patch / *** Add File|Delete File|Update File: <path> / *** Move to: <path> / @@ hunks of " "/"+"/"-" lines / *** End Patch.',
    kind: 'file',
    permission: 'ask',
    inputSchema: { type: 'object', properties: { patch: { type: 'string' } }, required: ['patch'] },
    parse: parseInput,
    subjects: subjectsOf,
    async run(input, ctx) {
      const plans: FilePlan[] = []
      for (const file of input) {
        const res = await validateFile(file, ctx.cwd, ledger)
        if (!res.ok) {
          return { ok: false, modelText: res.error.detail ?? 'The patch could not be applied.', error: res.error }
        }
        plans.push(res.plan)
      }

      const written: FilePlan[] = []
      for (const plan of plans) {
        try {
          await writePlan(plan)
          written.push(plan)
        } catch (e) {
          for (const w of [...written].reverse()) await rollbackPlan(w)
          const detail = `Writing "${plan.finalPath}" failed; ${written.length} earlier file(s) in this patch were rolled back. Nothing in this patch was left applied.`
          return { ok: false, modelText: detail, error: { class: classifyFsError(e), detail } }
        }
      }

      for (const plan of plans) {
        if (plan.kind === 'add') {
          ledger.record(plan.finalPath, await ledgerEntryOf(plan.finalPath))
          await checkpoint.record({ path: plan.finalPath, before: null, after: plan.afterContent, toolExecutionId: ctx.toolExecutionId }, ctx.now)
        } else if (plan.kind === 'delete') {
          ledger.forget(plan.originalPath)
          await checkpoint.record({ path: plan.originalPath, before: plan.beforeContent, after: null, toolExecutionId: ctx.toolExecutionId }, ctx.now)
        } else if (plan.renamed) {
          ledger.forget(plan.originalPath)
          ledger.record(plan.finalPath, await ledgerEntryOf(plan.finalPath))
          await checkpoint.record({ path: plan.originalPath, before: plan.beforeContent, after: null, toolExecutionId: ctx.toolExecutionId }, ctx.now)
          await checkpoint.record({ path: plan.finalPath, before: null, after: plan.afterContent, toolExecutionId: ctx.toolExecutionId }, ctx.now)
        } else {
          ledger.record(plan.finalPath, await ledgerEntryOf(plan.finalPath))
          await checkpoint.record(
            { path: plan.finalPath, before: plan.beforeContent, after: plan.afterContent, toolExecutionId: ctx.toolExecutionId },
            ctx.now
          )
        }
      }

      const files: FilePatchFileResult[] = plans.map(p => ({
        path: p.kind === 'delete' ? p.originalPath : p.finalPath,
        applied: true,
        matchedTier: p.kind === 'update' ? p.matchedTier : undefined,
        linesAdded: p.linesAdded,
        linesRemoved: p.linesRemoved,
      }))
      const linesAdded = plans.reduce((s, p) => s + p.linesAdded, 0)
      const linesRemoved = plans.reduce((s, p) => s + p.linesRemoved, 0)
      const matchedTier = plans.reduce<MatchTier | undefined>(
        (acc, p) => (p.kind === 'update' ? worseTier(acc, p.matchedTier) : acc),
        undefined
      )
      const result: FilePatchToolResult = { applied: true, matchedTier, linesAdded, linesRemoved, files }

      return {
        ok: true,
        modelText: plans.map(summarize).join('\n'),
        facts: { filesTouched: files.map(f => f.path), linesAdded, linesRemoved },
        result,
      }
    },
  })
}
