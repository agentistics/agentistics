/**
 * real-contained.ts — the REAL (symlink-resolved) containment recheck, shared by every reader that
 * accepts a client-given path into a directory it does not fully control.
 *
 * A LEXICAL check (`resolveTreePath`, `resolveAttachmentRead`) only catches a `..` escape — it never
 * touches disk, so a symlink placed INSIDE the allowed directory that points somewhere else resolves
 * the prefix check and is then served straight off its target. This re-resolves both the directory
 * and the requested path with `realpath` and checks containment again on what they actually are.
 *
 * Written once for the Studio's own tree (`editor-fs.ts`'s local `realContained`) and lifted out
 * here so every other reader gets the identical guarantee instead of a second, hand-rolled copy.
 */
import { realpath } from 'node:fs/promises'
import { containedInRoot } from './editor-path'

/**
 * Returns the real, resolved path when `abs` is `root` itself or genuinely inside it (following
 * every symlink on both sides) — `null` when it escapes, or when either side does not exist.
 */
export async function realContained(root: string, abs: string): Promise<string | null> {
  try {
    const [realRoot, realAbs] = await Promise.all([realpath(root), realpath(abs)])
    return containedInRoot(realAbs, realRoot) ? realAbs : null
  } catch {
    return null
  }
}
