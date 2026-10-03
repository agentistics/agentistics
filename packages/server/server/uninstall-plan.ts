/**
 * uninstall-plan.ts — PURE: what `agentop uninstall` does, in what order, and what it may never touch.
 *
 * The data directory is the dangerous half: it holds the vault. So deleting it is a SEPARATE answer
 * (default NO), `--yes` never says yes to it, and `safeDataDir` refuses a path that could be a
 * home directory or a root — a mistyped AGENTISTICS_DIR must not turn into `rm -rf ~`.
 */

export type UninstallArgs =
  | { kind: 'help' }
  | { kind: 'unknown'; arg: string }
  | { kind: 'run'; yes: boolean; keepData: boolean }

export function parseUninstallArgs(args: string[]): UninstallArgs {
  if (args.includes('-h') || args.includes('--help')) return { kind: 'help' }
  let yes = false
  let keepData = false
  for (const a of args) {
    if (a === '--yes' || a === '-y') yes = true
    else if (a === '--keep-data') keepData = true
    else return { kind: 'unknown', arg: a }
  }
  return { kind: 'run', yes, keepData }
}

export const UNINSTALL_HELP = `agentop uninstall — remove agentop from this machine

Usage:
  agentop uninstall [--yes] [--keep-data]
  agentop uninstall --help

Stops and disables the autostart service, removes the update-check hook from your shell rc, on WSL
removes the Windows logon task / Startup script, and removes the agentop binary.

Your data in ~/.agentistics is asked about SEPARATELY (default: keep). --yes skips the first
confirmation only; it never deletes your data. --keep-data does not even ask.
`

export const DATA_WARNING =
  'This deletes your metrics history, preferences, task board and the VAULT. After this the vault and ' +
  'its 24 recovery words are your problem: without them its secrets cannot be recovered, by you or by anyone.'

export type UninstallStepId = 'services' | 'update-hook' | 'windows-entry' | 'binary' | 'data'

export function planUninstall(f: {
  wsl: boolean
  installedBinary: boolean
  deleteData: boolean
}): UninstallStepId[] {
  const steps: UninstallStepId[] = ['services', 'update-hook']
  if (f.wsl) steps.push('windows-entry')
  if (f.installedBinary) steps.push('binary')
  if (f.deleteData) steps.push('data')
  return steps
}

/** The binary and the copy `agentop upgrade` keeps beside it. */
export function binaryTargets(execPath: string): string[] {
  return [execPath, `${execPath}.bak`]
}

/** May this directory be deleted as "the agentop data directory"? Never a root, a home or a shallow path. */
export function safeDataDir(dir: string, home: string): boolean {
  if (!dir.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(dir)) return false
  const norm = (p: string) => p.replace(/[\\/]+$/, '')
  if (norm(dir) === norm(home) || norm(dir) === '') return false
  const depth = norm(dir).split(/[\\/]/).filter(Boolean).length
  return depth >= 2
}
