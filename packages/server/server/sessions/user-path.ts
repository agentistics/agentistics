import { homedir } from 'node:os'
import { withUserBin } from './harness-install-plan'

/**
 * THE one PATH every harness lookup shares — install, version check, availability, spawn.
 *
 * The official installers drop binaries in `~/.local/bin`, and the agentistics service often runs
 * under systemd with a PATH that lacks it, so a harness installed a minute ago was "installed" in
 * Settings and "missing" in the new-session picker (each asked a different PATH). `~/.local/bin`
 * goes first, once, whatever the process was started with.
 */
export function userSearchPath(path: string | undefined = process.env.PATH, home: string = process.env.HOME || homedir()): string {
  return withUserBin(path, home)
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
