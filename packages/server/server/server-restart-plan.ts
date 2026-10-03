/**
 * PURE: how `agentop upgrade` puts the new binary into the running server — and, above all, what it
 * must never do.
 *
 * 2026-10-03 00:38 (docs/incidents/2026-10-03-restart-loop.md): the upgrade asked
 * `systemctl --user is-active agentop-server`, did not get `active` back from where it ran, and fell
 * through to a fallback meant for a server started by hand: `pgrep -f 'agentop.*(server|start)'`,
 * SIGTERM, SIGKILL one second later, and a `nohup agentop server --bg` spawned detached. The pid it
 * killed was the UNIT's own server; the one it spawned ran outside the unit and held the data dir;
 * the unit, restarted by systemd every five seconds, was refused 190 times, and each refusal loaded
 * the whole application. The machine ran out of memory to open sessions in.
 *
 * So the decision is made here, from facts read by the caller:
 *  - a unit file installed means the SERVICE MANAGER owns the server. It restarts it, or nothing
 *    does. When the manager cannot be asked, the answer is a sentence, never a kill.
 *  - a server running OUTSIDE an installed unit is reported, never killed: agentop did not start it
 *    and cannot know whose it is.
 *  - only with no unit at all is a detached handover allowed, and only of processes whose argv IS
 *    `agentop server` — never a pattern over the whole command line.
 */

/** One process as `/proc` reports it. */
export interface ServerProc {
  pid: number
  /** `/proc/<pid>/cmdline`, split on NUL. */
  argv: string[]
  /** `/proc/<pid>/cgroup`, verbatim. */
  cgroup: string
}

export type ServerRestartPlan =
  /** The unit is installed and active: `systemctl --user restart` (via `restartAutostart`). */
  | { kind: 'service' }
  /** The unit is installed and the manager could not say whether it runs: touch nothing. */
  | { kind: 'manager-unreachable' }
  /** The unit is installed and these servers run outside it: report them, touch nothing. */
  | { kind: 'outside-service'; pids: number[] }
  /** No unit: stop these unmanaged servers cleanly, then start one detached. */
  | { kind: 'detached'; pids: number[] }
  /** Nothing is running that this upgrade should restart. */
  | { kind: 'none' }

const BASENAME = /[^/\\]+$/

/**
 * Is this argv `agentop server` (the installed binary, or `bun …/cli.ts` from a checkout)?
 * `--bg` is excluded: that invocation is a launcher that spawns the real server and exits.
 */
export function isAgentopServerArgv(argv: readonly string[]): boolean {
  if (argv.length < 2) return false
  const exe = (argv[0]!.match(BASENAME)?.[0] ?? '').replace(/\.exe$/i, '')
  let rest: readonly string[]
  if (exe === 'agentop') rest = argv.slice(1)
  else if ((exe === 'bun' || exe === 'node') && /(^|[/\\])cli\.(ts|js)$/.test(argv[1] ?? '')) rest = argv.slice(2)
  else return false
  if (rest[0] !== 'server') return false
  return !rest.includes('--bg') && !rest.includes('--background')
}

/** Does this cgroup line put the process inside one of agentop's own systemd units? */
export function managedByAgentopUnit(cgroup: string): boolean {
  return /\/agentop-[a-z]+\.service(\/|$)/m.test(cgroup)
}

export function planServerRestart(o: {
  /** The `agentop-server` unit file exists. */
  unitInstalled: boolean
  /** `true` active, `false` the manager answered and it is not, `null` the manager could not be asked. */
  unitActive: boolean | null
  procs: readonly ServerProc[]
  selfPid: number
}): ServerRestartPlan {
  // The PARENT is deliberately not excluded: the dashboard's "update now" spawns the upgrade from the
  // server itself, and that server is exactly the one to restart.
  const servers = o.procs.filter(p => p.pid !== o.selfPid && isAgentopServerArgv(p.argv))
  const outside = servers.filter(p => !managedByAgentopUnit(p.cgroup)).map(p => p.pid)

  if (o.unitInstalled) {
    if (outside.length > 0) return { kind: 'outside-service', pids: outside }
    if (o.unitActive === true) return { kind: 'service' }
    if (o.unitActive === null) return { kind: 'manager-unreachable' }
    return { kind: 'none' }
  }
  return outside.length > 0 ? { kind: 'detached', pids: outside } : { kind: 'none' }
}

/**
 * PURE: `systemctl --user is-active` stdout → the three-valued answer the plan needs. Empty output
 * is the manager NOT ANSWERING (no reachable user bus prints its reason on stderr and nothing on
 * stdout) — the one case the old check read as "not running" and acted on.
 */
export function parseIsActive(stdout: string): boolean | null {
  const s = stdout.trim()
  if (s === 'active' || s === 'activating' || s === 'reloading') return true
  if (s === 'inactive' || s === 'failed' || s === 'deactivating' || s === 'dead') return false
  return null
}

export interface ServiceFinding { status: 'pass' | 'warn'; label: string; detail: string }

/**
 * PURE: what `agentop doctor` reports about the `agentop-server` service. A server running OUTSIDE
 * an installed unit is the shape of 2026-10-03: it holds the data dir, the unit is refused on every
 * start, and nothing on screen says why. `unitText` is null when no unit is installed.
 */
export function serviceFindings(o: {
  unitText: string | null
  unitActive: boolean | null
  /** Who holds the data-dir lock now, and its `/proc/<pid>/cgroup`; null when nobody does. */
  holder: { pid: number; cgroup: string } | null
}): ServiceFinding[] {
  if (o.unitText === null) return []
  const out: ServiceFinding[] = []
  if (o.holder && !managedByAgentopUnit(o.holder.cgroup)) {
    out.push({
      status: 'warn',
      label: 'an agentop server is running OUTSIDE the agentop-server service',
      detail: `pid ${o.holder.pid} holds the data directory, so the service cannot start` +
        `${o.unitActive === false ? ' (it is stopped)' : ''}. Stop that process (\`kill ${o.holder.pid}\`), ` +
        'then `systemctl --user restart agentop-server`.',
    })
  } else if (o.holder) {
    out.push({ status: 'pass', label: 'agentop server runs under its service', detail: `pid ${o.holder.pid}, inside agentop-server.service` })
  }
  const guarded = /^\s*RestartPreventExitStatus\s*=/m.test(o.unitText) && /^\s*StartLimitBurst\s*=/m.test(o.unitText)
  if (!guarded) {
    out.push({
      status: 'warn',
      label: 'the agentop-server unit has no restart guards',
      detail: 'a refused start can loop every 5 s forever. `agentop restart server` adds them to the installed unit.',
    })
  }
  return out
}
