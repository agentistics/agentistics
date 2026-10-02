/**
 * autostart-plan.ts — PURE decisions behind `agentop autostart` on Linux/WSL.
 *
 * Three failures were seen on one machine and each is a plan here, so IO (autostart.ts) only
 * executes what was decided and a test can pin every case without touching `loginctl`,
 * `schtasks.exe` or `systemctl`:
 *
 *  1. NO USER BUS. Without systemd user linger, `/run/user/<uid>` and its bus never exist, so
 *     `systemctl --user daemon-reload` answers "Failed to connect to bus" and no user unit ever
 *     runs. `lingerPlan` decides whether linger must be enabled; `lingerOutcome` turns the answer
 *     into a verdict — a refusal is NOT active, it is a sentence naming the exact command.
 *  2. WSL DOES NOT START THE DISTRO AT LOGON. Windows boots nothing until something asks, so the
 *     unit never gets a chance. A logon Scheduled Task that runs `wsl.exe -d <distro> --exec
 *     /bin/true` boots the distro (and, with it, systemd). Every argv is built as an ARRAY — the
 *     distro name is validated against a closed alphabet and never interpolated into a shell line.
 *  3. THE UNIT LOOPED. A server started by hand holds the port; the unit then failed and
 *     `Restart=on-failure` retried every 5 s forever. `portHeldVerdict` is the guard's decision.
 */

export type LingerState = 'yes' | 'no' | 'unknown'

export interface BusFacts {
  /** `$XDG_RUNTIME_DIR/bus` exists (the user bus socket). */
  busSocket: boolean
  /** `loginctl show-user <user> -p Linger`, parsed. `unknown` = loginctl absent or failed. */
  linger: LingerState
}

/** Parse `loginctl show-user -p Linger` output (`Linger=yes`). Anything else is `unknown`. */
export function parseLinger(stdout: string): LingerState {
  const m = /^Linger=(yes|no)\s*$/m.exec(stdout)
  return m ? (m[1] as LingerState) : 'unknown'
}

export type LingerPlan =
  | { action: 'none'; why: 'bus-present' | 'linger-on' }
  | { action: 'enable-linger'; argv: string[] }

/**
 * Must linger be enabled? Only when the bus is missing AND linger is not already on. A present bus
 * means the session already has one (a login), and linger=yes means the bus will exist at boot —
 * touching either would be a change nobody needs. `unknown` linger with no bus tries to enable:
 * an unanswerable question is resolved toward the thing that makes the unit run.
 */
export function lingerPlan(facts: BusFacts, user: string): LingerPlan {
  if (facts.linger === 'yes') return { action: 'none', why: 'linger-on' }
  if (facts.busSocket && facts.linger !== 'no') return { action: 'none', why: 'bus-present' }
  // Even with a bus (a login session) a linger=no machine will lose it at logout/boot, so linger
  // is what a BOOT start needs: enable it.
  return { action: 'enable-linger', argv: ['loginctl', 'enable-linger', user] }
}

export interface LingerRun { code: number; stderr: string }

export interface LingerVerdict {
  /** Will the unit start without anybody logged in? */
  active: boolean
  /** One line for the user, or '' when there is nothing to say. */
  message: string
}

/** The command the user must run themselves when agentop could not. */
export function manualLingerCommand(user: string): string {
  return `sudo loginctl enable-linger ${user}`
}

export function lingerOutcome(plan: LingerPlan, ran: LingerRun | null, user: string): LingerVerdict {
  if (plan.action === 'none') {
    return {
      active: true,
      message: plan.why === 'linger-on' ? 'Linger is on — the user bus exists at boot.' : '',
    }
  }
  if (ran && ran.code === 0) {
    return { active: true, message: 'Enabled linger — the user bus now exists at boot without a login.' }
  }
  const reason = ran ? (ran.stderr || `exit ${ran.code}`) : 'loginctl could not be run'
  return {
    active: false,
    message:
      `Autostart is NOT active: the systemd user bus does not exist without linger, and enabling it was refused (${reason}).\n` +
      `Run this, then \`agentop autostart server enable\` again:\n  ${manualLingerCommand(user)}`,
  }
}

// ---------------------------------------------------------------------------
// WSL logon task

/** WSL distro names: letters, digits, dot, dash, underscore. Anything else is refused, not quoted. */
const DISTRO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function validDistro(name: string | undefined): name is string {
  return !!name && DISTRO_RE.test(name)
}

export function wslTaskName(distro: string): string {
  return `Agentistics autostart (${distro})`
}

/** The command the task runs: boots the distro and, with it, its systemd. */
export function wslTaskCommand(distro: string): string {
  return `wsl.exe -d ${distro} --exec /bin/true`
}

export type WslTaskPlan =
  | { ok: true; name: string; create: string[]; remove: string[]; query: string[] }
  | { ok: false; reason: string }

/**
 * argv for schtasks.exe. `/TR` takes one string by Task Scheduler's own grammar, which is why the
 * distro is validated first: there is no quoting rule here to get wrong. `/F` makes create
 * idempotent (replaces a task of the same name); `/RL LIMITED` keeps it unelevated.
 */
