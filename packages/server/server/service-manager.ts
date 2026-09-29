/**
 * service-manager.ts — PURE: which init system can keep an agentop mode running on THIS box, and
 * the exact file (or argv) each one needs.
 *
 * `autostart.ts` was systemd-only and said so honestly, printing a paragraph of manual steps on
 * macOS and Windows. The paragraph is the problem: the docs carried launchd and pm2 recipes that
 * a user had to transcribe by hand, which means the product knew the answer and made someone else
 * type it. This module holds those recipes as data so `agentop autostart <mode> enable` can write
 * them, and so the docs can point at one implementation instead of repeating a plist.
 *
 * The rule that made this worth extracting, though, is not portability — it is `keepsRunning`.
 *
 * A service command is one of two shapes, and confusing them produces a unit that looks installed
 * and is wrong. `agentop server` runs in the FOREGROUND: the process is the service, and systemd's
 * `Type=simple` is correct. `docker compose up -d` and `central.sh up` RETURN once the container is
 * up: under `Type=simple` systemd watches the wrapper exit, marks the unit inactive(dead) within a
 * second, and every later `is-active` answers `inactive` for a central that is serving traffic
 * perfectly well. `Type=oneshot` + `RemainAfterExit=yes` is what states "the command finishing is
 * the service starting". Same distinction drives pm2's `--no-autorestart`: without it pm2 re-runs
 * `docker compose up -d` in a loop forever.
 *
 * Nothing here touches the filesystem, `process`, or the network — facts in, file contents out.
 */

import { servicePath } from './sessions/service-path'

/** An init system this product can register a mode with. */
export type ServiceManagerId = 'systemd' | 'launchd' | 'pm2'

/** Stable order for every surface that lists them: the platform's own first, pm2 last. */
export const SERVICE_MANAGERS: readonly ServiceManagerId[] = ['systemd', 'launchd', 'pm2']

/** Why a manager cannot be used here. Codes, not sentences — the CLI's i18n renders them. */
export type ServiceManagerBlock = 'wrong-platform' | 'not-installed'

export interface ServiceManagerFacts {
  /** `process.platform`. */
  platform: string
  /** `systemctl` is on PATH. */
  systemctl: boolean
  /** `launchctl` is on PATH. */
  launchctl: boolean
  /** `pm2` is on PATH. */
  pm2: boolean
}

export interface ServiceManagerOption {
  id: ServiceManagerId
  available: boolean
  reason?: ServiceManagerBlock
}

function blockFor(id: ServiceManagerId, facts: ServiceManagerFacts): ServiceManagerBlock | null {
  switch (id) {
    case 'systemd':
      if (facts.platform !== 'linux') return 'wrong-platform'
      return facts.systemctl ? null : 'not-installed'
    case 'launchd':
      if (facts.platform !== 'darwin') return 'wrong-platform'
      return facts.launchctl ? null : 'not-installed'
    case 'pm2':
      // Deliberately platform-free: pm2 is the answer for a host whose init system this product
      // does not speak (a container, a BSD, a Windows box with pm2 installed), which is exactly
      // the case where refusing on platform would leave the user with nothing.
      return facts.pm2 ? null : 'not-installed'
  }
}

/** Every manager, in `SERVICE_MANAGERS` order, each with whether it works here and why not. */
export function serviceManagerOptions(facts: ServiceManagerFacts): ServiceManagerOption[] {
  return SERVICE_MANAGERS.map(id => {
    const reason = blockFor(id, facts)
    return reason ? { id, available: false, reason } : { id, available: true }
  })
}

export function availableServiceManagers(facts: ServiceManagerFacts): ServiceManagerId[] {
  return serviceManagerOptions(facts).filter(o => o.available).map(o => o.id)
}

