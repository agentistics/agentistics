/**
 * editor-list.ts — PURE: turning a set of paths into the IMMEDIATE children of one directory.
 *
 * The tree is LAZY — one directory per call, never a recursive dump — but `git ls-files` has no
 * concept of "immediate children"; it only ever answers with the full recursive set under a
 * pathspec. `collapseToChildren` is what turns that recursive, gitignore-aware set into exactly
 * the one level the tree UI asked for, which is what keeps the git-aware path lazy too.
 */

export interface TreeChild {
  name: string
  kind: 'file' | 'dir'
}

const byName = (a: string, b: string) => a.localeCompare(b)

/**
 * `relativePaths` are paths relative to the directory being listed (never to its parent), as
 * `editor-fs.ts` produces after stripping the pathspec prefix off `git ls-files`' own output.
 */
export function collapseToChildren(relativePaths: readonly string[]): TreeChild[] {
  const files = new Set<string>()
  const dirs = new Set<string>()
  for (const raw of relativePaths) {
    const p = raw.replace(/^\/+/, '')
    if (!p) continue
    const slash = p.indexOf('/')
    if (slash === -1) { files.add(p); continue }
    const head = p.slice(0, slash)
    if (head) dirs.add(head)
  }
  return [
    ...[...dirs].sort(byName).map(name => ({ name, kind: 'dir' as const })),
    ...[...files].sort(byName).map(name => ({ name, kind: 'file' as const })),
  ]
}

/** The non-git fallback: a plain `readdir` has no gitignore to lean on, so nothing is filtered. */
export function childrenFromDirents(
  entries: readonly { name: string; isDirectory(): boolean }[],
): TreeChild[] {
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort(byName)
  const files = entries.filter(e => !e.isDirectory()).map(e => e.name).sort(byName)
  return [
    ...dirs.map(name => ({ name, kind: 'dir' as const })),
    ...files.map(name => ({ name, kind: 'file' as const })),
  ]
}

/**
 * Folds a set of EMPTY-directory names (found by `editor-fs.ts`'s own readdir + `git
 * check-ignore` pass — see that module for why git's file-based listing can never produce these
 * on its own) into an already-collapsed child list, and re-sorts once so the merged result reads
 * exactly like `collapseToChildren`'s own output: directories first, each side alphabetical.
 *
 * `emptyDirNames` is deduplicated against `children`'s own directories defensively — the caller
 * already excludes anything it knows about before this runs, so a name reappearing here would
 * mean the two sources disagree, and a `Set` is the cheap way to never double a row over that.
 */
export function mergeEmptyDirs(
  children: readonly TreeChild[], emptyDirNames: readonly string[],
): TreeChild[] {
  if (emptyDirNames.length === 0) return [...children]
  const dirs = new Set(children.filter(c => c.kind === 'dir').map(c => c.name))
  for (const name of emptyDirNames) dirs.add(name)
  const files = children.filter(c => c.kind === 'file').map(c => c.name)
  return [
    ...[...dirs].sort(byName).map(name => ({ name, kind: 'dir' as const })),
    ...files.sort(byName).map(name => ({ name, kind: 'file' as const })),
  ]
}