export function wslTaskPlan(distro: string | undefined): WslTaskPlan {
  if (!validDistro(distro)) {
    return {
      ok: false,
      reason: distro
        ? `The WSL distro name "${distro}" has characters this will not pass to schtasks.exe (allowed: letters, digits, . _ -).`
        : 'WSL_DISTRO_NAME is not set, so the distro to boot at logon is unknown.',
    }
  }
  const name = wslTaskName(distro)
  return {
    ok: true,
    name,
    create: ['schtasks.exe', '/Create', '/F', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TN', name, '/TR', wslTaskCommand(distro)],
    remove: ['schtasks.exe', '/Delete', '/F', '/TN', name],
    query: ['schtasks.exe', '/Query', '/TN', name],
  }
}

export interface WslTaskVerdict { ok: boolean; message: string }

export function wslTaskCreateOutcome(name: string, code: number, stderr: string): WslTaskVerdict {
  return code === 0
    ? { ok: true, message: `Registered the Windows logon task "${name}" — logging in to Windows boots this distro.` }
    : {
        ok: false,
        message:
          `Could not register the Windows logon task "${name}" (${stderr || `exit ${code}`}). ` +
          'Without it Windows does not start this distro at logon, so the unit only runs once you open a WSL terminal.',
      }
}

/** Deleting a task that is not there is the normal idempotent case, not a failure. */
export function wslTaskRemoveOutcome(name: string, code: number, stderr: string): WslTaskVerdict {
  if (code === 0) return { ok: true, message: `Removed the Windows logon task "${name}".` }
  if (/cannot find|does not exist|não pode|nao pode/i.test(stderr)) {
    return { ok: true, message: `No Windows logon task "${name}" to remove.` }
  }
  return { ok: false, message: `Could not remove the Windows logon task "${name}" (${stderr || `exit ${code}`}).` }
}

// ---------------------------------------------------------------------------
// The port guard

export type PortHeldVerdict =
  | { run: true }
  | { run: false; message: string }

/**
 * Should the unit start the server? `holder` is the pid listening on the port (null = free).
 * A held port means another agentop (a hand-started one) already serves it; the unit steps aside
 * with ONE sentence instead of failing and being restarted every 5 s.
 */
export function portHeldVerdict(port: number, holder: number | null): PortHeldVerdict {
  if (holder === null) return { run: true }
  return {
    run: false,
    message:
      `agentop is already serving :${port} (pid ${holder}), started outside this unit — ` +
      'the unit will not start a second one. Stop that process (or `agentop restart server` after ' +
      'stopping it) to hand the port to the service.',
  }
}

// ---------------------------------------------------------------------------
// Status lines (doctor / autostart status): each fact with its fix.

export interface StatusFacts {
  busSocket: boolean
  linger: LingerState
  user: string
  unitActive: string // systemctl is-active output, or ''
  unitEnabled: string
  /** WSL only: `null` outside WSL. */
  wsl: null | { distro: string | undefined; taskPresent: boolean | null }
}

export interface StatusLine { label: string; ok: boolean; detail: string; fix?: string }

export function statusLines(f: StatusFacts): StatusLine[] {
  const out: StatusLine[] = []
  out.push({
    label: 'systemd user linger',
    ok: f.linger === 'yes',
    detail: f.linger === 'yes' ? 'on' : f.linger === 'no' ? 'off — user units do not start at boot' : 'could not be read',
    fix: f.linger === 'yes' ? undefined : manualLingerCommand(f.user),
  })
  out.push({
    label: 'systemd user bus',
    ok: f.busSocket,
    detail: f.busSocket ? 'present' : 'missing — systemctl --user cannot connect',
    fix: f.busSocket ? undefined : manualLingerCommand(f.user),
  })
  const active = f.unitActive === 'active'
  out.push({
    label: 'agentop-server unit',
    ok: active,
    detail: `enabled=${f.unitEnabled || 'unknown'}, active=${f.unitActive || 'unknown'}`,
    fix: active ? undefined : 'agentop autostart server enable',
  })
  if (f.wsl) {
    const p = wslTaskPlan(f.wsl.distro)
    const name = p.ok ? p.name : 'Agentistics autostart (<distro>)'
    out.push({
      label: 'Windows logon task',
      ok: f.wsl.taskPresent === true,
      detail: f.wsl.taskPresent === null ? `${name}: could not be queried (no schtasks.exe interop)` : f.wsl.taskPresent ? `${name}: registered` : `${name}: missing — Windows will not boot this distro at logon`,
      fix: f.wsl.taskPresent === true ? undefined : 'agentop autostart server enable',
    })
  }
  return out
}

export function formatStatusLines(lines: StatusLine[]): string {
  return lines
    .map(l => `${l.ok ? '✓' : '✗'} ${l.label}: ${l.detail}${l.fix ? `\n    fix: ${l.fix}` : ''}`)
    .join('\n')
}
