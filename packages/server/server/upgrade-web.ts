/**
 * upgrade-web.ts — `POST /api/upgrade`: the dashboard's own "update now".
 *
 * The modal has always printed `agentop upgrade` and left the person to find a terminal. The whole
 * point of this route is that they do not have to — and the whole reason it is its own module is
 * that running it correctly is NOT "spawn the command".
 *
 * **THE UPGRADE MUST NOT BE THIS PROCESS'S CHILD.** `upgrade.ts` restarts whatever `agentop server`
 * it can find, and it finds them with `pgrep -f 'agentop.*(server|start)'` while excluding its own
 * `pid` and its `ppid` — the exclusion that makes running it from a terminal safe. Spawned as a
 * child of the server, the server IS the `ppid`: it would be skipped, the upgrade would report
 * success, and the machine would go on serving the old bundle with a new binary on disk. So the
 * child is DETACHED and `unref`'d — its parent becomes init, nothing is excluded, and the server it
 * restarts is the one that started it.
 *
 * That restart is also why there is no "and then tell the browser it worked": the process answering
 * would be killed mid-sentence. The route answers `started` and the PAGE watches `/api/version`
 * until the machine comes back on the new version — an honest poll rather than a promise made by
 * something about to be replaced.
 *
 * ONE AT A TIME. A second press while one runs is refused in words rather than starting a second
 * download over the same binary path.
 */

import { basename } from 'node:path'
import { spawn } from 'node:child_process'
import { CAPS } from './exposure'
import { TEAM_CENTRAL } from './config'
import { getVersionInfo } from './version'
import { upgradeFromUiDecision, UPGRADE_REFUSALS, type UpgradeRefusal } from './upgrade-gate'
import { writeAudit } from './audit'
import type { CliLang } from './cli-lang'

/** Set while a detached upgrade is in flight, so a second press is refused rather than racing. */
let running: { version: string; startedMs: number } | null = null

/** How long a start is believed before the flag is let go. The child is detached and its exit is
 *  not observable here; without a ceiling a failed upgrade would lock the button until a restart —
 *  and the restart is exactly what a SUCCESSFUL one causes. */
const RUN_TTL_MS = 10 * 60_000

function inFlight(now: number): boolean {
  if (!running) return false
  if (now - running.startedMs > RUN_TTL_MS) { running = null; return false }
  return true
}

/**
 * The binary to run, or `null` when this process is not one.
 *
 * A compiled `agentop` has itself as `execPath`, which is the exact binary the user is running and
 * the one `upgrade.ts` replaces. Under `bun server/index.ts` the `execPath` is bun — that is a
 * development checkout, where an upgrade means `git pull`, so the button is absent rather than
 * running something that would replace a binary nobody is using.
 */
export function upgradeBinary(execPath: string): string | null {
  return basename(execPath).startsWith('agentop') ? execPath : null
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function refuse(reason: UpgradeRefusal, lang: CliLang, ip: string): Response {
  void writeAudit({ action: 'upgrade.denied', ip, meta: { reason } })
  return json({ ok: false, reason, message: UPGRADE_REFUSALS[reason][lang === 'pt' ? 'pt' : 'en'] }, 409)
}

export async function handleUpgradeRoute(
  req: Request,
  url: URL,
  lang: CliLang,
  ip: string,
): Promise<Response | null> {
  if (url.pathname !== '/api/upgrade' || req.method !== 'POST') return null

  // FORCE. `getVersionInfo` caches for hours, and somebody pressing this button is acting on an
  // update they are looking at RIGHT NOW — a cached "you are up to date" refuses the press with a
  // sentence that contradicts the modal above it. Measured: a machine on 2.31.0 with 2.32.0
  // published answered `up-to-date` from a cache minted before the release existed. It is one
  // round trip per press, on a press, which is exactly what `agentop upgrade` already does for the
  // same reason (`force live GitHub release check during manual upgrade`).
  const info = await getVersionInfo({ force: true }).catch(() => null)
  const decision = upgradeFromUiDecision({
    capable: CAPS.localShell,
    central: TEAM_CENTRAL,
    hasUpdate: info?.hasUpdate === true,
    latest: info?.latest ?? null,
  })
  if (!decision.ok) return refuse(decision.reason, lang, ip)

  const bin = upgradeBinary(process.execPath)
  // Not a compiled binary: a development checkout upgrades with `git pull`, and spawning
  // `bun upgrade` here would upgrade BUN. It gets its OWN sentence — reusing `no-capability` would
  // tell somebody their exposure profile is locked down when it is not.
  if (!bin) return refuse('not-a-binary', lang, ip)

  const now = Date.now()
  if (inFlight(now)) return refuse('busy', lang, ip)
  running = { version: decision.version, startedMs: now }

  try {
    // DETACHED — see this module's header. `setsid` is not enough on its own: the handles must go
    // too, or the child holds this server's stdio open across its own restart.
    const child = spawn(bin, ['upgrade'], { detached: true, stdio: 'ignore' })
    child.unref()
  } catch {
    running = null
    return json({ ok: false, reason: 'spawn-failed' }, 500)
  }

  void writeAudit({ action: 'upgrade.started', ip, targetId: decision.version })
  // `started`, never `done`: the process that would say "done" is the one this upgrade restarts.
  return json({ ok: true, started: true, version: decision.version })
}
