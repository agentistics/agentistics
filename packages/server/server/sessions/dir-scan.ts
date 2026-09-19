/**
 * dir-scan.ts — the directories on this machine a session could be started in.
 *
 * The wizard used to offer only places that already had history, which made it useless for the most
 * ordinary case there is: a repository cloned five minutes ago. **Any directory should be startable**,
 * so this walks the home directory and indexes what it finds.
 *
 * Measured before choosing the strategy rather than guessed: a depth-4 walk of a real home directory
 * with the prune list below visits ~4,900 directories in ~220ms. That is cheap enough to do once and
 * cache, which is what makes the search instant on every keystroke afterwards.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Directories never worth descending into.
 *
 * Note what is NOT here: hidden directories in general. `.claude/worktrees/<name>` is where this
 * project's own concurrent work lives, and skipping dotted directories wholesale would hide exactly
 * the places a user of this tool works in most.
 */
const PRUNE = new Set([
  'node_modules', '.git', '.cache', '.npm', '.bun', '.cargo', '.rustup', '.nvm', '.pnpm-store',
  '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  'target', 'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.svelte-kit', '.gradle',
  'vendor', 'Library', 'snap', '.local', '.rbenv', '.pyenv', '.docker', '.vscode-server',
  '.Trash', '.trash', 'AppData',
])

export const SCAN_DEPTH = Number(process.env.AGENTISTICS_SCAN_DEPTH) > 0
  ? Number(process.env.AGENTISTICS_SCAN_DEPTH)
  : 4

/** A hard backstop, so a pathological home directory cannot hang the wizard. */
const MAX_ENTRIES = 40_000

export interface ScannedDir {
  path: string
  /** The last segment — what the row is named and what the search ranks against. */
  name: string
  /**
   * True when the directory is a repository's MAIN checkout — a `.git` DIRECTORY, or a `.git`
   * FILE whose content does not say WORKTREE (a submodule marker, or anything unreadable /
   * unrecognised). That second half restores exactly what this walk did before the worktree
   * distinction existed: any `.git` entry at all read as `repo: true`, and a `.git` file that
   * turns out not to be a genuine worktree marker is still that same repository it always was,
   * never demoted to a plain folder.
   */
  repo: boolean
  /**
   * True ONLY when the directory's own `.git` is a FILE whose content names a LINKED worktree —
   * `gitdir: <main-checkout>/.git/worktrees/<name>` — checked by READING it, never guessed from
   * the entry being a file at all. A git SUBMODULE'S `.git` is a file too
   * (`gitdir: <relative-path>/.git/modules/<name>`), and treating "is a file" as proof of
   * "is a worktree" misclassified a submodule — a genuinely separate repository pinned at a
   * commit — as "a second place to work in the same repository", which is simply false for it.
   * The kind is decided by what the file SAYS, never by its entry type alone.
   *
   * See `classifyGitFile`'s own note on why a dedicated `'submodule'` kind is not added here.
   */
  worktree: boolean
}

/**
 * What a `.git` FILE's own content says — PURE, so the pattern is testable with a content string
 * and no filesystem at all.
 *
 * Both a linked worktree and a submodule point `.git` at another directory via one line,
 * `gitdir: <path>`, and only the PATH tells them apart — measured against real git 2.53 output:
 * a worktree's line reads `gitdir: /main/checkout/.git/worktrees/<name>` (this repository's own
 * `.git/worktrees/`); a submodule's reads `gitdir: ../.git/modules/<name>` (relative, `.git/modules/`).
 * Content that names neither — garbage, a future git format this was never checked against, or a
 * file that could not be read at all — is `'other'`: the ABSENCE of the worktree marker, never its
 * presence assumed by default. `'other'` reads as a plain repository (see `ScannedDir.repo`), which
 * is what a `.git` file — worktree or not — has always meant here.
 *
 * A submodule is arguably owed its OWN kind rather than folding into `'repo'` — it is a real,
 * independently-committed repository, not merely "this directory happens to have a `.git`". That is
 * deliberately NOT done here: this fix's job is telling a worktree from everything else, a fourth
 * `ProjectKind` is a larger, separately-reasoned change (its own tab, its own hint sentence, its own
 * icon), and folding a submodule into `'repo'` is strictly more correct than the worktree
 * misclassification it replaces, never a regression from where this machine's wizard already was.
 */
export function classifyGitFile(content: string): 'worktree' | 'other' {
  const line = /^gitdir:\s*(.+?)\s*$/m.exec(content)
  if (!line) return 'other'
  return /\/\.git\/worktrees\//.test(line[1]!) ? 'worktree' : 'other'
}

