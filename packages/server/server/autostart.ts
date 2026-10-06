/**
 * autostart — register agentop to start with the system, plus a lightweight
 * terminal/boot update-check hook.
 *
 * THREE managers, chosen by `service-manager.ts`: systemd *user* services on Linux, launchd *user*
 * agents on macOS, and pm2 anywhere it is installed. None of them needs root. macOS used to print
 * a paragraph of manual steps and Windows still does — the difference is that the launchd recipe
 * was already written down in the docs, which means the product knew the answer and made the user
 * transcribe it.
 *
 * The `central` mode is the one with a second dimension: WHICH SHAPE of central this box runs
 * (`central-runtime.ts`). It decides both the command and — through `keepsRunning` — the kind of
 * unit. A native central holds the terminal, so it is a normal long-running service; a Docker one
 * returns as soon as the container is up, and registering THAT as a long-running service produces
 * a unit that reads inactive(dead) one second after a perfectly successful start.
 */

import { homedir, platform, userInfo } from 'os'
import { join, resolve } from 'path'
import { mkdir, writeFile, readFile, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import type { CentralRuntimeId } from './central-runtime'
import { PORT } from './config'
import { isWSL } from './wsl-ports-io'
import {
  formatStatusLines, lingerOutcome, lingerPlan, parseLinger, portHeldVerdict, statusLines,
  autostartRepairPlan, startupScript, startupState, STARTUP_FILE_NAME, type StartupState, wslTaskCreateOutcome, wslTaskIsStale, wslTaskPlan, wslTaskRemoveOutcome, type BusFacts,
} from './autostart-plan'
import { cliStrings, type CliStrings } from './cli-i18n'
import { resolveLang } from './cli-lang'
import {
  availableServiceManagers,
  awaitReplacement,
  managerUnreachable,
  parseUnitShow,
  pidUnderUnit,
  bootCaveat,
  defaultServiceManager,
  launchdPlist,
  launchdPlistName,
  pm2DeleteArgs,
  pm2StartArgs,
  systemdUnit,
  migrateUnitKillMode,
  migrateUnitOOMPolicy,
  migrateUnitRestartGuards,
  migrateUnitPath,
  type RestartVerdict,
  type ServingObservation,
  type ServiceManagerFacts,
  type ServiceManagerId,
  type ServiceSpec,
} from './service-manager'

export type AutostartMode = 'server' | 'central' | 'watch' | 'machine'

export interface AutostartResult {
  ok: boolean
  message: string
}

const MODES: AutostartMode[] = ['server', 'central', 'watch', 'machine']

// --- shell-rc update-check hook markers (kept stable so uninstall is exact) ---
const HOOK_BEGIN = '# >>> agentop update check >>>'
const HOOK_END = '# <<< agentop update check <<<'
// POSIX one-liner — valid in both bash and zsh (the two shells we manage).
const HOOK_LINE = 'command -v agentop >/dev/null 2>&1 && agentop check-update 2>/dev/null'

/** Shell rc files we manage the update-check hook in. Different login shells source
 *  different files (bash → ~/.bashrc, zsh → ~/.zshrc), so a bash-only hook was invisible
 *  to zsh users. We install into whichever of these already exist. */
function hookRcCandidates(): string[] {
  return [join(homedir(), '.bashrc'), join(homedir(), '.zshrc')]
}

/** Pure: append the guarded hook block to rc `content` when absent. Returns null when the
 *  block is already present (idempotent no-op). */
export function addHookBlock(content: string): string | null {
  if (content.includes(HOOK_BEGIN)) return null
  return content + `\n${HOOK_BEGIN}\n${HOOK_LINE}\n${HOOK_END}\n`
}

/** Pure: remove the guarded hook block from rc `content`. Returns null when absent, or
 *  throws when the block is corrupt (a BEGIN with no matching END). */
export function removeHookBlock(content: string): string | null {
  const beginIdx = content.indexOf(HOOK_BEGIN)
  if (beginIdx === -1) return null
  const endIdx = content.indexOf(HOOK_END, beginIdx)
  if (endIdx === -1) throw new Error('corrupt hook block')
  // Consume the newline addHookBlock prepended before BEGIN and the one after END, so this is
  // an exact inverse of addHookBlock (no stray blank line left behind).
  let start = beginIdx
  if (start > 0 && content[start - 1] === '\n') start -= 1
  let end = endIdx + HOOK_END.length
  if (content[end] === '\n') end += 1
  return content.slice(0, start) + content.slice(end)
}

/** ~/.bashrc → "~/.bashrc" for user-facing messages. */
function tildeRc(rc: string): string {
  return rc.replace(homedir(), '~')
}

/**
 * Locate the repo checkout holding `central.sh`, used only by the `central` mode command.
 *
 * The old version derived it as three directories up from `import.meta.dir` and guarded that
 * with a try/catch. `resolve` does not throw, so the guard never fired: under the COMPILED
 * BINARY `import.meta.dir` is Bun's virtual root (`/$bunfs/root`), three up is `/`, and the
 * unit shipped `ExecStart=bash /central.sh up` — a service that exits 127 and is restarted
 * every 5 seconds forever. Existence is the only thing that distinguishes a real checkout from
 * a path that merely parses, so check for the file rather than assuming the layout.
 *
 * Returns null when no candidate holds the script — see `serviceCommandFor`.
 */
function findCentralScript(): string | null {
  const candidates = [
    // Running from source: <repoRoot>/packages/server/server/autostart.ts
    resolve(import.meta.dir, '..', '..', '..'),
    // Compiled binary invoked from inside a checkout.
    process.cwd(),
  ]
  for (const dir of candidates) {
    const script = join(dir, 'central.sh')
    if (existsSync(script)) return script
  }
  return null
}

/**
 * Locate `docker/machine.yml`, the same way `findCentralScript` locates `central.sh` — it
 * only exists in a repo checkout, so a boot unit for the Docker `machine` runtime can only be
 * written from one. Returns null otherwise, which `serviceCommandFor('machine')` turns into a
 * refusal rather than a unit whose `ExecStart` cannot resolve.
 */
function findMachineCompose(): string | null {
  const candidates = [
    resolve(import.meta.dir, '..', '..', '..'),
    process.cwd(),
  ]
  for (const dir of candidates) {
    const compose = join(dir, 'docker', 'machine.yml')
    if (existsSync(compose)) return compose
  }
  return null
}

/**
 * The exact shell command each mode's service should run, or null when this machine cannot run
 * that mode at all. `central` needs `central.sh`, which only exists in a repo checkout; from an
 * installed binary there is nothing to point at. Null means the caller must REFUSE — the same
 * rule the control center applies to a rebuild it cannot perform: absent beats present-and-failing.
 */
export interface ServiceCommandOpts {
  /**
   * For `central`: the shape this box is configured to run.
   *
   * Absent keeps the historical answer exactly — `bash central.sh up` in a checkout — so an
   * existing unit is regenerated as the same unit. Named, it decides both the command and whether
   * the service is long-running.
   */
  centralRuntime?: CentralRuntimeId
}

export function serviceCommandFor(mode: AutostartMode, opts: ServiceCommandOpts = {}): string | null {
  const bin = process.execPath
  switch (mode) {
    case 'server':
      return `${bin} server`
    case 'watch':
      return `${bin} watch`
    case 'central': {
      const script = findCentralScript()
      switch (opts.centralRuntime) {
        case 'native':
          // The binary IS the server on this path, and `central up` runs it in the foreground —
          // which is precisely the shape a service wants.
          return `${bin} central up --native`
        case 'docker-image':
          // `-n` states the answer to central.sh's "re-run interactive setup?" up front. At boot
          // stdin is not a tty so it would not have been asked, but a unit that depends on that
          // accident is a unit that hangs the day someone runs it by hand.
          return `${bin} central up --image -n`
        case 'docker-build':
          return script ? `bash ${script} up -n` : null
        default:
          // Unstated: the checkout wins, exactly as before. Without one, fall through to the
          // published image rather than refusing — `agentop autostart central enable` used to be
          // impossible from an installed binary, which is the ONE configuration where the user has
          // no `central.sh` to write a unit around by hand either.
          return script ? `bash ${script} up` : `${bin} central up -n`
      }
    }
    case 'machine': {
      // No `--build`: the boot-time unit brings back whatever image is already there. A rebuild
      // is a deliberate action (the control center's "Rebuild & restart"), never something that
      // should happen silently every time the machine reboots.
      const compose = findMachineCompose()
      return compose ? `docker compose -f ${compose} up -d` : null
    }
  }
}

/**
 * Does this mode's command stay in the FOREGROUND for as long as the service runs?
 *
 * See `service-manager.ts` — this is the field that decides `Type=simple` versus
 * `Type=oneshot` + `RemainAfterExit=yes`, launchd's `KeepAlive`, and pm2's `--no-autorestart`.
 */
export function serviceKeepsRunning(mode: AutostartMode, opts: ServiceCommandOpts = {}): boolean {
  switch (mode) {
    case 'server':
    case 'watch':
      return true
    case 'machine':
      return false
    case 'central':
      // Only the native central is the process. Both Docker shapes return once the container is up.
      return opts.centralRuntime === 'native'
  }
}

/** The full description of one registration, in the terms every manager needs. */
export function serviceSpecFor(mode: AutostartMode, opts: ServiceCommandOpts = {}): ServiceSpec | null {
  const command = serviceCommandFor(mode, opts)
  if (!command) return null
  return {
    name: `agentop-${mode}`,
    description: `agentop ${mode} (agentistics autostart)`,
    command,
    keepsRunning: serviceKeepsRunning(mode, opts),
    // The server holds a port; a hand-started one makes the unit fail and loop every 5 s.
    ...(mode === 'server' ? { condition: `${process.execPath} autostart guard server` } : {}),
  }
}

/** Which managers this box has. One `--version` probe each, none of them fatal. */
export async function serviceManagerFacts(): Promise<ServiceManagerFacts> {
  const has = async (bin: string) => {
    const res = await run([bin, '--version'])
    return res.code === 0
  }
  const plat = platform()
  return {
    platform: plat,
    // Only probed where it could exist: a `systemctl --version` on macOS is a spawn that always
    // fails, on every status refresh.
    systemctl: plat === 'linux' ? await has('systemctl') : false,
    launchctl: plat === 'darwin' ? existsSync('/bin/launchctl') : false,
    pm2: await has('pm2'),
  }
}

/**
 * The systemd unit that brings a mode back — the name a user has to be given.
 *
 * Exported because "starts at boot" is not an answer anyone can act on: the whole complaint this
 * module grew a `disable` path for was a central that came back with nothing on screen naming what
 * brought it. With the unit named, `systemctl --user status <unit>` answers, `agentop autostart
 * status` answers, and the cockpit's detail pane can print it beside the state.
 */
export function unitName(mode: AutostartMode): string {
  return `agentop-${mode}.service`
}

export function unitPath(mode: AutostartMode): string {
  return join(homedir(), '.config', 'systemd', 'user', unitName(mode))
}

/** The unit text, composed by `service-manager.ts` so the Type/RemainAfterExit rule lives in one
 *  tested place rather than being restated per manager. */
function unitContents(spec: ServiceSpec): string {
  return systemdUnit(spec)
}

/**
 * Runs a command, capturing stdout/stderr. Never throws — a non-zero exit or a
 * missing binary is reported through the returned object.
 */
async function run(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    return { code, stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (err: any) {
    return { code: 127, stdout: '', stderr: err?.message ?? String(err) }
  }
}

function notSupported(action: string): AutostartResult {
  const plat = platform()
  if (plat === 'darwin') {
    return {
      ok: false,
      message:
        `autostart is not yet supported on macOS.\n` +
        `Manual step: create a launchd agent that runs "${serviceCommandFor('server')}" ` +
        `(a plist under ~/Library/LaunchAgents with RunAtLoad=true), then ` +
        `\`launchctl load\` it. See https://www.launchd.info for details.`,
    }
  }
  if (plat === 'win32') {
    return {
      ok: false,
      message:
        `autostart is not yet supported on Windows.\n` +
        `Manual step: register a Task Scheduler task (or a Startup-folder shortcut) ` +
        `that runs "${serviceCommandFor('server')}" at logon.`,
    }
  }
  return {
    ok: false,
    message: `autostart (${action}) is not supported on this platform (${plat}).`,
  }
}

/**
 * Appends a single guarded line to each present shell rc (~/.bashrc and ~/.zshrc) that runs
 * `agentop check-update` on every terminal open (and thus at boot for login shells). Installs
 * into whichever candidates already exist; if NEITHER exists, creates ~/.bashrc as the default.
 * Idempotent per file.
 */
export async function installUpdateHook(): Promise<AutostartResult> {
  const candidates = hookRcCandidates()
  const present: string[] = []
  for (const rc of candidates) {
    try { await readFile(rc, 'utf8'); present.push(rc) } catch { /* missing */ }
  }
  // If the user has neither rc yet, seed ~/.bashrc (the historical default).
  const targets = present.length ? present : [join(homedir(), '.bashrc')]

  const touched: string[] = []
  for (const rc of targets) {
    let existing = ''
    try { existing = await readFile(rc, 'utf8') } catch { existing = '' }
    const next = addHookBlock(existing)
    if (next === null) { touched.push(`${tildeRc(rc)} (already present)`); continue }
    try {
      await writeFile(rc, next, 'utf8')
      touched.push(tildeRc(rc))
    } catch (err: any) {
      return { ok: false, message: `Could not write ${tildeRc(rc)}: ${err?.message ?? err}` }
    }
  }
  return { ok: true, message: `Update-check hook ensured in: ${touched.join(', ')}.` }
}

/** Removes the guarded update-check block from every present shell rc (exact marker match). */
export async function uninstallUpdateHook(): Promise<AutostartResult> {
  const candidates = hookRcCandidates()
  const removedFrom: string[] = []
  for (const rc of candidates) {
    let existing = ''
    try { existing = await readFile(rc, 'utf8') } catch { continue /* no such rc */ }
    let next: string | null
    try {
      next = removeHookBlock(existing)
    } catch {
      return { ok: false, message: `${tildeRc(rc)} has a corrupt hook block — remove it manually.` }
    }
    if (next === null) continue // not present in this file
    try {
      await writeFile(rc, next, 'utf8')
      removedFrom.push(tildeRc(rc))
    } catch (err: any) {
      return { ok: false, message: `Could not write ${tildeRc(rc)}: ${err?.message ?? err}` }
    }
  }
  return removedFrom.length
    ? { ok: true, message: `Removed update-check hook from: ${removedFrom.join(', ')}.` }
    : { ok: true, message: 'Update-check hook not present in any shell rc — nothing to remove.' }
}

/** Where a launchd agent's plist lives, and where its output goes. */
function launchdPaths(spec: ServiceSpec) {
  return {
    plist: join(homedir(), 'Library', 'LaunchAgents', launchdPlistName(spec)),
    stdout: join(homedir(), '.agentistics', `${spec.name}.log`),
    stderr: join(homedir(), '.agentistics', `${spec.name}.err`),
  }
}

/** The LaunchAgent path shared by autostart and upgrade restart/rollback. */
export function launchdPlistPath(mode: AutostartMode): string {
  return join(homedir(), 'Library', 'LaunchAgents', `com.agentistics.agentop-${mode}.plist`)
}

/** The sentence naming what the user must still do for a REBOOT to bring this back. */
function bootCaveatText(id: ServiceManagerId, spec: ServiceSpec): string {
  switch (bootCaveat(id)) {
    case 'linger':
      return '' // handled inline: agentop attempts `loginctl enable-linger` and reports the result.
    case 'login-only':
      return 'Note: a launchd USER agent starts when you log in, not at boot. For a service that ' +
        'runs with no one logged in, install it as a LaunchDaemon under /Library/LaunchDaemons ' +
        '(that needs root).'
    case 'pm2-startup':
      return `Note: pm2 does not survive a reboot on its own. Run \`pm2 save\`, then \`pm2 startup\` ` +
        'and execute the command it prints (it needs root once).'
  }
}

export interface AutostartOptions {
  /** Which init system to register with. Defaults to the platform's own; pm2 never by default. */
  manager?: ServiceManagerId
  /** For `central`: the shape it runs as. Decides the command AND the unit type. */
  centralRuntime?: CentralRuntimeId
}

/** Refusal shared by every manager: this box cannot run this mode at all. */
function cannotResolve(mode: AutostartMode): AutostartResult {
  const missing = mode === 'machine' ? 'docker/machine.yml' : 'central.sh'
  return {
    ok: false,
    message: `Cannot enable agentop-${mode} here: ${missing} was not found. ` +
      `That file lives in the repository checkout, so run this from one ` +
      `(the installed binary has nothing to point the service at).`,
  }
}

/** Enables an agentop autostart service for the given mode, on whichever manager fits. */
export async function enableAutostart(mode: AutostartMode, opts: AutostartOptions = {}): Promise<AutostartResult> {
  const facts = await serviceManagerFacts()
  const manager = opts.manager ?? defaultServiceManager(facts)
  if (!manager) return notSupported('enable')
  if (opts.manager && !availableServiceManagers(facts).includes(opts.manager)) {
    return {
      ok: false,
      message: opts.manager === 'pm2'
        ? 'pm2 is not installed — `npm install -g pm2`, then run this again.'
        : `${opts.manager} is not available on this machine (${facts.platform}).`,
    }
  }

  // Refuse before writing anything. A unit whose ExecStart cannot resolve is not a partial
  // success — it is a service the manager retries every few seconds for the life of the machine.
  const spec = serviceSpecFor(mode, opts)
  if (!spec) return cannotResolve(mode)

  switch (manager) {
    case 'systemd': return enableSystemd(mode, spec)
    case 'launchd': return enableLaunchd(spec)
    case 'pm2': return enablePm2(spec)
  }
}

/** What the user bus looks like right now. Reads only. */
async function readBusFacts(exec: Exec = run): Promise<BusFacts> {
  const user = userInfo().username
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? ''}`
  const l = await exec(['loginctl', 'show-user', user, '-p', 'Linger'])
  return { busSocket: existsSync(join(runtimeDir, 'bus')), linger: l.code === 0 ? parseLinger(l.stdout) : 'unknown' }
}

/** The distro `wsl.exe` must boot, or undefined outside WSL. */
function wslDistro(): string | undefined {
  return process.env.WSL_DISTRO_NAME
}

async function enableSystemd(mode: AutostartMode, spec: ServiceSpec): Promise<AutostartResult> {
  const user = userInfo().username
  const lines: string[] = []

  // LINGER FIRST. Without it there is no user bus, and every `systemctl --user` below fails with
  // "Failed to connect to bus" — which used to print a failure and then, for the unit file already
  // written, carry on as if autostart existed. A refusal here stops the whole enable.
  const plan = lingerPlan(await readBusFacts(), user)
  const ran = plan.action === 'enable-linger' ? await run(plan.argv) : null
  const linger = lingerOutcome(plan, ran, user)
  if (!linger.active) return { ok: false, message: linger.message }
  if (linger.message) lines.push(linger.message)

  const path = unitPath(mode)
  try {
    await mkdir(join(homedir(), '.config', 'systemd', 'user'), { recursive: true })
    await writeFile(path, unitContents(spec), 'utf8')
  } catch (err: any) {
    return { ok: false, message: `Could not write unit file ${path}: ${err?.message ?? err}` }
  }
  lines.push(`Wrote ${path}`)

  const reload = await run(['systemctl', '--user', 'daemon-reload'])
  if (reload.code !== 0) {
    lines.push(`systemctl --user daemon-reload failed: ${reload.stderr || `exit ${reload.code}`}`)
    return { ok: false, message: lines.join('\n') }
  }

  const enable = await run(['systemctl', '--user', 'enable', '--now', `agentop-${mode}`])
  if (enable.code !== 0) {
    lines.push(`systemctl --user enable --now agentop-${mode} failed: ${enable.stderr || `exit ${enable.code}`}`)
    return { ok: false, message: lines.join('\n') }
  }
  lines.push(`Enabled and started agentop-${mode}.`)

  // WSL: Windows does not start the distro at logon, so the unit never gets its chance.
  let ok = true
  if (isWSL()) {
    const distro = wslDistro()
    const v = distro ? await installLogonEntry(distro) : { ok: false, message: wslTaskPlan(distro).ok ? '' : (wslTaskPlan(distro) as { reason: string }).reason }
    ok = v.ok
    lines.push(v.message)
  }

  const hook = await installUpdateHook()
  lines.push(hook.message)

  return { ok, message: lines.join('\n') }
}

/**
 * `agentop autostart guard server` — the unit's `ExecCondition`. Exit 0 = start; exit 1 = skip
 * quietly (systemd does not count it as a failure, so `Restart=on-failure` never loops).
 */
export async function guardServerStart(): Promise<number> {
  const pid = await listenerPid(PORT, run)
  const verdict = portHeldVerdict(PORT, pid)
  if (verdict.run) return 0
  process.stdout.write(verdict.message + '\n')
  return 1
}

/**
 * macOS: a launchd USER agent under ~/Library/LaunchAgents.
 *
 * `bootstrap gui/<uid>` is the modern verb; `load` is deprecated and silently does nothing on
 * recent macOS for an agent already bootstrapped. Both are attempted, in that order, and a failure
 * of the second is not reported as a failure of the whole — the plist is written either way, and
 * it takes effect at the next login regardless.
 */
async function enableLaunchd(spec: ServiceSpec): Promise<AutostartResult> {
  const paths = launchdPaths(spec)
  try {
    await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
    await mkdir(join(homedir(), '.agentistics'), { recursive: true })
    await writeFile(paths.plist, launchdPlist(spec, { stdoutPath: paths.stdout, stderrPath: paths.stderr }), 'utf8')
  } catch (err: any) {
    return { ok: false, message: `Could not write ${paths.plist}: ${err?.message ?? err}` }
  }

  const lines = [`Wrote ${paths.plist}`]
  const uid = String(process.getuid?.() ?? '')
  const boot = await run(['launchctl', 'bootstrap', `gui/${uid}`, paths.plist])
  if (boot.code === 0) {
    lines.push(`Loaded ${launchdPlistName(spec)} — it starts at every login, and now.`)
  } else {
    const legacy = await run(['launchctl', 'load', '-w', paths.plist])
    lines.push(legacy.code === 0
      ? `Loaded ${launchdPlistName(spec)} — it starts at every login, and now.`
      : `Wrote the agent, but launchctl would not load it now (${boot.stderr || `exit ${boot.code}`}). ` +
        'It still takes effect at your next login.')
  }
  lines.push(`Logs: ${paths.stdout}`)
  lines.push(bootCaveatText('launchd', spec))

  const hook = await installUpdateHook()
  lines.push(hook.message)
  return { ok: true, message: lines.filter(Boolean).join('\n') }
}

/** pm2: explicit opt-in, on any platform that has it. */
async function enablePm2(spec: ServiceSpec): Promise<AutostartResult> {
  const res = await run(pm2StartArgs(spec))
  if (res.code !== 0) {
    return { ok: false, message: `pm2 start failed: ${res.stderr || res.stdout || `exit ${res.code}`}` }
  }
  const lines = [
    `Started ${spec.name} under pm2.`,
    bootCaveatText('pm2', spec),
  ]
  const hook = await installUpdateHook()
  lines.push(hook.message)
  return { ok: true, message: lines.filter(Boolean).join('\n') }
}

/**
 * Options for `disableAutostart`.
 *
 * `stop` is the whole of it, and it exists because the two callers mean genuinely different things.
 * `agentop autostart <mode> disable` has always meant "turn this service off, now and forever", and
 * changing that under people scripting it would be a silent behaviour change. The control center's
 * boot switch means only "do not bring it back", and a switch that also killed the running service
 * would be two actions behind one label — the cockpit has a `Stop` verb for the other one, sitting
 * two cells away on the same row.
 */
export interface DisableOptions {
  /** Also stop it right now (`--now`). Default true, which is what the CLI has always done. */
  stop?: boolean
}

/** Disables and removes an agentop autostart service for the given mode. */
export async function disableAutostart(
  mode: AutostartMode,
  opts: DisableOptions & AutostartOptions = {},
): Promise<AutostartResult> {
  const facts = await serviceManagerFacts()
  const manager = opts.manager ?? defaultServiceManager(facts)
  if (!manager) return notSupported('disable')
  if (manager === 'launchd') return disableLaunchd(mode, opts)
  if (manager === 'pm2') return disablePm2(mode)

  const stop = opts.stop ?? true
  const lines: string[] = []
  const argv = stop
    ? ['systemctl', '--user', 'disable', '--now', `agentop-${mode}`]
    : ['systemctl', '--user', 'disable', `agentop-${mode}`]
  const disable = await run(argv)
  if (disable.code === 0) {
    lines.push(stop
      ? `Disabled and stopped agentop-${mode}.`
      : `Disabled agentop-${mode} — it will not start at boot. Anything running now keeps running.`)
  } else {
    lines.push(`${argv.slice(0, -1).join(' ')} agentop-${mode}: ${disable.stderr || `exit ${disable.code}`}`)
  }

  const path = unitPath(mode)
  try {
    await unlink(path)
    lines.push(`Removed ${path}`)
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      lines.push(`No unit file at ${path}.`)
    } else {
      lines.push(`Could not remove ${path}: ${err?.message ?? err}`)
    }
  }

  await run(['systemctl', '--user', 'daemon-reload'])

  // The Windows logon task is shared by every mode (it only boots the distro), so it goes when the
  // LAST agentop unit goes — removing it while another mode still relies on it would break that one.
  if (isWSL() && !(await anyUnitInstalled())) {
    const task = wslTaskPlan(wslDistro())
    if (task.ok) {
      const res = await run(task.remove)
      lines.push(wslTaskRemoveOutcome(task.name, res.code, res.stderr).message)
    }
    const gone = await removeStartupEntry()
    if (gone) lines.push(gone)
  }
  return { ok: true, message: lines.join('\n') }
}

async function anyUnitInstalled(): Promise<boolean> {
  for (const m of MODES) if (existsSync(unitPath(m))) return true
  return false
}

/**
 * The launchd inverse: unload the agent, then remove its plist.
 *
 * `bootout` is the modern verb and `unload` the deprecated one, tried in that order — the same
 * pairing `enableLaunchd` uses, for the same reason. Removing the plist is what makes it not come
 * back; failing to unload only means it keeps running until the next logout, which is stated
 * rather than reported as success.
 */
async function disableLaunchd(mode: AutostartMode, opts: DisableOptions): Promise<AutostartResult> {
  const spec = serviceSpecFor(mode, opts as AutostartOptions)
  // A registration can be removed even when its command no longer resolves (the checkout moved),
  // so fall back to the bare name rather than refusing to clean up.
  const name = spec?.name ?? `agentop-${mode}`
  const plistName = `com.agentistics.${name}.plist`
  const plist = join(homedir(), 'Library', 'LaunchAgents', plistName)
  const lines: string[] = []

  if (opts.stop ?? true) {
    const uid = String(process.getuid?.() ?? '')
    const out = await run(['launchctl', 'bootout', `gui/${uid}/com.agentistics.${name}`])
    if (out.code !== 0) await run(['launchctl', 'unload', '-w', plist])
  }

  try {
    await unlink(plist)
    lines.push(`Removed ${plist} — it will not start at login any more.`)
  } catch (err: any) {
    lines.push(err?.code === 'ENOENT'
      ? `No launchd agent at ${plist}.`
      : `Could not remove ${plist}: ${err?.message ?? err}`)
  }
  return { ok: true, message: lines.join('\n') }
}

/** The pm2 inverse: `pm2 delete`. `pm2 save` is the user's to run — see `bootCaveat`. */
async function disablePm2(mode: AutostartMode): Promise<AutostartResult> {
  const name = `agentop-${mode}`
  const res = await run(pm2DeleteArgs({ name, description: '', command: '', keepsRunning: true }))
  if (res.code !== 0) {
    return { ok: true, message: `pm2 had no process named ${name} (${res.stderr || `exit ${res.code}`}).` }
  }
  return {
    ok: true,
    message: `Deleted ${name} from pm2.\nRun \`pm2 save\` so the removal survives a reboot.`,
  }
}

