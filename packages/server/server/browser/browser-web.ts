/**
 * browser-web.ts — the server's ONE browser host and the `/api/browser/*` door (S1: `status` only).
 *
 * The MCP (`agentistics_browser_status`) and, from S2 on, the web read the SAME host through these
 * routes — never a second instance, never a second set of rules. `/api/browser` is a `localShell`
 * prefix in `capability-guard.ts`, so an exposed profile refuses it before authentication.
 *
 * The host is created lazily (no browser is ever started by the server's boot). The boot only SWEEPS:
 * a profile folder or recorded PID left by a previous server that died is cleaned up, by saved PID with
 * its identity checked (`planOrphanSweep`).
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readMemory } from '../sessions/memory-probe'
import { createBrowserHost, type BrowserHost } from './browser-host'

let host: BrowserHost | null = null
let exitHooked = false

export function browserHost(opts: { dataDir: string; agentisticsPorts: readonly number[] }): BrowserHost {
  if (host) return host
  host = createBrowserHost({
    dataDir: opts.dataDir,
    agentisticsPorts: opts.agentisticsPorts,
    memAvailable: async () => (await readMemory())?.available ?? null,
    log: (line) => console.log(line),
  })
  if (!exitHooked) {
    exitHooked = true
    process.on('exit', () => { host?.killAllSync() })
  }
  return host
}

/** Boot-time orphan sweep, off the startup path. Does nothing when there was never a browser here. */
export function scheduleBrowserSweep(opts: { dataDir: string; agentisticsPorts: readonly number[] }, delayMs = 5_000): void {
  const t = setTimeout(() => {
    if (!existsSync(join(opts.dataDir, 'browser'))) return
    void browserHost(opts).sweep().catch((e) => console.warn('[browser] sweep failed:', e instanceof Error ? e.message : String(e)))
  }, delayMs)
  ;(t as any).unref?.()
}

/** `GET /api/browser/status` — what the host knows: executable (or why there is none), live browsers,
 *  ceilings, memory, scope, recent stops, last sweep. Read-only. */
export async function browserStatusBody(opts: { dataDir: string; agentisticsPorts: readonly number[] }): Promise<unknown> {
  return browserHost(opts).status()
}
