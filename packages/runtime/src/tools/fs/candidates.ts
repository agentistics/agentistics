/**
 * tools/fs/candidates.ts — the ONE list of files `fs.glob` and `fs.grep` both search
 * (spec docs/superpowers/specs/2026-09-20-runtime-b3-tool-catalogue.md §3).
 *
 * Inside a git working tree, git already knows the ignore rules — asking it (`ls-files --cached
 * --others --exclude-standard`) is exact and re-implementing `.gitignore` semantics by hand would
 * only drift from it. Outside one (or with no `git` on PATH), a plain recursive walk stands in and
 * says so (`gitignoreAware: false`) rather than silently pretending to be one.
 *
 * ## The one guarantee both sources are held to
 *
 * "The tool must never return a file outside `root`" cannot be trusted to either source alone: a
 * git-tracked SYMLINK is exactly as capable of pointing outside `root` as one the walker finds
 * itself, and `git ls-files` run from a subdirectory is trusted here to scope its own output (see
 * below) but not blindly trusted never to hand back something odd. So every candidate — from
 * either source — is re-resolved through `resolveToolPath` and re-checked with `isInside` in THIS
 * function, once, rather than in each caller.
 */
import { toolEnv, type ToolEnv } from '../env.ts'
import type { Dirent } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isInside, resolveToolPath } from '../paths.ts'

const SKIP_DIR_NAMES = new Set(['.git', 'node_modules'])
/** Defensive only: no real workspace should ever hit this. Stops a pathological tree (a symlink
 *  cycle that slipped past the cycle guard, or simply an enormous directory) from turning a search
 *  into a hang. */
const WALK_HARD_CAP = 50_000

function spawnGit(args: string[], cwd: string, env: ToolEnv | undefined) {
  return Bun.spawn(['git', '-c', 'core.fsmonitor=false', ...args], {
    cwd,
    env: { ...toolEnv(env), GIT_TERMINAL_PROMPT: '0' },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })
}

/**
 * Tracked + untracked-but-not-gitignored files under `root`, relative to it — or `null` when
 * `root` is not inside a git working tree, or `git` is not on PATH at all. The two commands run
 * WITH `cwd: root` on purpose: git scopes `ls-files`'s output to the cwd's own subtree and reports
 * paths relative to it, which is exactly the restriction and the shape this needs (verified
 * locally against a real repo: `git -C sub ls-files` from a subdirectory returns only that
 * subdirectory's files, relative to it — never the whole repository).
 */
async function listGitFiles(root: string, env: ToolEnv | undefined): Promise<string[] | null> {
  try {
    const check = spawnGit(['rev-parse', '--is-inside-work-tree'], root, env)
    const [code, out] = await Promise.all([check.exited, new Response(check.stdout).text()])
    if (code !== 0 || out.trim() !== 'true') return null
  } catch {
    return null // git not installed, or `root` does not exist
  }
  try {
    const ls = spawnGit(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], root, env)
    const [code, out] = await Promise.all([ls.exited, new Response(ls.stdout).text()])
    if (code !== 0) return null
    return out.split('\0').filter(s => s.length > 0)
  } catch {
    return null
  }
}

/**
 * A plain recursive walk for when there is no git to ask. NOT gitignore-aware (callers must say
 * so) — it only skips `.git` and `node_modules` by name, nothing from a `.gitignore` file. A
 * symlinked directory is followed only when its real target resolves INSIDE `root` (and only once
 * per real path — a cycle guard); a symlink whose target — file or directory — resolves outside
 * `root` is excluded outright rather than walked into or returned. That is the one rule this
 * function exists to get right on its own; `listCandidates` re-checks it anyway (see the module
 * header), so this is belt, not the only strap.
 */
async function walkTree(root: string): Promise<string[]> {
  const results: string[] = []
  const visitedRealDirs = new Set<string>()

  async function visit(dirAbs: string, relPrefix: string): Promise<void> {
    if (results.length >= WALK_HARD_CAP) return
    let entries: Dirent[]
    try {
      entries = await readdir(dirAbs, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (results.length >= WALK_HARD_CAP) return
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name

      if (entry.isSymbolicLink()) {
        const abs = join(dirAbs, entry.name)
        let real: string
        try {
          real = await realpath(abs)
        } catch {
          continue // dangling symlink
        }
        let targetStat
        try {
          targetStat = await stat(real)
        } catch {
          continue
        }
        if (targetStat.isDirectory()) {
          if (SKIP_DIR_NAMES.has(entry.name)) continue
          if (!isInside(root, real) || visitedRealDirs.has(real)) continue
          visitedRealDirs.add(real)
          await visit(real, rel)
        } else if (targetStat.isFile() && isInside(root, real)) {
          results.push(rel)
        }
        continue
      }

      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue
        await visit(join(dirAbs, entry.name), rel)
      } else if (entry.isFile()) {
        results.push(rel)
      }
    }
  }

  await visit(root, '')
  return results
}

export interface CandidateList {
  root: string
  /** Relative to `root`. Sorted lexicographically by path — deterministic, and the same order
   *  `glob.ts`/`grep.ts` present results in (a mtime-based order was considered and rejected: it
   *  is not stable across two calls on an unchanged tree, which a re-run of the same search should
   *  be). */
  files: string[]
  gitignoreAware: boolean
}

/** The one list both tools search. See the module header for why every candidate, from either
 *  source, is re-resolved and re-checked against `root` here rather than trusted from its source. */
export async function listCandidates(root: string, env?: ToolEnv): Promise<CandidateList> {
  const gitFiles = await listGitFiles(root, env)
  const raw = gitFiles ?? (await walkTree(root))
  const gitignoreAware = gitFiles !== null
  const files: string[] = []
  for (const rel of raw) {
    const abs = await resolveToolPath(root, rel)
    if (isInside(root, abs)) files.push(rel)
  }
  files.sort()
  return { root, files, gitignoreAware }
}
