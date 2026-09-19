/**
 * editor-path.ts — PURE: is a client-given path allowed inside a session's directory tree?
 *
 * This generalizes the exact posture `resolveArtifactPath` / `withinDirectory` (`artifact-file.ts`)
 * already take for the Files tab's ALLOWLIST — applied here to the whole subtree instead of a
 * named list, because this feature has no allowlist: every file under the session's directory is
 * fair game, and the only question is containment.
 *
 * This module is the LEXICAL half only (no IO, no symlink resolution) — it catches a `..` escape
 * before anything touches disk. The REAL half (resolving symlinks and re-checking containment on
 * the resolved paths, to catch a symlink INSIDE the tree pointing outside it) lives in
 * `editor-fs.ts`, which is where the filesystem access already is.
 */
import { isAbsolute, resolve } from 'node:path'
import { withinDirectory } from './artifact-file'

/** Is `path` the root itself, or somewhere inside it? `withinDirectory` alone excludes the root. */
export function containedInRoot(path: string, root: string): boolean {
  return path === root || withinDirectory(path, root)
}

export type TreePathRefusal = 'escaped'
export type TreePathPlan =
  | { ok: true; abs: string }
  | { ok: false; reason: TreePathRefusal }

/**
 * Resolve a client-given relative path against `root`. `''` names the root itself (used for
 * listing the top of the tree). There is no route that accepts an absolute path from the client —
 * one is refused exactly like a `..` escape, never silently rebased onto the root.
 */
export function resolveTreePath(root: string, requested: string): TreePathPlan {
  const raw = (requested ?? '').trim()
  if (raw === '') return { ok: true, abs: root }
  if (isAbsolute(raw)) return { ok: false, reason: 'escaped' }
  const abs = resolve(root, raw)
  return containedInRoot(abs, root) ? { ok: true, abs } : { ok: false, reason: 'escaped' }
}