/**
 * Restarts an agentop mode so it picks up new code (after an upgrade or a local change) or a
 * changed config. Only meaningful when the mode runs as a systemd user service — a foreground
 * `agentop server` has no service to bounce. `central` is redirected to `agentop central restart`
 * (that path rebuilds/restarts the Docker service, which a systemctl bounce can't do).
 */
/** Is `mode` installed as a systemd user unit? The one fact that decides whether a restart goes
 *  through systemd or through the detached process the control center starts. */
export async function unitInstalled(mode: AutostartMode): Promise<boolean> {
  if (platform() !== 'linux') return false
  try {
    await readFile(unitPath(mode), 'utf8')
    return true
  } catch {
    return false
  }
}

/** The seams `restartAutostart` reads the machine through, so a test can stand in a service manager
 *  and a process table and never run a real `systemctl` against the live server. */
export interface RestartDeps {
  run?: (cmd: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
  /** What is serving `mode` right now. Default: the listener on the port (server) or the unit's own
   *  MainPID (watch). */
  observe?: (mode: AutostartMode) => Promise<ServingObservation>
  /** Parent of a pid, for "is this process under the unit". Default: `/proc/<pid>/stat`. */
  parentOf?: (pid: number) => Promise<number | null>
  strings?: CliStrings
  /** Where the unit files live. Default `~/.config/systemd/user`; a test points it at a temp dir. */
  unitDir?: string
  timeoutMs?: number
  intervalMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Seconds waited so far on an unanswered tick; absent = print nothing. */
  onWait?: (elapsedSec: number) => void
  /** Take back a server running outside the unit (default `reclaimStrayServer`). */
  reclaim?: () => Promise<import('./server-ownership-io.ts').ReclaimResult>
  /** The version this restart should bring up; a server answering it counts as replaced. */
  wantVersion?: string
}

export type Exec = NonNullable<RestartDeps['run']>

/** The pid listening on `port`, by `lsof`, falling back to `ss` where lsof is not installed. */
export async function listenerPid(port: number, exec: Exec): Promise<number | null> {
  const lsof = await exec(['lsof', '-ti', `tcp:${port}`, '-sTCP:LISTEN'])
  const fromLsof = Number(lsof.stdout.split(/\s+/).filter(Boolean)[0])
  if (Number.isInteger(fromLsof) && fromLsof > 0) return fromLsof
  if (lsof.code !== 127) return null
  const ss = await exec(['ss', '-H', '-ltnp', `sport = :${port}`])
  const fromSs = Number(/pid=(\d+)/.exec(ss.stdout)?.[1])
  return Number.isInteger(fromSs) && fromSs > 0 ? fromSs : null
}

async function unitFacts(mode: AutostartMode, exec: Exec) {
  const r = await exec(['systemctl', '--user', 'show', `agentop-${mode}`, '-p', 'MainPID', '-p', 'ActiveState'])
  return { ...r, ...parseUnitShow(r.stdout) }
}

/** What is serving `mode`: the server by its port, everything else by the unit's own process. */
async function observeServing(mode: AutostartMode, exec: Exec): Promise<ServingObservation> {
  if (mode === 'server') {
    const pid = await listenerPid(PORT, exec)
    // Ask the PORT, not only the pid: where lsof/ss cannot name the listener `pid` is null while the
    // server answers perfectly well, and the version it reports is the better proof anyway.
    let answering = false
    let version: string | null = null
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/version`, { signal: AbortSignal.timeout(3_000) })
      answering = res.ok
      const body = await res.json().catch(() => null) as { current?: unknown } | null
      if (typeof body?.current === 'string') version = body.current
    } catch { /* not answering this tick */ }
    return { pid, answering, version }
  }
  const u = await unitFacts(mode, exec)
  return { pid: u.mainPid, answering: u.state === 'active' && u.mainPid !== null }
}

async function procParent(pid: number): Promise<number | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const ppid = Number(/\)\s+\S+\s+(\d+)/.exec(stat)?.[1])
    return Number.isInteger(ppid) ? ppid : null
  } catch {
    return null
  }
}

/** The one sentence a verdict earns — never "Restarted" for anything but a replaced process. */
function verdictMessage(v: RestartVerdict, unit: string, subject: string, t: CliStrings): AutostartResult {
  if (v.kind === 'replaced') {
    if (v.byVersion && (v.after === null || v.after === v.before)) {
      return { ok: true, message: t.restartConfirmedByVersion(unit, v.byVersion) }
    }
    if (v.after === null) return { ok: true, message: t.restartConfirmedByVersion(unit, v.byVersion ?? '?') }
    return {
      ok: true,
      message: v.before === null ? t.restartStarted(unit, v.after) : t.restartRestarted(unit, v.before, v.after),
    }
  }
  if (v.kind === 'unchanged') return { ok: false, message: t.restartUnchanged(unit, subject, v.pid) }
  return { ok: false, message: t.restartSilent(unit, subject) }
}

export async function restartAutostart(mode: AutostartMode, deps: RestartDeps = {}): Promise<AutostartResult> {
  const exec: Exec = deps.run ?? run
  const unitFile = deps.unitDir ? join(deps.unitDir, unitName(mode)) : unitPath(mode)
  if (platform() !== 'linux') return notSupported('restart')

  if (mode === 'central') {
    return {
      ok: false,
      message:
        'The central runs in Docker, not as a systemd service.\n' +
        'Use `agentop central restart` to bounce it, or `agentop central up` to rebuild it after a code change.',
    }
  }

  // A restart only makes sense when the mode is installed as a service.
  let unitExists = true
  let unitText = ''
  try {
    unitText = await readFile(unitFile, 'utf8')
  } catch {
    unitExists = false
  }
  if (!unitExists) {
    return {
      ok: false,
      message:
        `No agentop-${mode} service is installed, so there is nothing to restart.\n` +
        `Run it in the foreground with \`agentop ${mode}\`, or install autostart first ` +
        `with \`agentop autostart ${mode} enable\`.`,
    }
  }

