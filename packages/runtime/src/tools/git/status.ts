/**
 * tools/git/status.ts — `git.status`: the working tree status of a repository, as a readable
 * summary plus a structured `GitStatusResult` (spec §3 row `git.status / git.diff / git.log`).
 *
 * Parses `git status --porcelain=v2 --branch` — the machine-readable format git documents as
 * stable across versions (unlike the short/long human formats). Reference (git-status(1)):
 *
 *   # branch.oid <commit> | (initial)
 *   # branch.head <branch> | (detached)
 *   # branch.upstream <upstream>              (only when one is configured)
 *   # branch.ab +<ahead> -<behind>            (only alongside branch.upstream)
 *   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>                       (ordinary changed entry)
 *   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath> (renamed/copied)
 *   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>            (unmerged)
 *   ? <path>                                                           (untracked)
 *   ! <path>                                                           (ignored — never emitted
 *                                                                       here; `--ignored` is not
 *                                                                       passed)
 *
 * `<XY>` are two status letters: X is the entry's state in the INDEX relative to HEAD (a `.` means
 * unchanged there — "staged" is X != '.'), Y is its state in the WORKTREE relative to the index
 * ("unstaged" is Y != '.'). The first 8 (ordinary) / 9 (unmerged) fields never contain a space, so
 * everything after the 8th/9th space on the line is the path VERBATIM — including one that itself
 * contains a space, which is why the parser below never does a blind `split(' ')` for the path.
 */

import type { PolicySubject, Tool, ToolContext, ToolFacts, ToolOutcome } from '../contract.ts'
import { defineTool } from '../define.ts'
import { resolveToolPath } from '../paths.ts'
import { buildGitEnv } from './env.ts'
import { runGit } from './run-git.ts'
import { GIT_SAFE_ARGS, defaultGitSpawner, type GitToolsRuntimeOptions } from './spawn.ts'

export interface GitStatusInput {
  repo?: string
}

export interface GitStatusBucket {
  count: number
  /** Bounded to `MAX_STATUS_PATHS`; see `pathsTruncated` for whether more exist. */
  paths: string[]
}

export interface GitStatusResult {
  branch: string | null
  detached: boolean
  upstream: string | null
  ahead: number | null
  behind: number | null
  staged: GitStatusBucket
  unstaged: GitStatusBucket
  untracked: GitStatusBucket
  /** True when any bucket above holds more paths than were listed. */
  pathsTruncated: boolean
}

export function parseGitStatusInput(input: unknown): GitStatusInput | string {
  if (input === undefined || input === null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) return 'Input must be an object with an optional "repo" string field.'
  const obj = input as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (key !== 'repo') return `Unknown field "${key}".`
  }
  if (obj.repo !== undefined && typeof obj.repo !== 'string') return '"repo" must be a string.'
  return { repo: obj.repo as string | undefined }
}

const MAX_STATUS_PATHS = 200

function emptyBucket(): GitStatusBucket {
  return { count: 0, paths: [] }
}

