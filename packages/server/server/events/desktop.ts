/**
 * desktop.ts — the desktop half of the cascade: probing what this machine has, and using it.
 *
 * `notify-plan.ts` decides; this file looks and spawns. The split matters because "which channel"
 * is the part with rules worth testing and "does `notify-send` exist" is the part that can only be
 * answered by this machine.
 *
 * ## A delivery that failed says so
 *
 * Every send returns a result. A channel that was chosen and then failed (the toast command exited
 * non-zero, ccn exited 0 having done nothing) is reported as a failed delivery, not swallowed. The
 * event is in the inbox either way — the point of reporting is that `agentop events status` and the
 * command output can tell the user their desktop notifications are not actually arriving, before
 * they have spent a week trusting them.
 */

import { hostWhich } from '../host-which'
import { existsSync, readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { HOME_DIR } from '../config'
import {
  ccnPayload, planDesktopChannel, type DesktopChannel, type DesktopDecision, type DesktopProbe,
} from './notify-plan'
import type { DesktopText } from './notify-text'

/** A notification that hangs holds up the poll that produced it. */
const NOTIFY_TIMEOUT_MS = 5_000

/**
 * Where `claude-code-notifications` installs its notifier.
 *
 * Two locations because it can arrive two ways: through the Claude Code plugin cache (versioned
 * directory, which is why the version segment is globbed rather than pinned) or through its own
 * `install.sh` into `~/.claude/hooks`. Detected, never embedded — see `notify-plan.ts`.
 */
async function findCcnScript(): Promise<string | undefined> {
  const direct = join(HOME_DIR, '.claude', 'hooks', 'ccn', 'notify.sh')
  if (existsSync(direct)) return direct

  const cacheRoot = join(HOME_DIR, '.claude', 'plugins', 'cache', 'blpsoares', 'claude-code-notifications')
  try {
    const versions = (await readdir(cacheRoot)).sort().reverse()
    for (const v of versions) {
      const p = join(cacheRoot, v, 'scripts', 'notify.sh')
      if (existsSync(p)) return p
    }
  } catch { /* not installed that way */ }
  return undefined
}

/**
 * Is this WSL? Only then is it worth looking for Windows programs under `/mnt`.
 *
 * Read from `/proc/version`, which carries the kernel's own build string — the same signal
 * `live-sessions.ts` uses to decide what this machine can be asked about.
 */
function isWsl(): boolean {
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'))
  } catch {
    return false
  }
}

/**
 * Where `powershell.exe` is, PATH or no PATH.
 *
 * **A daemon's PATH is not the shell's, and this cost the whole desktop channel.** WSL puts the
 * Windows directories on the PATH of an interactive shell through interop; a systemd user service
 * gets `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:…` and nothing else. So
 * `Bun.which('powershell.exe')` answered YES to a person typing `agentop events status` and NO to
 * the daemon that actually does the notifying — the daemon skipped ccn (which needs it), fell
 * through to `notify-send`, and that failed on every event for hours while `status` in a terminal
 * cheerfully reported ccn. Measured from the service's own log.
 *
 * The absolute path is checked second, exactly as `SCRIPT_HARNESS` in `live-sessions.ts` looks past
 * a name that does not resolve: what is on PATH is a fact about the caller's environment, not about
 * the machine.
 */
const WSL_POWERSHELL_PATHS = [
  '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  '/mnt/c/Windows/system32/WindowsPowerShell/v1.0/powershell.exe',
]

export function findPowershell(): string | undefined {
  const onPath = hostWhich('powershell.exe')
  if (onPath) return onPath
  if (!isWsl()) return undefined
  return WSL_POWERSHELL_PATHS.find(p => existsSync(p))
}

/** What this machine actually has. `failed` is carried in by the caller — see `DesktopProbe`. */
export async function probeDesktop(failed: readonly DesktopChannel[] = []): Promise<DesktopProbe> {
  const ccnScript = await findCcnScript()
  const powershell = findPowershell()
  return {
    ...(ccnScript !== undefined ? { ccnScript } : {}),
    hasJq: !!hostWhich('jq'),
    hasPowershell: powershell !== undefined,
    hasNotifySend: !!hostWhich('notify-send'),
    hasTty: process.stdout.isTTY === true,
    // Absent reads as ENABLED here — unlike `chatAllowed`, because this switch turns off a
    // notification rather than opening a door. Only an explicit `0` disables it.
    disabled: process.env.AGENTISTICS_EVENTS_DESKTOP === '0',
    ...(failed.length > 0 ? { failed } : {}),
  }
}

export interface DesktopSetup {
  probe: DesktopProbe
  decision: DesktopDecision
}

/**
 * Channels that were chosen and then failed, for this process.
 *
 * Module-level rather than threaded through every caller because it is a fact about THIS MACHINE's
 * channels, not about any one notification, and because the producer holds a `DesktopSetup` for its
 * whole lifetime — a memory it could not see would leave it retrying a dead channel every five
 * seconds forever, which is exactly what happened.
 */
const failedChannels = new Set<DesktopChannel>()

/** For `status` and the tests: what has stopped working since this process started. */
export function failedDesktopChannels(): DesktopChannel[] {
  return [...failedChannels]
}

/** Probe once, decide once. A caller that notifies repeatedly holds this rather than re-reading the
 *  filesystem on every event — but see `failedChannels`: a held setup is re-planned when the channel
 *  it names has since failed. */
export async function desktopSetup(): Promise<DesktopSetup> {
  const probe = await probeDesktop([...failedChannels])
  return { probe, decision: planDesktopChannel(probe) }
}

export async function desktopDecision(): Promise<DesktopDecision> {
  return (await desktopSetup()).decision
}