  // ASK THE MANAGER, AND LOOK AT WHAT IS SERVING, BEFORE TOUCHING ANYTHING. `systemctl restart`
  // exiting 0 is not a restart: with no reachable user bus, or a server that is running outside the
  // unit (a foreground `agentop server`), it changes nothing — and once reported "Restarted" while
  // the same pid went on serving the old code. So the two ways a restart cannot work are refused
  // here, in a sentence naming the cause, before a unit file is written or a process disturbed.
  // Nothing agentop did not start is ever killed: the person is told the command instead.
  const t = deps.strings ?? cliStrings(await resolveLang())
  const unit = `agentop-${mode}`
  const facts = await unitFacts(mode, exec)
  if (facts.code !== 0) {
    return { ok: false, message: t.restartManagerUnreachable(unit, facts.stderr || `exit ${facts.code}`) }
  }
  const observe = deps.observe ?? ((m: AutostartMode) => observeServing(m, exec))
  // `machine` is a oneshot that runs `docker compose up -d`: no pid of its own to compare.
  const verifiable = mode === 'server' || mode === 'watch'
  let before: ServingObservation = verifiable ? await observe(mode) : { pid: null, answering: false }
  const reclaimNotes: string[] = []
  if (mode === 'server' && before.pid !== null) {
    const owned = await pidUnderUnit(before.pid, facts.mainPid, deps.parentOf ?? procParent)
    if (!owned) {
      // A server OUTSIDE the unit is taken back when it is provably this data dir's own (it holds
      // our lock and its argv is `agentop server`, `server-ownership.ts`) — the unit is the owner,
      // and refusing here is what left a machine on the old version for two hours (2026-10-04).
      // Anything that cannot be proven ours is still only reported.
      const reclaim = deps.reclaim ?? (async () => (await import('./server-ownership-io.ts')).reclaimStrayServer())
      const r = await reclaim()
      if (r.kind !== 'reclaimed' || r.pid !== before.pid) {
        return { ok: false, message: t.restartNotManaged(`the server on :${PORT}`, before.pid, unit, facts.state) }
      }
      reclaimNotes.push(`Stopped agentop server pid ${r.pid}, which ran outside ${unit} and held the data directory.`)
      before = { pid: null, answering: false }
    }
  }
  const subject = mode === 'server' ? `the server on :${PORT}` : unit