/**
 * Read a `.git` FILE and classify it. Never throws — an unreadable file is `'other'`, the same
 * answer as content that names neither pattern: neither is proof of being a worktree.
 *
 * Still no `git` process: this is one `readFile` of a file the caller has ALREADY `stat`'d to learn
 * it is a file at all (the walk, from its own `Dirent`; `isWorktreeDir`, from its own `stat`), and
 * the file itself is the single line documented above — the OS's own page cache makes this cost
 * negligible next to the `readdir` calls the walk was already paying for.
 */
async function gitFileKind(gitFilePath: string): Promise<'worktree' | 'other'> {
  try {
    return classifyGitFile(await readFile(gitFilePath, 'utf8'))
  } catch {
    return 'other'
  }
}

/**
 * Walk `root` breadth-first to `depth`, pruning the junk above.
 *
 * Breadth-first on purpose: with a cap, the entries kept should be the ones NEAREST the home
 * directory, which are the ones a person actually works in. A depth-first walk that hit the cap
 * would spend the whole budget inside the first subtree it happened to enter.
 */
export async function scanDirectories(
  root: string = homedir(),
  depth: number = SCAN_DEPTH,
): Promise<ScannedDir[]> {
  const out: ScannedDir[] = []
  let frontier: string[] = [root]

  for (let level = 0; level <= depth && frontier.length > 0; level++) {
    const next: string[] = []
    // Bounded fan-out per level rather than one promise per directory: a level of a wide home
    // directory is thousands of `readdir`s, and issuing them all at once is how a walk turns into a
    // spike of open file descriptors.
    for (let i = 0; i < frontier.length; i += 64) {
      const batch = frontier.slice(i, i + 64)
      const results = await Promise.all(batch.map(async dir => {
        try {
          return { dir, entries: await readdir(dir, { withFileTypes: true }) }
        } catch {
          // Unreadable (permissions, a broken mount, a race with a delete). Not an error worth
          // reporting: it is one directory the user cannot start a session in either.
          return { dir, entries: [] }
        }
      }))

      for (const { dir, entries } of results) {
        // `.git` is a DIRECTORY for a repository's own checkout and a FILE for EITHER a linked
        // worktree OR a submodule — the file's own CONTENT is what tells those two apart, so a
        // read only happens for the rare entries that are actually `.git` files (worktrees and
        // submodules together, never the common case of every other directory in the walk).
        const gitEntry = entries.find(e => e.name === '.git')
        let hasGit = false
        let isWorktree = false
        if (gitEntry?.isDirectory()) {
          hasGit = true
        } else if (gitEntry?.isFile()) {
          if (await gitFileKind(join(dir, '.git')) === 'worktree') isWorktree = true
          else hasGit = true
        }
        // The root itself is a legitimate place to work, but it is offered by `cwd`/history rather
        // than by the walk, so only descendants are recorded.
        if (dir !== root) {
          out.push({ path: dir, name: baseName(dir), repo: hasGit, worktree: isWorktree })
        }
        if (out.length >= MAX_ENTRIES) return out
        // A repository's own subdirectories are still worth offering — a monorepo package is a real
        // place to start — so a `.git` does not stop the descent. Only the prune list does.
        for (const e of entries) {
          if (!e.isDirectory() || PRUNE.has(e.name)) continue
          next.push(join(dir, e.name))
        }
      }
    }
    frontier = next
  }

  return out
}

/** Is this an existing directory? The escape hatch for a path typed in full. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Is `path` itself a linked git worktree — the same `.git`-file-content test the walk gets for
 * (nearly) free, spent here for a path the walk never visited (a history entry outside the scan
 * depth or outside `$HOME`, the current directory, a typed path). One `stat` to confirm `.git` is
 * a FILE, then — only for that rare case — one `readFile` of it, classified by
 * `classifyGitFile`'s same rule the walk uses, so a submodule answers `false` here exactly as it
 * does there. Still never a `git` process: `git rev-parse --git-dir` would answer the same
 * question at the cost of spawning one per candidate, and the caller (`project-source.ts`) may run
 * this over every distinct directory this machine has ever worked in.
 */
export async function isWorktreeDir(path: string): Promise<boolean> {
  const gitPath = join(path, '.git')
  try {
    if (!(await stat(gitPath)).isFile()) return false
  } catch {
    return false
  }
  return (await gitFileKind(gitPath)) === 'worktree'
}

function baseName(path: string): string {
  const parts = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] ?? path
}
