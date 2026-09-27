/**
 * tools/paths.ts — where a path the model names really points. The policy judges the REAL file:
 * a symlink inside the workspace pointing at `~/.ssh` is a read of `~/.ssh`, and `a/../../etc` is a
 * read of `/etc`. So every tool resolves through here before stating a subject.
 */

import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Absolute, normalised and symlink-resolved. A path that does not exist yet (a file about to be
 * created) resolves its nearest EXISTING ancestor and re-appends the rest, so a new file under a
 * symlinked directory is still judged by where it would really land.
 */
export async function resolveToolPath(cwd: string, p: string): Promise<string> {
  const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p)
  const tail: string[] = []
  let cur = abs
  for (;;) {
    try {
      const real = await realpath(cur)
      return tail.length === 0 ? real : join(real, ...tail.reverse())
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return abs
      tail.push(basename(cur))
      cur = parent
    }
  }
}

/** True when `target` is `root` itself or below it. Both must already be resolved. */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))
}