  // MIGRATE BEFORE BOUNCING, and reload before either. A unit written before `KillMode=process`
  // kills its whole cgroup on stop, which is the fleet — so a restart on the old unit is the very
  // event that loses the sessions, and migrating afterwards would fix the machine one crash too
  // late. `daemon-reload` first means the stop that follows already runs under the new rule, so
  // even THIS restart spares them.
  //
  // The PATH repair rides the same write. It reads THIS process's PATH, which is the interactive
  // shell's for `agentop restart` / `agentop upgrade` / the cockpit — and is skipped outright when
  // this process is itself a systemd service (`INVOCATION_ID`), whose PATH is the minimal one the
  // repair exists to replace. See `migrateUnitPath`.
  const notes: string[] = [...reclaimNotes]
  const done: string[] = []
  let next = unitText
  const killMode = migrateUnitKillMode(next)
  if (killMode) { next = killMode; done.push('a restart no longer stops your sessions') }
  const oom = migrateUnitOOMPolicy(next)
  if (oom) { next = oom; done.push('a session running out of memory no longer stops the server') }
  const guards = migrateUnitRestartGuards(next)
  if (guards) { next = guards; done.push('a refused start can no longer turn into a restart loop') }
  const pathFixed = process.env.INVOCATION_ID ? null : migrateUnitPath(next, process.env.PATH)
  if (pathFixed) { next = pathFixed; done.push('sessions it starts can find the coding assistants on your PATH') }
  if (next !== unitText) {
    try {
      await writeFile(unitFile, next, 'utf8')
      const reload = await exec(['systemctl', '--user', 'daemon-reload'])
      if (reload.code === 0) notes.push(`Updated the unit so ${done.join(', and ')}.`)
      else notes.push(`Updated the unit, but systemctl --user daemon-reload failed: ${reload.stderr || `exit ${reload.code}`}`)
    } catch (err: any) {
      notes.push(`Could not update ${unitFile}: ${err?.message ?? err}`)
    }
  }

