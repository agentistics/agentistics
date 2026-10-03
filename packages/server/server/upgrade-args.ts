/**
 * upgrade-args.ts — PURE: what `agentop upgrade <args>` means before anything is downloaded.
 *
 * `agentop upgrade --help` used to ignore the flag and UPGRADE — an install, a service restart, on a
 * request for documentation. An upgrade runs only with no arguments or with flags this command
 * knows; `-h`/`--help` prints help, and anything else is refused with the help and a non-zero exit.
 */

export type UpgradeArgs =
  | { kind: 'run' }
  | { kind: 'help' }
  | { kind: 'unknown'; arg: string }

/** `--lang` is the only flag the upgrade honours (it picks the language of its own output). */
export function parseUpgradeArgs(args: string[]): UpgradeArgs {
  if (args.includes('-h') || args.includes('--help')) return { kind: 'help' }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--lang') {
      const v = args[i + 1]
      if (v !== 'en' && v !== 'pt') return { kind: 'unknown', arg: v === undefined ? a : `${a} ${v}` }
      i++
      continue
    }
    if (a === '--lang=en' || a === '--lang=pt') continue
    return { kind: 'unknown', arg: a }
  }
  return { kind: 'run' }
}

export const UPGRADE_HELP = `agentop upgrade — download the latest release and restart the running services

Usage:
  agentop upgrade [--lang en|pt]
  agentop upgrade --help

Only installs a release published for this platform, verifies it before swapping it in, keeps the
previous binary at <binary>.bak and restores it if anything fails.
Any other flag is refused: an upgrade only runs with no flags or with the ones listed here.
`
