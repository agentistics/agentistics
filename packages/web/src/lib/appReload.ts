/**
 * appReload.ts — PURE (the decision) plus one total, guarded side effect: bringing the page back on
 * a bundle that was just published, without asking a person to press ctrl+shift+R.
 *
 * This app is a PWA, so a plain `location.reload()` is served by the SERVICE WORKER, which hands
 * back its cached copy of the bundle that was current when it last updated. That is why every
 * release so far has ended with "give it a hard reload first" — and why a reader who forgot tested
 * yesterday's code believing it was today's, which is the worst shape a verification can take.
 * `clearAppCaches` is what the keystroke actually does: unregister every worker, empty every cache,
 * and only then reload.
 *
 * The WAIT is the other half. `POST /api/upgrade` answers `started` and nothing more, because the
 * process that would say "done" is the one the upgrade restarts. So the page WATCHES: it polls
 * `/api/version` and reloads when the machine comes back naming the version it asked for. Every
 * failed poll in between is the ordinary case — the server really is down for a moment — and must
 * never be mistaken for an answer.
 */

/** How long to keep watching before saying so. An upgrade is a download plus a service restart;
 *  past this, something went wrong and a spinner that never ends is not an answer. */
export const UPGRADE_WAIT_MS = 4 * 60_000

/** How often to ask. Short enough to feel immediate, long enough that a restarting server is not
 *  hammered by a page that cannot help it. */
export const UPGRADE_POLL_MS = 1500

function numbers(v: string): number[] {
  return v.replace(/^v/, '').split('.').map(n => parseInt(n, 10))
}

/**
 * Has the machine come back on (at least) the version we asked for?
 *
 * `null` and a blank version are the SERVER BEING DOWN, which is what an upgrade looks like from
 * here — never an arrival. A version PAST the target counts: another release can land in between,
 * and refusing to reload would leave the reader on an older bundle for no reason.
 */
export function upgradeArrived(info: { current?: string } | null, target: string): boolean {
  const current = info?.current?.trim()
  if (!current || !target) return false
  const a = numbers(current)
  const b = numbers(target)
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return current.replace(/^v/, '') === target.replace(/^v/, '')
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}

/** The two accessors, injected so this is testable without a browser — and so a context that has
 *  neither (an older browser, a private window, a preview frame) is a supported case and not a
 *  throw. */
export interface ReloadEnv {
  caches?: { keys(): Promise<string[]>; delete(key: string): Promise<boolean> }
  serviceWorker?: { getRegistrations(): Promise<readonly { unregister(): Promise<boolean> }[]> }
}

/**
 * Empty everything a reload would otherwise be served from.
 *
 * EVERY step is swallowed on purpose. This runs immediately before a reload the reader asked for:
 * a browser that blocks site data, a worker that is already gone, a cache API that throws on
 * access — none of them is a reason to leave the person looking at the old bundle with an error
 * where their new version should be.
 */
export async function clearAppCaches(env: ReloadEnv): Promise<void> {
  try {
    const regs = await env.serviceWorker?.getRegistrations()
    await Promise.all((regs ?? []).map(r => r.unregister().catch(() => false)))
  } catch { /* no worker, or the accessor itself threw */ }
  try {
    const keys = await env.caches?.keys()
    await Promise.all((keys ?? []).map(k => env.caches!.delete(k).catch(() => false)))
  } catch { /* no cache storage, or site data is blocked */ }
}

/** The browser's own accessors, read defensively — `caches` is absent over plain HTTP on a LAN. */
export function browserReloadEnv(): ReloadEnv {
  const env: ReloadEnv = {}
  try { if (typeof caches !== 'undefined') env.caches = caches } catch { /* blocked */ }
  try {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker) env.serviceWorker = navigator.serviceWorker
  } catch { /* blocked */ }
  return env
}