  // A unit left `failed` by a refused start (exit 75 behind `RestartPreventExitStatus`) has spent
  // its start budget too; clearing it first is what lets this restart actually happen.
  await exec(['systemctl', '--user', 'reset-failed', `agentop-${mode}`])
  const res = await exec(['systemctl', '--user', 'restart', `agentop-${mode}`])
  if (res.code !== 0) {
    return {
      ok: false,
      message: [...notes, `systemctl --user restart agentop-${mode} failed: ${res.stderr || `exit ${res.code}`}`].join('\n'),
    }
  }
  if (!verifiable) {
    return {
      ok: true,
      message: [...notes, `Restarted agentop-${mode} — it now runs the current code and config.`].join('\n'),
    }
  }
  // The exit code said the OS accepted the command. What was CLAIMED is that the thing serving
  // changed, so that is what is observed — the pid before against the pid after, with a bounded
  // wait for the new one to answer.
  const verdict = await awaitReplacement(before, () => observe(mode), {
    timeoutMs: deps.timeoutMs, intervalMs: deps.intervalMs, sleep: deps.sleep, now: deps.now,
    ...(deps.onWait ? { onWait: deps.onWait } : {}),
    ...(deps.wantVersion ? { wantVersion: deps.wantVersion } : {}),
  })
  const outcome = verdictMessage(verdict, unit, subject, t)
  return { ok: outcome.ok, message: [...notes, outcome.message].join('\n') }
}