export type DesktopResult =
  | { ok: true; channel: DesktopChannel }
  | { ok: false; channel: DesktopChannel; message: string }

async function run(
  cmd: string[],
  stdin?: string,
  env?: Record<string, string>,
): Promise<{ code: number; err: string }> {
  const proc = Bun.spawn(cmd, {
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    ...(env ? { env: { ...process.env, ...env } } : {}),
  })
  const timer = setTimeout(() => { try { proc.kill() } catch { /* already gone */ } }, NOTIFY_TIMEOUT_MS)
  try {
    const code = await proc.exited
    const err = await new Response(proc.stderr).text()
    return { code, err: err.trim() }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The environment `claude-code-notifications` needs to do anything at all.
 *
 * Its script opens with `command -v powershell.exe >/dev/null 2>&1 || exit 0` and calls `reg.exe`
 * and `wscript.exe` besides. Under a daemon whose PATH holds no Windows directory that guard fires
 * and the script **exits 0 having done nothing** — which this module would then report as a
 * delivered notification. A silent success is the one outcome worse than a loud failure here, so
 * the Windows system directory is put on the child's PATH explicitly rather than inherited and
 * hoped for.
 */
function ccnEnv(): Record<string, string> | undefined {
  const ps = findPowershell()
  if (!ps) return undefined
  const dir = ps.slice(0, ps.lastIndexOf('/'))
  // System32 as well as PowerShell's own directory: `reg.exe` and `wscript.exe` live there.
  const system32 = dir.replace(/\/WindowsPowerShell\/v1\.0$/i, '')
  const extra = [dir, system32].filter((v, i, a) => a.indexOf(v) === i).join(':')
  return { PATH: `${process.env.PATH ?? ''}:${extra}` }
}

/** One attempt through one channel. Split out so `notifyDesktop` can fall through on failure. */
async function deliverVia(
  chosen: DesktopSetup,
  text: DesktopText,
  cwd: string,
): Promise<DesktopResult> {
  const d = chosen.decision
  try {
    switch (d.channel) {
      case 'ccn': {
        const r = await run(['bash', chosen.probe.ccnScript!], ccnPayload({ ...text, cwd }), ccnEnv())
        return r.code === 0
          ? { ok: true, channel: 'ccn' }
          : { ok: false, channel: 'ccn', message: `claude-code-notifications exited ${r.code}${r.err ? `: ${r.err}` : ''}` }
      }
      case 'notify-send': {
        const r = await run(['notify-send', '--app-name=agentop', text.title, text.body])
        return r.code === 0
          ? { ok: true, channel: 'notify-send' }
          : { ok: false, channel: 'notify-send', message: `notify-send exited ${r.code}${r.err ? `: ${r.err}` : ''}` }
      }
      case 'powershell': {
        const r = await run([findPowershell() ?? 'powershell.exe', '-NoProfile', '-NonInteractive', '-Command', powershellToast(text)])
        return r.code === 0
          ? { ok: true, channel: 'powershell' }
          : { ok: false, channel: 'powershell', message: `powershell.exe exited ${r.code}${r.err ? `: ${r.err}` : ''}` }
      }
      case 'bell':
        // The one channel that needs no program: the terminal's own BEL.
        process.stdout.write('\x07')
        return { ok: true, channel: 'bell' }
      case 'none':
        return { ok: false, channel: 'none', message: d.reason }
    }
  } catch (e) {
    return { ok: false, channel: d.channel, message: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Show one notification through whichever channel this machine has, falling through on failure.
 *
 * `cwd` is passed because ccn derives its title and its footer from the directory — it is what
 * makes a toast say which project, for the five harnesses that have no Claude transcript to read.
 *
 * A channel that fails is REMEMBERED and the next one down is tried for this same notification, so
 * a machine whose first choice cannot deliver still gets the event AND stops paying for the dead
 * channel on every event after it. Bounded by the number of channels: this cannot loop.
 */
export async function notifyDesktop(
  text: DesktopText,
  cwd: string,
  setup?: DesktopSetup,
): Promise<DesktopResult> {
  // A held setup naming a channel that has since failed is stale, whoever is holding it.
  let chosen = setup && !failedChannels.has(setup.decision.channel) ? setup : await desktopSetup()
  let last: DesktopResult = { ok: false, channel: 'none', message: chosen.decision.reason }

  for (let attempt = 0; attempt < 4; attempt++) {
    last = await deliverVia(chosen, text, cwd)
    if (last.ok || last.channel === 'none') return last
    failedChannels.add(last.channel)
    chosen = await desktopSetup()
    if (chosen.decision.channel === 'none') {
      return { ok: false, channel: 'none', message: `${last.message} — ${chosen.decision.reason}` }
    }
  }
  return last
}

/**
 * A plain Windows toast from WSL, with no plugin involved.
 *
 * A screen tail is arbitrary user text and it is being placed inside a PowerShell string literal,
 * so the one quoting rule that matters is applied here: a single quote is doubled, newlines are
 * collapsed, and the length is bounded. Without that a stray apostrophe in someone's prompt ends
 * the literal and the rest of their text is parsed as code.
 */
function powershellToast(text: DesktopText): string {
  const esc = (s: string): string => s.replace(/[\r\n]+/g, ' ').replace(/'/g, "''").slice(0, 200)
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null;',
    // 5 is ToastText02: a bold heading line and a body line, and no image to resolve.
    '$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(5);',
    `$t.GetElementsByTagName('text').Item(0).AppendChild($t.CreateTextNode('${esc(text.title)}')) > $null;`,
    `$t.GetElementsByTagName('text').Item(1).AppendChild($t.CreateTextNode('${esc(text.body)}')) > $null;`,
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('agentop').Show([Windows.UI.Notifications.ToastNotification]::new($t));",
  ].join(' ')
}
