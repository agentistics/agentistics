import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { withUserBin } from './harness-install-plan'

/**
 * The per-user directories the assistants' OWN installers use besides `~/.local/bin` (the table in
 * `service-path.ts`): bun's global bin (codex, gemini) and Volta's shims (copilot). A server started
 * with a PATH that lacks them — an old unit, `agentop run --rm`, a launcher — reported an installed
 * assistant as missing while the person runs it in any terminal. APPENDED, never prepended: the
 * process's own PATH keeps deciding which binary wins, these only fill a gap. Only directories that
 * exist are added, so an isolated HOME gets nothing it cannot use.
 */
export const USER_FALLBACK_BIN_DIRS = ['.bun/bin', '.volta/bin', '.kimi-code/bin']

/**
 * THE one PATH every harness lookup shares — install, version check, availability, spawn.
 *
 * The official installers drop binaries in `~/.local/bin`, and the agentistics service often runs
 * under systemd with a PATH that lacks it, so a harness installed a minute ago was "installed" in
 * Settings and "missing" in the new-session picker (each asked a different PATH). `~/.local/bin`
 * goes first, once, whatever the process was started with; `USER_FALLBACK_BIN_DIRS` go last.
 */
export function userSearchPath(
  path: string | undefined = process.env.PATH,
  home: string = process.env.HOME || homedir(),
  exists: (dir: string) => boolean = existsSync,
): string {
  const base = withUserBin(path, home)
  const have = new Set(base.split(':'))
  const extra = USER_FALLBACK_BIN_DIRS.map(d => `${home}/${d}`).filter(d => !have.has(d) && exists(d))
  return extra.length ? `${base}:${extra.join(':')}` : base
}

/**
 * Makes `process.env.PATH` carry `~/.local/bin`, idempotently. Called before anything that looks a
 * harness up OR hands a PATH to a child (the tmux pane is given this process's PATH), so a binary
 * the lookup found is a binary the pane can exec.
 */
export function adoptUserBinOnPath(): void {
  const next = userSearchPath()
  if (next !== process.env.PATH) process.env.PATH = next
}