/**
 * Reports the enabled/active status of one or all agentop autostart services.
 *
 * It states WHAT each enabled unit runs, and it says the consequence in a sentence. `enabled=enabled,
 * active=inactive` is the exact shape of the bug people report — a central that is not running right
 * now and comes back anyway — and read as two words it looks like nothing is wrong. The unit is the
 * thing that brings it back; the sentence and the `ExecStart` are what make that discoverable
 * without reading systemd's manual.
 */
export async function autostartStatus(mode?: AutostartMode): Promise<AutostartResult> {
  if (platform() !== 'linux') return notSupported('status')

  const targets = mode ? [mode] : MODES
  const lines: string[] = []
  for (const m of targets) {
    const enabled = await run(['systemctl', '--user', 'is-enabled', `agentop-${m}`])
    const active = await run(['systemctl', '--user', 'is-active', `agentop-${m}`])
    // systemctl prints the state to stdout even on non-zero exit.
    const enabledState = enabled.stdout || enabled.stderr || 'unknown'
    const activeState = active.stdout || active.stderr || 'unknown'
    lines.push(`${unitName(m)}: enabled=${enabledState}, active=${activeState}`)
    // Only for a unit that is actually registered: reading the ExecStart of a unit that does not
    // exist would print an empty promise about a mechanism that is not installed.
    if (enabledState.startsWith('enabled') || enabledState.startsWith('linked')) {
      const exec = await run(['systemctl', '--user', 'show', `agentop-${m}`, '-p', 'ExecStart', '--value'])
      const cmd = exec.stdout.match(/argv\[\]=([^;]+);/)?.[1]?.trim()
      lines.push(`  → comes back at boot${cmd ? `, running: ${cmd}` : ''}`)
      lines.push(`  → \`agentop autostart ${m} disable\` removes it`)
    }
  }
  // The prerequisites, each with its fix: linger, the bus, the unit and (WSL) the logon task.
  if (!mode || mode === 'server') {
    const bus = await readBusFacts()
    const u = await run(['systemctl', '--user', 'is-active', 'agentop-server'])
    const e = await run(['systemctl', '--user', 'is-enabled', 'agentop-server'])
    let wsl: { distro: string | undefined; taskPresent: boolean | null; startup?: StartupState | null } | null = null
    if (isWSL()) {
      const task = wslTaskPlan(wslDistro())
      let present: boolean | null = null
      if (task.ok) {
        const q = await run(task.query)
        present = q.code === 0 ? true : q.code === 127 ? null : false
      }
      const d = wslDistro()
      wsl = { distro: d, taskPresent: present, startup: d ? await readStartupState(d) : null }
    }
    lines.push('', formatStatusLines(statusLines({
      ...bus, user: userInfo().username, unitActive: u.stdout, unitEnabled: e.stdout, wsl,
    })))
  }
  return { ok: true, message: lines.join('\n') }
}

