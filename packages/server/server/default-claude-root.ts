/**
 * default-claude-root.ts — which folder is Claude's DEFAULT login. PURE (env/paths passed in).
 *
 * `CLAUDE_CONFIG_DIR` in the SERVER's environment is NOT a statement about the default login when it
 * names one of agentistics's own account roots (`<data>/accounts/claude/r_<hash>`): that is a leak —
 * the server was (re)started from inside a session of that account, whose spawn env carried the
 * variable. Reading it as the default root made the default login (`~/.claude`, the "Principal"
 * account) resolve to ANOTHER account's folder: the identity probe bound the default root to that
 * account, the usage poller read its credentials for the default meter (two Max accounts showing the
 * same percentage), and the real default account stayed "not connected". A root the user set by hand
 * (outside the managed accounts folder) still wins, as before.
 */
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

/**
 * realpath of the nearest existing ancestor plus the not-yet-existing tail; plain `resolve` when
 * nothing resolves. Symlinks, `/private/var` vs `/var` and the like compare equal this way.
 */
function canonical(path: string): string {
  const abs = resolve(path)
  const tail: string[] = []
  let at = abs
  for (;;) {
    try { return join(realpathSync(at), ...tail.reverse()) } catch { /* not there yet: climb */ }
    const up = dirname(at)
    if (up === at) return abs
    tail.push(basename(at))
    at = up
  }
}

export function isManagedAccountRoot(dir: string | undefined, dataDir: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!dir) return false
  const fold = (p: string) => platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p
  const base = fold(join(canonical(dataDir), 'accounts') + sep)
  return fold(canonical(dir) + sep).startsWith(base)
}

/** The env value that really names the default Claude login, or undefined (fall back to `~/.claude`). */
export function defaultClaudeConfigDir(env: Readonly<Record<string, string | undefined>>, dataDir: string): string | undefined {
  const v = env.CLAUDE_CONFIG_DIR
  return v && !isManagedAccountRoot(v, dataDir) ? v : undefined
}