/**
 * The one to use when the user did not say: the platform's native manager, pm2 only as a
 * fallback.
 *
 * pm2 never wins by default even when installed. It is a process manager a user chose for their
 * own apps, and quietly filing agentop into someone's pm2 list — where it then appears in every
 * `pm2 ls` and gets caught by their `pm2 restart all` — is a decision that belongs to them.
 */
export function defaultServiceManager(facts: ServiceManagerFacts): ServiceManagerId | null {
  const available = availableServiceManagers(facts)
  if (available.includes('systemd')) return 'systemd'
  if (available.includes('launchd')) return 'launchd'
  return available.includes('pm2') ? 'pm2' : null
}

// ---------------------------------------------------------------------------
// What a service IS
// ---------------------------------------------------------------------------

/**
 * One registration, described in the terms every manager needs.
 *
 * `keepsRunning` is the field this module exists for — see the header. It is a property of the
 * COMMAND, not of the mode: a central started natively holds the terminal while the same central
 * started through Docker returns, so the same `agentop autostart central enable` produces
 * different unit types depending on the runtime the central was configured with.
 */
export interface ServiceSpec {
  /** Unit / label / pm2 process name, e.g. `agentop-central`. */
  name: string
  /** One line for a human, e.g. "agentop central (agentistics autostart)". */
  description: string
  /** The command, already resolved to absolute paths. */
  command: string
  /** True when the command stays in the foreground for as long as the service runs. */
  keepsRunning: boolean
}

/**
 * A systemd USER unit (no root, ever).
 *
 * `Restart=on-failure` is only meaningful for a long-running command; on a oneshot it would re-run
 * `docker compose up -d` after a failed pull, which is a retry loop with no backoff against a
 * registry. The one-shot form leaves restarting to Docker's own `restart: unless-stopped`, which
 * is what actually keeps those containers up.
 */