/** The user's Windows Startup folder as a WSL path, or null when interop cannot answer. */
async function windowsStartupDir(): Promise<string | null> {
  const appdata = await run(['cmd.exe', '/c', 'echo %APPDATA%'])
  const win = appdata.code === 0 ? appdata.stdout.trim().replace(/\r/g, '') : ''
  if (!win || win.includes('%')) return null
  const mapped = await run(['wslpath', '-u', win])
  const root = mapped.code === 0 ? mapped.stdout.trim() : ''
  return root ? join(root, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup') : null
}

async function readStartupState(distro: string): Promise<StartupState | null> {
  const dir = await windowsStartupDir()
  if (!dir) return null
  const text = await readFile(join(dir, STARTUP_FILE_NAME), 'utf8').catch(() => null)
  return startupState(text, distro)
}

/**
 * Register the logon entry that keeps the distro alive: the scheduled task first, and when Windows
 * refuses it (no admin on a company PC) the hidden Startup-folder script. Returns the one line to show.
 */
async function installLogonEntry(distro: string): Promise<{ ok: boolean; message: string }> {
  const task = wslTaskPlan(distro)
  if (!task.ok) return { ok: false, message: task.reason }
  const res = await run(task.create)
  const v = wslTaskCreateOutcome(task.name, res.code, res.stderr)
  if (v.ok) return v
  const dir = await windowsStartupDir()
  if (!dir) return v
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, STARTUP_FILE_NAME), startupScript(distro))
    return { ok: true, message: `Windows refused the logon task, so ${STARTUP_FILE_NAME} was put in your Startup folder — logging in boots this distro and keeps it running.` }
  } catch (err: any) {
    return { ok: false, message: `${v.message} The Startup-folder fallback failed too: ${err?.message ?? err}` }
  }
}

