/**
 * PURE: who may run THIS data dir's `agentop server` — and what to do with one that runs where it
 * should not.
 *
 * 2026-10-04 (docs/incidents/2026-10-04-server-outside-unit.md): the `agentop-server` systemd user
 * unit was installed and enabled, and the machine still ran an `agentop server` OUTSIDE it for hours.
 * The unit started, found the data dir held, waited its ten minutes and exited 75 (TEMPFAIL) — and
 * stayed failed, so the installed v2.103.1 never ran while the stray kept serving v2.101.2. The
 * stray was not exotic: the control center's Start / Restart (`startBackground`, a `nohup agentop
 * server &`), `agentop server --bg`, and a plain `agentop server` typed in a terminal all spawn a
 * server of their own, whatever is installed. Started from the Ubuntu terminal, such a server is
 * reparented to WSL's interop relay (`/init`) the moment its launcher exits, which is the
 * `parent 1 · /init` shape found on the machine.
 *
 * Two rules, decided here from facts the caller reads:
 *  1. When the unit is installed for the owner's own store, every path that "ensures a server" goes
 *     THROUGH THE UNIT (`systemctl --user start|restart agentop-server`). The one exception is a
 *     manager that cannot be asked at all (no user bus yet — WSL's early boot): then nothing else
 *     can run a server, and the unit takes the data dir back the moment it starts (rule 2).
 *  2. A server running outside the unit is TAKEN BACK — stopped, so the unit can start — only when
 *     it is provably this data dir's own: its argv IS `agentop server`, it is in no agentop unit,
 *     and it is the process holding THIS data dir's lock. Anything less is still only reported.
 */
import { isAgentopServerArgv, managedByAgentopUnit, type ServerProc } from './server-restart-plan.ts'

/** Env switch that keeps a hand-run `agentop server` in the foreground even with the unit installed. */
export const FOREGROUND_ENV = 'AGENTISTICS_SERVER_FOREGROUND'

export interface OwnershipFacts {
  /** `linux` is the only platform with an `agentop-server` systemd unit. */
  platform: string
  /** The `agentop-server` unit file exists. */
  unitInstalled: boolean
  /** The data dir is the account's own `~/.agentistics` (a preview/test HOME never delegates). */
  ownersStore: boolean
  /** This process runs inside an agentop unit (its cgroup, or systemd's INVOCATION_ID). */
  insideUnit: boolean
  /** The person asked for a foreground server here regardless (`FOREGROUND_ENV=1`). */
  foregroundForced: boolean
}

/** Does the service manager own this data dir's server? The one question every launcher asks. */
export function serviceOwnsServer(f: Omit<OwnershipFacts, 'insideUnit' | 'foregroundForced'>): boolean {
  return (f.platform === 'linux' || f.platform === 'darwin') && f.unitInstalled && f.ownersStore
}

export type StartRoute =
  /** Run the server in this process (we ARE the unit, or no unit owns this data dir). */
  | { kind: 'run' }
  /** Start the unit instead and exit: a second, unsupervised copy is what this module prevents. */
  | { kind: 'delegate' }

/** What a hand-run `agentop server` (or a launcher about to spawn one) should do. */
export function planServerStart(f: OwnershipFacts): StartRoute {
  if (f.insideUnit || f.foregroundForced) return { kind: 'run' }
  return serviceOwnsServer(f) ? { kind: 'delegate' } : { kind: 'run' }
}

/** Is this process inside one of agentop's own units? `INVOCATION_ID` is systemd's own marker. */
export function isInsideUnit(cgroup: string, invocationId: string | undefined, launchdMarker = false): boolean {
  return managedByAgentopUnit(cgroup) || (invocationId !== undefined && invocationId !== '') || launchdMarker
}

export type ReclaimPlan =
  | { kind: 'reclaim'; pid: number }
  /** Nothing to take back: nobody holds the data dir, or the holder is the unit's own server. */
  | { kind: 'none' }
  /** Somebody holds it and cannot be PROVEN ours — report, never kill. `reason` is a code. */
  | { kind: 'unproven'; pid: number; reason: 'not-agentop-server' | 'unreadable' | 'is-self' }

/**
 * Should the holder of THIS data dir's lock be stopped so the unit can serve?
 * `holder` is the lock's live holder (`probeInstanceLock`), `proc` what `/proc` says about it.
 */
export function planStrayReclaim(o: { holder: number | null; proc: ServerProc | null; selfPid: number }): ReclaimPlan {
  if (o.holder === null) return { kind: 'none' }
  if (o.holder === o.selfPid) return { kind: 'unproven', pid: o.holder, reason: 'is-self' }
  if (!o.proc || o.proc.pid !== o.holder) return { kind: 'unproven', pid: o.holder, reason: 'unreadable' }
  if (managedByAgentopUnit(o.proc.cgroup)) return { kind: 'none' }
  if (!isAgentopServerArgv(o.proc.argv)) return { kind: 'unproven', pid: o.holder, reason: 'not-agentop-server' }
  return { kind: 'reclaim', pid: o.holder }
}