export function systemdUnit(spec: ServiceSpec, callerPath?: string): string {
  const lines = [
    '[Unit]',
    `Description=${spec.description}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
  ]
  // THE PATH THE HARNESSES LIVE ON. A user service inherits systemd's minimal PATH, and every
  // coding assistant is installed in a per-user bin directory outside it — so without this the
  // server cannot spawn a single one, and every reopen answers `ok` while its pane dies at once.
  // See `sessions/service-path.ts` for the measurement, and for why it is the INSTALLING SHELL's
  // PATH rather than a list of directories guessed here.
  const path = servicePath(callerPath ?? process.env.PATH)
  if (path) {
    lines.push("# systemd's own PATH reaches none of the per-user bin directories the coding")
    lines.push('# assistants are installed in — see sessions/service-path.ts.')
    lines.push(systemdPathLine(path))
  }
  if (spec.keepsRunning) {
    lines.push('Type=simple', `ExecStart=${spec.command}`)
    // THE SESSIONS MUST SURVIVE THE SERVICE. A tmux client started by the server starts the tmux
    // SERVER as its own child when none is running, so the whole fleet lands in this unit's
    // cgroup — and systemd's default `KillMode=control-group` kills a cgroup, not a process. Every
    // stop therefore took the sessions with it: `agentop restart`, and `agentop upgrade`, which
    // restarts each running service onto the new binary. Measured 2026-09-08 on a real machine —
    // seven sessions' last heartbeat at 08:53:17, `Stopping agentop server` at 08:53:31, and a
    // tmux server that had to be born again at 08:59:44 — and reproduced in isolation: a tmux
    // started under a transient unit dies with `KillMode=control-group` and survives under
    // `process`. The user reopened the fleet on their laptop, opened the phone and every session
    // was gone. `process` stops exactly the one process this unit started; a session is not part
    // of the service, it is what the service is FOR.
    lines.push('KillMode=process')
    lines.push('Restart=on-failure', 'RestartSec=5')
  } else {
    // The command RETURNS once the thing it started is up. Without RemainAfterExit the unit is
    // inactive(dead) a second after a perfectly successful start, and every status readout lies.
    lines.push('Type=oneshot', 'RemainAfterExit=yes', `ExecStart=${spec.command}`)
  }
  lines.push('', '[Install]', 'WantedBy=default.target', '')
  return lines.join('\n')
}

/**
 * Bring an ALREADY INSTALLED long-running unit up to the `KillMode=process` rule above.
 *
 * The rule is worthless to the people it exists for unless it reaches the unit already on disk:
 * a machine that hit the bug has the old unit, and nothing rewrites it — `restartAutostart` only
 * ever bounced the service. So this is a MERGE, not a regeneration: the caller's `ExecStart` and
 * the `Environment=PATH` that took a measurement to get right are the very things a regenerated
 * unit could get wrong (the spec cannot always be resolved outside a checkout), so every line the
 * user has is kept and exactly one is inserted.
 *
 * Returns `null` when there is nothing to do — no `[Service]` section, not a `Type=simple` unit
 * (a oneshot's command has already returned; it owns no children to spare), or a `KillMode` that
 * is already stated. An explicit `KillMode` is never overwritten even when it is the default:
 * agentop did not write it, so it is somebody's decision.
 */
export function migrateUnitKillMode(text: string): string | null {
  if (!/^\s*\[Service\]\s*$/m.test(text)) return null
  if (!/^\s*Type\s*=\s*simple\s*$/m.test(text)) return null
  if (/^\s*KillMode\s*=/m.test(text)) return null
  const lines = text.split('\n')
  const at = lines.findIndex(l => /^\s*ExecStart\s*=/.test(l))
  if (at < 0) return null
  lines.splice(at + 1, 0, '# A session is not part of the service — see systemdUnit().', 'KillMode=process')
  return lines.join('\n')
}

/**
 * The `Environment=` line that sets PATH, QUOTED.
 *
 * systemd splits an unquoted `Environment=` value on whitespace, and on WSL the interactive PATH
 * always carries Windows directories with spaces in them (`/mnt/c/Program Files/nodejs`). Written
 * bare, the PATH ended at the first `/mnt/c/Program` and every directory after it — including
 * Windows-installed harnesses — was silently dropped. Inside double quotes systemd honours C-style
 * `\\` and `\"`, and `%` is a specifier everywhere, so all three are escaped.
 */
export function systemdPathLine(path: string): string {
  const escaped = path.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')
  return `Environment="PATH=${escaped}"`
}

/** An `Environment=` line that sets PATH, in any of the shapes a unit may hold it. */
const PATH_ENV_LINE = /^\s*Environment\s*=\s*"?PATH=/
/** The UNQUOTED shape an older agentop wrote — broken the moment the value holds a space. */
const BARE_PATH_ENV_LINE = /^\s*Environment\s*=\s*PATH=(.*)$/

/**
 * Bring an ALREADY INSTALLED long-running unit up to the `Environment=PATH` rule in `systemdUnit`.
 *
 * The rule reached only NEW units, and the migration that runs on restart inserted `KillMode` and
 * nothing else — so a unit written before it kept systemd's minimal PATH forever, across every
 * `agentop upgrade` and `agentop restart`, and every session started from the browser died in the
 * second it was spawned (`claude` was not on the service's PATH; see `sessions/service-path.ts`).
 *
 * Two repairs, both a MERGE in the `migrateUnitKillMode` sense:
 *
 * - NO PATH LINE: insert one from `callerPath`, which must be the PATH of the INTERACTIVE shell
 *   running the restart. `servicePath` returns null for a PATH that adds nothing to systemd's own,
 *   so a restart driven from inside the service itself (whose PATH is the minimal one) is a no-op
 *   rather than a unit that records the very PATH it exists to replace.
 * - AN UNQUOTED PATH LINE WHOSE VALUE HOLDS WHITESPACE: re-quoted as it stands. That line is only
 *   ever agentop's own (systemd truncates it, so nobody wrote it that way on purpose), and the value
 *   on disk is the whole PATH — only systemd's reading of it was cut.
 *
 * Any other PATH line is somebody's decision and is left alone. Returns `null` when there is
 * nothing to do.
 */
export function migrateUnitPath(text: string, callerPath: string | undefined): string | null {
  if (!/^\s*\[Service\]\s*$/m.test(text)) return null
  if (!/^\s*Type\s*=\s*simple\s*$/m.test(text)) return null
  const lines = text.split('\n')
  const existing = lines.findIndex(l => PATH_ENV_LINE.test(l))
  if (existing >= 0) {
    const bare = BARE_PATH_ENV_LINE.exec(lines[existing]!)
    if (!bare || !/\s/.test(bare[1]!.trim())) return null
    lines[existing] = systemdPathLine(bare[1]!.trim())
    return lines.join('\n')
  }
  const path = servicePath(callerPath)
  if (!path) return null
  const at = lines.findIndex(l => /^\s*\[Service\]\s*$/.test(l))
  lines.splice(at + 1, 0,
    "# systemd's own PATH reaches none of the per-user bin directories the coding",
    '# assistants are installed in — see sessions/service-path.ts.',
    systemdPathLine(path),
  )
  return lines.join('\n')
}

/** Reverse-DNS label for a launchd agent, e.g. `com.agentistics.agentop-central`. */
export function launchdLabel(spec: ServiceSpec): string {
  return `com.agentistics.${spec.name}`
}

/** XML-escape a string for a plist `<string>` value. */
function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * A launchd USER agent (`~/Library/LaunchAgents`), the macOS equivalent of the systemd user unit.
 *
 * The command is run through `/bin/sh -c` rather than split into argv. It is composed here from
 * absolute paths and a fixed set of subcommands — never from user input — and the alternative is
 * this module growing a shell tokenizer to take `docker compose -f … up -d` apart, which is more
 * ways to be wrong than it removes.
 *
 * `KeepAlive` follows `keepsRunning` for the same reason `Type` does on systemd: a plist with
 * `KeepAlive` over `docker compose up -d` relaunches it every time it succeeds.
 */
export function launchdPlist(spec: ServiceSpec, opts: { stdoutPath: string; stderrPath: string }): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xml(launchdLabel(spec))}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/bin/sh</string>',
    '    <string>-c</string>',
    `    <string>${xml(spec.command)}</string>`,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    spec.keepsRunning ? '  <true/>' : '  <false/>',
    '  <key>StandardOutPath</key>',
    `  <string>${xml(opts.stdoutPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(opts.stderrPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

/** The relative path of a launchd agent's plist, under the user's home. */
export function launchdPlistName(spec: ServiceSpec): string {
  return `${launchdLabel(spec)}.plist`
}

/**
 * The `pm2 start` argv for a spec.
 *
 * `--no-autorestart` on a returning command is the same correction as `Type=oneshot`: pm2's whole
 * model is "the process died, start it again", which over `docker compose up -d` is an infinite
 * loop that also masks a failing pull as activity.
 */
export function pm2StartArgs(spec: ServiceSpec): string[] {
  const args = ['pm2', 'start', spec.command, '--name', spec.name]
  if (!spec.keepsRunning) args.push('--no-autorestart')
  return args
}

/** The `pm2 delete` argv — the exact inverse of `pm2StartArgs`. */
export function pm2DeleteArgs(spec: ServiceSpec): string[] {
  return ['pm2', 'delete', spec.name]
}

/**
 * What the user still has to do themselves, per manager, for the registration to survive a REBOOT.
 *
 * Enabling a service and making it come back after a power cycle are different acts on every one
 * of these, and each has a step this product cannot take for the user: systemd needs
 * `loginctl enable-linger` (agentop attempts it and reports when it could not), launchd user
 * agents only start at LOGIN and never before it, and pm2 needs `pm2 save` plus the root command
 * `pm2 startup` prints. Saying so is the difference between a service that comes back and a user
 * who believes one will.
 */
export function bootCaveat(id: ServiceManagerId): 'linger' | 'login-only' | 'pm2-startup' {
  switch (id) {
    case 'systemd': return 'linger'
    case 'launchd': return 'login-only'
    case 'pm2': return 'pm2-startup'
  }
}

// ---------------------------------------------------------------------------
// Verifying a restart by what is SERVING
//
// `systemctl restart`'s exit code is a fact about systemd's command queue, not about who answers
// the port. Measured 2026-09-27: with no reachable user bus and a foreground server outside the
// unit, `agentop restart server` printed "Restarted" and the same pid went on serving the old
// code and config. The claim being made is "the thing serving changed", so that is what is
// observed: the pid (or the unit's own MainPID) BEFORE against AFTER, with a bounded wait for the
// new one to answer. Facts in, verdict out — the process table, the port and the clock arrive as
// arguments.
// ---------------------------------------------------------------------------

/** What is serving a mode right now: its pid, and whether it answers. */
export interface ServingObservation {
  pid: number | null
  answering: boolean
}

/** `systemctl --user` could not reach a manager at all (no bus, no systemd, no binary). */
export function managerUnreachable(stderr: string): boolean {
  return /failed to connect to (?:user scope )?bus|has not been booted with systemd|can't operate|host is down|enoent|no medium found/i.test(stderr)
}

/** `systemctl --user show <unit> -p MainPID -p ActiveState`. `MainPID=0` is "no process". */
export function parseUnitShow(out: string): { mainPid: number | null; state: string } {
  const pid = Number(/^MainPID=(\d+)$/m.exec(out)?.[1])
  const state = /^ActiveState=(\S+)$/m.exec(out)?.[1] ?? 'unknown'
  return { mainPid: Number.isInteger(pid) && pid > 0 ? pid : null, state }
}

/** Is `pid` the unit's main process, or a descendant of it (a wrapper script is a real shape)?
 *  Bounded, so a cyclic or hostile process table cannot loop. */
export async function pidUnderUnit(
  pid: number,
  mainPid: number | null,
  parentOf: (pid: number) => Promise<number | null>,
): Promise<boolean> {
  if (mainPid === null) return false
  let at: number | null = pid
  for (let depth = 0; at !== null && at > 1 && depth < 16; depth++) {
    if (at === mainPid) return true
    at = await parentOf(at)
  }
  return false
}

export type RestartVerdict =
  | { kind: 'replaced'; before: number | null; after: number }
  | { kind: 'unchanged'; pid: number }
  | { kind: 'silent'; before: number | null }

/**
 * Observe until a DIFFERENT pid answers, or the bounded time runs out.
 *
 * `unchanged` (the same pid still serving) and `silent` (nothing answering) are told apart because
 * they send the person to different places: the first is a restart that replaced nothing, the
 * second a server that was replaced and never came up. `sleep`/`now` are injected so the bound is
 * testable without a real clock.
 */
export async function awaitReplacement(
  before: ServingObservation,
  observe: () => Promise<ServingObservation>,
  opts: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<RestartVerdict> {
  const timeoutMs = opts.timeoutMs ?? 15_000
  const intervalMs = opts.intervalMs ?? 500
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const now = opts.now ?? Date.now
  const deadline = now() + timeoutMs
  let last: ServingObservation = { pid: null, answering: false }
  for (;;) {
    last = await observe()
    if (last.answering && last.pid !== null && last.pid !== before.pid) {
      return { kind: 'replaced', before: before.pid, after: last.pid }
    }
    if (now() >= deadline) break
    await sleep(intervalMs)
  }
  return last.pid !== null && last.pid === before.pid && before.pid !== null
    ? { kind: 'unchanged', pid: before.pid }
    : { kind: 'silent', before: before.pid }
}
