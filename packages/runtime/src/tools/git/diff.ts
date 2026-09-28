/**
 * tools/git/diff.ts — `git.diff`: a diff (working tree vs index, or index vs `rev`, or working
 * tree vs `rev` when `staged` is not set) as a readable summary plus a structured `GitDiffResult`
 * (spec §3, §4's bounded-output rule: "the model knows what it did not see").
 *
 * TWO calls, not one `--patch-with-stat`: `git diff --stat` (small, essentially never truncated)
 * for the summary, and a separate `git diff` (the patch body, which CAN be large) for the content.
 * That is what lets "the `--stat` summary always included" hold even when the patch itself had to
 * be cut — a single combined call would tie the summary's fate to the same truncation boundary as
 * the body it is meant to describe.
 */

import type { PolicySubject, Tool, ToolContext, ToolFacts, ToolOutcome } from '../contract.ts'
import { defineTool } from '../define.ts'
import { resolveToolPath } from '../paths.ts'
import { buildGitEnv } from './env.ts'
import { boundText } from './output.ts'
import { isSafeRev } from './rev.ts'
import { runGit } from './run-git.ts'
import { GIT_DIFF_SAFE_ARGS, GIT_SAFE_ARGS, defaultGitSpawner, type GitToolsRuntimeOptions } from './spawn.ts'

export interface GitDiffInput {
  repo?: string
  staged?: boolean
  rev?: string
  paths?: string[]
}

export interface GitDiffResult {
  stat: string
  statTruncated: boolean
  diff: string
  diffTruncated: boolean
  /** The FULL patch's byte size, even when `diff` above was cut. */
  diffOriginalBytes: number
  filesChanged: number
  linesAdded: number
  linesRemoved: number
  files: string[]
}

export function parseGitDiffInput(input: unknown): GitDiffInput | string {
  if (input === undefined || input === null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) return 'Input must be an object.'
  const obj = input as Record<string, unknown>
  const allowed = new Set(['repo', 'staged', 'rev', 'paths'])
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return `Unknown field "${key}".`
  }
  if (obj.repo !== undefined && typeof obj.repo !== 'string') return '"repo" must be a string.'
  if (obj.staged !== undefined && typeof obj.staged !== 'boolean') return '"staged" must be a boolean.'
  let rev: string | undefined
  if (obj.rev !== undefined) {
    if (typeof obj.rev !== 'string') return '"rev" must be a string.'
    if (!isSafeRev(obj.rev)) return `"rev" is not a valid revision reference: ${JSON.stringify(obj.rev)}`
    rev = obj.rev
  }
  let paths: string[] | undefined
  if (obj.paths !== undefined) {
    if (!Array.isArray(obj.paths) || !obj.paths.every(p => typeof p === 'string' && p.length > 0)) {
      return '"paths" must be an array of non-empty strings.'
    }
    paths = obj.paths as string[]
  }
  return { repo: obj.repo as string | undefined, staged: obj.staged as boolean | undefined, rev, paths }
}

const MAX_DIFF_BYTES = 100_000
const MAX_STAT_BYTES = 20_000
const MAX_FILE_NAMES = 200

/**
 * Fixed argv shared by the `--stat` call and the patch call, ending right before `--` (paths).
 * `--end-of-options` sits right before `rev` — this is `rev.ts`'s SECOND line of defense: even a
 * `rev` that reached here without going through `parse()`'s `isSafeRev` check is read as a plain
 * revision argument, never as an option, because everything up to `--` (or the command's own end)
 * is frozen as non-option the moment `--end-of-options` has been seen.
 */
function buildDiffArgv(input: GitDiffInput, mode: 'stat' | 'patch'): string[] {
  const argv = ['git', ...GIT_SAFE_ARGS, 'diff', ...GIT_DIFF_SAFE_ARGS]
  if (mode === 'stat') argv.push('--stat')
  if (input.staged) argv.push('--cached')
  argv.push('--end-of-options')
  if (input.rev !== undefined) argv.push(input.rev)
  if (input.paths !== undefined && input.paths.length > 0) {
    argv.push('--', ...input.paths)
  }
  return argv
}