/** Removes both Windows logon mechanisms (task + Startup script). Idempotent; one line per thing removed or refused. */
export async function removeWslLogonEntries(): Promise<string[]> {
  if (platform() !== 'linux' || !isWSL()) return []
  const lines: string[] = []
  const task = wslTaskPlan(wslDistro())
  if (task.ok) {
    const res = await run(task.remove)
    const v = wslTaskRemoveOutcome(task.name, res.code, res.stderr)
    if (!v.ok || res.code === 0) lines.push(v.message)
  }
  const gone = await removeStartupEntry()
  if (gone) lines.push(gone)
  return lines
}

async function removeStartupEntry(): Promise<string | null> {
  const dir = await windowsStartupDir()
  if (!dir || !existsSync(join(dir, STARTUP_FILE_NAME))) return null
  await unlink(join(dir, STARTUP_FILE_NAME)).catch(() => {})
  return `Removed ${STARTUP_FILE_NAME} from the Windows Startup folder.`
}

/**
 * `agentop upgrade`'s autostart check on WSL: repair what is missing or stale, say so in ONE line.
 * Returns '' when nothing was needed or this is not WSL. The decision is the pure
 * `autostartRepairPlan`; this only gathers its facts and executes the answer.
 */
export async function repairWslAutostart(opts: { enableIfMissing?: boolean } = { enableIfMissing: true }): Promise<string> {
  if (platform() !== 'linux' || !isWSL()) return ''
  const task = wslTaskPlan(wslDistro())
  if (!task.ok) return ''
  const enabled = await run(['systemctl', '--user', 'is-enabled', 'agentop-server'])
  const unitEnabled = enabled.stdout.trim().startsWith('enabled') || enabled.stdout.trim().startsWith('linked')
  let taskPresent: boolean | null = null
  let taskStale = false
  const startup = await readStartupState(wslDistro()!)
  if (unitEnabled) {
    const q = await run(task.queryVerbose)
    taskPresent = q.code === 0 ? true : q.code === 127 ? null : false
    taskStale = q.code === 0 && wslTaskIsStale(q.stdout)
  }
  const plan = autostartRepairPlan({ wsl: true, unitEnabled, taskPresent, taskStale, startup })
  if (plan.action === 'none') return ''
  if (plan.action === 'enable') {
    if (!opts.enableIfMissing) return ''
    const r = await enableAutostart('server')
    return r.ok ? plan.line : `Could not enable autostart on WSL: ${r.message.split('\n').pop()}`
  }
  const r = await installLogonEntry(wslDistro()!)
  return r.ok ? plan.line : `Could not update the Windows logon entry: ${r.message}`
}

/** Type guard used by the cli to validate the user-supplied mode. */
export function isAutostartMode(value: string): value is AutostartMode {
  return (MODES as string[]).includes(value)
}
