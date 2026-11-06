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
import { join, resolve, sep } from 'node:path'

export function isManagedAccountRoot(dir: string | undefined, dataDir: string): boolean {
  if (!dir) return false
  const base = join(resolve(dataDir), 'accounts') + sep
  return (resolve(dir) + sep).startsWith(base)
}

/** The env value that really names the default Claude login, or undefined (fall back to `~/.claude`). */
export function defaultClaudeConfigDir(env: Readonly<Record<string, string | undefined>>, dataDir: string): string | undefined {
  const v = env.CLAUDE_CONFIG_DIR
  return v && !isManagedAccountRoot(v, dataDir) ? v : undefined
}