const STAT_SUMMARY_PATTERN =
  /^\s*(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?\s*$/
const STAT_FILE_LINE_PATTERN = /^\s*(.+?)\s+\|\s+(?:\d+|Bin)/

export interface DiffStatSummary {
  files: string[]
  filesChanged: number
  linesAdded: number
  linesRemoved: number
}

/** PURE. Reads the trailing summary line and the per-file lines of a `git diff --stat` block. */
export function parseDiffStat(statText: string): DiffStatSummary {
  const files: string[] = []
  let filesChanged = 0
  let linesAdded = 0
  let linesRemoved = 0
  for (const rawLine of statText.split('\n')) {
    if (rawLine.trim().length === 0) continue
    const summary = STAT_SUMMARY_PATTERN.exec(rawLine)
    if (summary) {
      filesChanged = Number(summary[1] ?? '0')
      linesAdded = Number(summary[2] ?? '0')
      linesRemoved = Number(summary[3] ?? '0')
      continue
    }
    const fileLine = STAT_FILE_LINE_PATTERN.exec(rawLine)
    if (fileLine?.[1] !== undefined) files.push(fileLine[1].trim())
  }
  return { files, filesChanged, linesAdded, linesRemoved }
}

function summarize(stat: DiffStatSummary, result: GitDiffResult): string {
  const lines: string[] = []
  if (stat.filesChanged === 0) {
    lines.push('No differences.')
    return lines.join('\n')
  }
  lines.push(`${stat.filesChanged} file(s) changed, +${stat.linesAdded} / -${stat.linesRemoved}.`)
  lines.push('')
  lines.push(result.stat.trimEnd())
  if (result.statTruncated) lines.push('[stat output truncated]')
  lines.push('')
  lines.push(result.diff.trimEnd().length > 0 ? result.diff.trimEnd() : '(no patch content)')
  if (result.diffTruncated) {
    lines.push(`[diff truncated: showed ${MAX_DIFF_BYTES} of ${result.diffOriginalBytes} bytes]`)
  }
  return lines.join('\n')
}

export function createGitDiffTool(opts: GitToolsRuntimeOptions = {}): Tool<GitDiffInput> {
  const spawner = opts.spawn ?? defaultGitSpawner
  return defineTool<GitDiffInput>({
    name: 'git.diff',
    description:
      'Show a diff: unstaged changes by default, staged changes with staged:true, or against a specific revision with rev. Read-only.',
    kind: 'other',
    permission: 'auto',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository directory. Defaults to the run\'s current directory.' },
        staged: { type: 'boolean', description: 'Diff the index against HEAD instead of the working tree against the index.' },
        rev: { type: 'string', description: 'A revision to diff against instead of the default base.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Limit the diff to these paths.' },
      },
      additionalProperties: false,
    },
    parse: parseGitDiffInput,
    subjects: async (input, ctx): Promise<readonly PolicySubject[]> => {
      const repo = await resolveToolPath(ctx.cwd, input.repo ?? '.')
      return [{ action: 'git-read', repo, verb: 'diff' }]
    },
    run: async (input, ctx: ToolContext): Promise<ToolOutcome> => {
      const repo = await resolveToolPath(ctx.cwd, input.repo ?? '.')
      const env = buildGitEnv(opts.env)

      const statArgv = buildDiffArgv(input, 'stat')
      const statCall = await runGit(spawner, statArgv, { cwd: repo, env, signal: ctx.signal })
      if (!statCall.ok) return { ok: false, modelText: statCall.error.detail ?? 'git diff failed.', error: statCall.error }

      const patchArgv = buildDiffArgv(input, 'patch')
      const patchCall = await runGit(spawner, patchArgv, { cwd: repo, env, signal: ctx.signal })
      if (!patchCall.ok) return { ok: false, modelText: patchCall.error.detail ?? 'git diff failed.', error: patchCall.error }

      const boundedStat = boundText(statCall.stdout, MAX_STAT_BYTES)
      const boundedDiff = boundText(patchCall.stdout, MAX_DIFF_BYTES)
      const stat = parseDiffStat(statCall.stdout)

      const result: GitDiffResult = {
        stat: boundedStat.text,
        statTruncated: boundedStat.truncated,
        diff: boundedDiff.text,
        diffTruncated: boundedDiff.truncated,
        diffOriginalBytes: boundedDiff.originalBytes,
        filesChanged: stat.filesChanged,
        linesAdded: stat.linesAdded,
        linesRemoved: stat.linesRemoved,
        files: stat.files.slice(0, MAX_FILE_NAMES),
      }

      const facts: ToolFacts = {
        filesTouched: result.files,
        linesAdded: result.linesAdded,
        linesRemoved: result.linesRemoved,
        exitCode: patchCall.exitCode,
      }

      return { ok: true, modelText: summarize(stat, result), facts, result }
    },
  })
}
