/**
 * tools/git/log.ts — `git.log`: recent commits as a readable summary plus a structured
 * `GitLogResult` (spec §3, "`maxCount` default 20, hard cap 200"; bodies omitted).
 *
 * `--pretty=tformat:%H%x1f%an <%ae>%x1f%aI%x1f%s` — `tformat:`, never `format:`. `format:` omits
 * the terminating newline on the LAST record, which silently drops the oldest commit of every
 * range for any reader that splits on `\n` — the exact defect
 * `docs/superpowers/specs/…/releaseWorkflow.lint.test.ts` exists to catch in the release workflow,
 * here avoided at the source instead of caught downstream. Fields are separated by `%x1f` (ASCII
 * Unit Separator, 0x1F) rather than the NUL `%x00` `getCommitsInWindow` (`server/git.ts`) uses —
 * NUL is fine INSIDE git's own output but not as a substring of an ARGV element handed to
 * `Bun.spawn`/`execve`, which (like Node's `child_process`) refuses an argument containing an
 * embedded NUL byte outright; 0x1F needs no such care and a commit subject containing a raw control
 * character is not a distinction worth losing this over. `%s` (subject) is used rather than `%B`
 * (raw body) precisely because bodies are catalogued as omitted — a subject is git's own definition
 * of "the first line", so nothing here has to re-truncate one.
 */

import type { PolicySubject, Tool, ToolContext, ToolFacts, ToolOutcome } from '../contract.ts'
import { defineTool } from '../define.ts'
import { resolveToolPath } from '../paths.ts'
import { buildGitEnv } from './env.ts'
import { boundText } from './output.ts'
import { isSafeRev } from './rev.ts'
import { runGit } from './run-git.ts'
import { GIT_SAFE_ARGS, defaultGitSpawner, type GitToolsRuntimeOptions } from './spawn.ts'

export const GIT_LOG_DEFAULT_MAX_COUNT = 20
export const GIT_LOG_HARD_CAP = 200

export interface GitLogInput {
  repo?: string
  maxCount?: number
  rev?: string
  paths?: string[]
}

export interface GitLogCommit {
  hash: string
  author: string
  date: string
  subject: string
}

export interface GitLogResult {
  commits: GitLogCommit[]
  /** True when the count returned reached the (possibly clamped) `maxCount` — there may be more. */
  truncated: boolean
  /** The `maxCount` actually used, after clamping to `GIT_LOG_HARD_CAP`. */
  effectiveMaxCount: number
}

export function parseGitLogInput(input: unknown): GitLogInput | string {
  if (input === undefined || input === null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) return 'Input must be an object.'
  const obj = input as Record<string, unknown>
  const allowed = new Set(['repo', 'maxCount', 'rev', 'paths'])
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return `Unknown field "${key}".`
  }
  if (obj.repo !== undefined && typeof obj.repo !== 'string') return '"repo" must be a string.'
  let maxCount: number | undefined
  if (obj.maxCount !== undefined) {
    if (typeof obj.maxCount !== 'number' || !Number.isInteger(obj.maxCount) || obj.maxCount < 1) {
      return '"maxCount" must be a positive integer.'
    }
    maxCount = obj.maxCount
  }
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
  return { repo: obj.repo as string | undefined, maxCount, rev, paths }
}

const FIELD_SEP = '\u001f'
const LOG_FORMAT = `%H${FIELD_SEP}%an <%ae>${FIELD_SEP}%aI${FIELD_SEP}%s`
const MAX_LOG_BYTES = 200_000

function buildLogArgv(input: GitLogInput, effectiveMaxCount: number): string[] {
  const argv = [
    'git', ...GIT_SAFE_ARGS, 'log',
    `--max-count=${effectiveMaxCount}`,
    `--pretty=tformat:${LOG_FORMAT}`,
    '--no-color',
    '--end-of-options',
  ]
  if (input.rev !== undefined) argv.push(input.rev)
  if (input.paths !== undefined && input.paths.length > 0) {
    argv.push('--', ...input.paths)
  }
  return argv
}

/** PURE. Parses `--pretty=tformat:%H%x1f%an <%ae>%x1f%aI%x1f%s` output, one commit per line. */
export function parseLogOutput(text: string): GitLogCommit[] {
  const commits: GitLogCommit[] = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    const [hash, author, date, ...rest] = line.split(FIELD_SEP)
    if (hash === undefined || hash.length === 0) continue
    commits.push({ hash, author: author ?? '', date: date ?? '', subject: rest.join(FIELD_SEP) })
  }
  return commits
}

function summarize(result: GitLogResult): string {
  if (result.commits.length === 0) return 'No commits.'
  const lines = result.commits.map(c => `${c.hash.slice(0, 12)}  ${c.date}  ${c.author}  ${c.subject}`)
  if (result.truncated) lines.push(`[showing the ${result.commits.length} most recent — there may be more]`)
  return lines.join('\n')
}

export function createGitLogTool(opts: GitToolsRuntimeOptions = {}): Tool<GitLogInput> {
  const spawner = opts.spawn ?? defaultGitSpawner
  return defineTool<GitLogInput>({
    name: 'git.log',
    description: 'List recent commits: hash, author, ISO date, and subject line. Bodies are omitted. Read-only.',
    kind: 'other',
    permission: 'auto',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository directory. Defaults to the run\'s current directory.' },
        maxCount: { type: 'integer', minimum: 1, description: `Default ${GIT_LOG_DEFAULT_MAX_COUNT}, hard cap ${GIT_LOG_HARD_CAP}.` },
        rev: { type: 'string', description: 'Start the walk at this revision instead of HEAD.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Limit the log to commits touching these paths.' },
      },
      additionalProperties: false,
    },
    parse: parseGitLogInput,
    subjects: async (input, ctx): Promise<readonly PolicySubject[]> => {
      const repo = await resolveToolPath(ctx.cwd, input.repo ?? '.')
      return [{ action: 'git-read', repo, verb: 'log' }]
    },
    run: async (input, ctx: ToolContext): Promise<ToolOutcome> => {
      const repo = await resolveToolPath(ctx.cwd, input.repo ?? '.')
      const effectiveMaxCount = Math.min(input.maxCount ?? GIT_LOG_DEFAULT_MAX_COUNT, GIT_LOG_HARD_CAP)
      const argv = buildLogArgv(input, effectiveMaxCount)
      const call = await runGit(spawner, argv, { cwd: repo, env: buildGitEnv(opts.env), signal: ctx.signal })
      if (!call.ok) return { ok: false, modelText: call.error.detail ?? 'git log failed.', error: call.error }

      const bounded = boundText(call.stdout, MAX_LOG_BYTES)
      // A byte-bounded cut can land mid-record; a partial trailing line would parse as a commit
      // with a missing subject (or worse, none at all), so it is dropped rather than kept half-read.
      let text = bounded.text
      if (bounded.truncated) {
        const lastNewline = bounded.text.lastIndexOf('\n')
        text = lastNewline === -1 ? '' : bounded.text.slice(0, lastNewline)
      }
      const commits = parseLogOutput(text)

      const result: GitLogResult = {
        commits,
        truncated: bounded.truncated || commits.length >= effectiveMaxCount,
        effectiveMaxCount,
      }
      const facts: ToolFacts = { exitCode: call.exitCode }
      return { ok: true, modelText: summarize(result), facts, result }
    },
  })
}