/** PURE. Parses `git status --porcelain=v2 --branch --untracked-files=all` output. */
export function parseStatusPorcelainV2(output: string, maxPaths = MAX_STATUS_PATHS): GitStatusResult {
  const result: GitStatusResult = {
    branch: null,
    detached: false,
    upstream: null,
    ahead: null,
    behind: null,
    staged: emptyBucket(),
    unstaged: emptyBucket(),
    untracked: emptyBucket(),
    pathsTruncated: false,
  }

  const record = (bucket: GitStatusBucket, path: string): void => {
    bucket.count += 1
    if (bucket.paths.length < maxPaths) bucket.paths.push(path)
    else result.pathsTruncated = true
  }

  /** X != '.' is staged (index differs from HEAD); Y != '.' is unstaged (worktree differs from index). */
  const applyEntry = (xyRaw: string | undefined, pathRaw: string | undefined): void => {
    const xy = xyRaw ?? '..'
    const path = pathRaw ?? ''
    const x = xy[0] ?? '.'
    const y = xy[1] ?? '.'
    if (x !== '.') record(result.staged, path)
    if (y !== '.') record(result.unstaged, path)
  }

  for (const line of output.split('\n')) {
    if (line.length === 0) continue
    if (line.startsWith('# ')) {
      const rest = line.slice(2)
      if (rest.startsWith('branch.head ')) {
        const name = rest.slice('branch.head '.length)
        if (name === '(detached)') result.detached = true
        else result.branch = name
      } else if (rest.startsWith('branch.upstream ')) {
        result.upstream = rest.slice('branch.upstream '.length)
      } else if (rest.startsWith('branch.ab ')) {
        const m = /^\+(\d+) -(\d+)$/.exec(rest.slice('branch.ab '.length))
        if (m && m[1] !== undefined && m[2] !== undefined) {
          result.ahead = Number(m[1])
          result.behind = Number(m[2])
        }
      }
      continue
    }
    if (line.startsWith('? ')) {
      record(result.untracked, line.slice(2))
      continue
    }
    if (line.startsWith('! ')) continue // ignored; never requested, kept for forward compatibility
    // '1' (ordinary) has exactly 6 fixed fields between XY and the path; '2' (renamed/copied) has
    // one MORE (the "X<score>" field) before the path. Kept as two fixed-count patterns rather than
    // one with an optional group — an optional `(?:\S+ )?` ahead of a greedy `(.+)$` can itself
    // "eat" the first word of a path that contains a space (core.quotePath does not escape a plain
    // ASCII space), silently truncating it. A fixed count never has that ambiguity to backtrack into.
    if (line.startsWith('1 ')) {
      const m = /^1 (\S+)(?: \S+){6} (.+)$/.exec(line)
      if (!m) continue
      applyEntry(m[1], m[2])
      continue
    }
    if (line.startsWith('2 ')) {
      const m = /^2 (\S+)(?: \S+){7} (.+)$/.exec(line)
      if (!m) continue
      // group 2 is "<newPath>\t<origPath>" (TAB-separated) in this non-`-z` porcelain v2 output;
      // only the current path is reported here — the rename's own metadata is not part of this summary.
      applyEntry(m[1], m[2]?.split('\t')[0])
      continue
    }
    if (line.startsWith('u ')) {
      const m = /^u (?:\S+ ){9}(.+)$/.exec(line)
      const path = m?.[1]
      if (path !== undefined) {
        record(result.staged, path)
        record(result.unstaged, path)
      }
      continue
    }
  }

  return result
}

function summarize(r: GitStatusResult): string {
  const lines: string[] = []
  lines.push(r.detached ? 'HEAD is detached.' : `On branch ${r.branch ?? '(unknown)'}.`)
  if (r.upstream) {
    const ahead = r.ahead ?? 0
    const behind = r.behind ?? 0
    lines.push(`Tracking ${r.upstream}: ${ahead} ahead, ${behind} behind.`)
  }
  lines.push(`Staged: ${r.staged.count} file(s). Unstaged: ${r.unstaged.count} file(s). Untracked: ${r.untracked.count} file(s).`)
  const listBucket = (label: string, b: GitStatusBucket): void => {
    if (b.count === 0) return
    lines.push(`${label}:`)
    for (const p of b.paths) lines.push(`  ${p}`)
    if (b.count > b.paths.length) lines.push(`  … and ${b.count - b.paths.length} more`)
  }
  listBucket('Staged files', r.staged)
  listBucket('Unstaged files', r.unstaged)
  listBucket('Untracked files', r.untracked)
  return lines.join('\n')
}

export function createGitStatusTool(opts: GitToolsRuntimeOptions = {}): Tool<GitStatusInput> {
  const spawner = opts.spawn ?? defaultGitSpawner
  return defineTool<GitStatusInput>({
    name: 'git.status',
    description:
      'Show the working tree status of a git repository: current branch, ahead/behind counts, and staged/unstaged/untracked files. Read-only.',
    kind: 'other',
    permission: 'auto',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository directory. Defaults to the run\'s current directory.' },
      },
      additionalProperties: false,
    },
    parse: parseGitStatusInput,
    subjects: async (input, ctx): Promise<readonly PolicySubject[]> => {
      const repo = await resolveToolPath(ctx.cwd, input.repo ?? '.')
      return [{ action: 'git-read', repo, verb: 'status' }]
    },
    run: async (input, ctx: ToolContext): Promise<ToolOutcome> => {
      const repo = await resolveToolPath(ctx.cwd, input.repo ?? '.')
      const argv = ['git', ...GIT_SAFE_ARGS, 'status', '--porcelain=v2', '--branch', '--untracked-files=all']
      const call = await runGit(spawner, argv, { cwd: repo, env: buildGitEnv(opts.env), signal: ctx.signal })
      if (!call.ok) return { ok: false, modelText: call.error.detail ?? 'git status failed.', error: call.error }
      const status = parseStatusPorcelainV2(call.stdout)
      const facts: ToolFacts = {
        filesTouched: [...status.staged.paths, ...status.unstaged.paths, ...status.untracked.paths],
        exitCode: call.exitCode,
      }
      return { ok: true, modelText: summarize(status), facts, result: status }
    },
  })
}
