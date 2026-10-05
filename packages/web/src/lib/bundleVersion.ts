/**
 * bundleVersion.ts — a page running a bundle OLDER (or newer) than the server it talks to fixes
 * itself: it drops the service worker and its caches and reloads ONCE, then says so in one line.
 *
 * 2026-10-04: after v2.103.1 was installed the owner kept seeing v2.101's vault card, native page,
 * update popup and its looping animation for hours. The server was new; the PWA's service worker
 * was handing back the bundle it had precached, and nothing on the page ever compared the two. The
 * bundle and the server are built from the same `package.json` version (`__APP_VERSION__` is the
 * root package's, and so is `/api/version`'s `current`), so a mismatch is never legitimate.
 *
 * The decision is pure; the side effect is one guarded function. Loop safety is the whole design:
 * the reload is remembered PER SERVER VERSION in sessionStorage, so a reload that still lands on a
 * stale bundle (a browser that refused to drop its caches) is not repeated for that version — the
 * page stays usable instead of spinning.
 */
import { browserReloadEnv, clearAppCaches } from './appReload'

declare const __APP_VERSION__: string

/** The version this bundle was built as; '' when the build did not say (dev, tests). */
export const BUNDLE_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''

export const RELOADED_FOR_KEY = 'ag-bundle-reloaded-for'
export const UPDATED_TOAST_KEY = 'ag-bundle-updated-to'

const bare = (v: string | undefined | null) => (v ?? '').trim().replace(/^v/, '')

export type StaleVerdict =
  /** Same version, or nothing to compare against. */
  | { kind: 'current' }
  /** The bundle does not match the server: clear and reload onto `server`. */
  | { kind: 'reload'; server: string }
  /** Already reloaded once for this server version and still stale: do not loop. */
  | { kind: 'gave-up'; server: string }

export function planStaleBundle(o: { bundle: string; server: string | undefined | null; reloadedFor: string | null; dev: boolean }): StaleVerdict {
  const bundle = bare(o.bundle)
  const server = bare(o.server)
  if (o.dev || !bundle || !server || bundle === server) return { kind: 'current' }
  if (bare(o.reloadedFor) === server) return { kind: 'gave-up', server }
  return { kind: 'reload', server }
}

/** After the reload: is there a "updated to vX" line to show for THIS bundle? Consumed once. */
export function updatedToastFor(o: { bundle: string; pending: string | null }): string | null {
  const bundle = bare(o.bundle)
  return bundle && bare(o.pending) === bundle ? bundle : null
}

export interface SessionStore { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

function store(): SessionStore | null {
  try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null } catch { return null }
}

/** Compare against the server's `/api/version` answer and, when stale, reload once onto it. */
export async function healStaleBundle(server: string | undefined | null, deps: {
  dev?: boolean
  /** The running bundle's version; defaults to the build's own. */
  bundle?: string
  reload?: () => void
  clear?: () => Promise<void>
  storage?: SessionStore | null
} = {}): Promise<StaleVerdict> {
  const s = deps.storage === undefined ? store() : deps.storage
  const verdict = planStaleBundle({
    bundle: deps.bundle ?? BUNDLE_VERSION,
    server,
    reloadedFor: (() => { try { return s?.getItem(RELOADED_FOR_KEY) ?? null } catch { return null } })(),
    dev: deps.dev ?? (import.meta.env?.DEV === true),
  })
  if (verdict.kind !== 'reload') return verdict
  try {
    s?.setItem(RELOADED_FOR_KEY, verdict.server)
    s?.setItem(UPDATED_TOAST_KEY, verdict.server)
  } catch { /* nothing to remember it with: reloading at most once per page is still true below */ }
  await (deps.clear ?? (() => clearAppCaches(browserReloadEnv())))()
  ;(deps.reload ?? (() => window.location.reload()))()
  return verdict
}

/** The version to announce now that the new bundle is running, or null. Clears the marker. */
export function takeUpdatedToast(storage: SessionStore | null = store()): string | null {
  const v = updatedToastFor({ bundle: BUNDLE_VERSION, pending: (() => { try { return storage?.getItem(UPDATED_TOAST_KEY) ?? null } catch { return null } })() })
  if (v) { try { storage?.removeItem(UPDATED_TOAST_KEY) } catch { /* ignore */ } }
  return v
}
