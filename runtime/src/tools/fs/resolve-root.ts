/**
 * tools/fs/resolve-root.ts — one line, shared by `glob.ts` and `grep.ts` so the two tools cannot
 * drift on what "root defaults to the current directory" means (catalogue §3's `fs.glob`/`fs.grep`
 * row). Resolution goes through `../paths.ts`'s `resolveToolPath`, so the returned root is already
 * absolute and symlink-resolved — the same real path the policy will be asked to judge.
 */
import type { ToolContext } from '../contract.ts'
import { resolveToolPath } from '../paths.ts'

export async function resolveRoot(inputRoot: string | undefined, ctx: ToolContext): Promise<string> {
  return resolveToolPath(ctx.cwd, inputRoot ?? ctx.cwd)
}
