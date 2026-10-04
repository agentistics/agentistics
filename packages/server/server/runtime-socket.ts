/**
 * runtime-socket.ts — the machine-local door to the engine's runtime routes (B4.6).
 *
 * `agentop code` on this machine reaches the server's native runtime here, not through the TCP port:
 * `<dataDir>/run/runtime.sock`, the directory `0700` and the socket `0600`, so only the uid that owns
 * the data directory can connect — no browser, no DNS rebinding, no tailnet peer can reach a unix
 * socket. It serves ONLY engine routes that declare `localSocket`, after the same capability guard the
 * TCP door applies (a `public` profile refuses here too); everything else answers 404. A stale socket
 * left by a killed server is unlinked before the bind; the socket is removed on stop.
 */
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { EngineRoute } from '@agentistics/engine-api'

export interface RuntimeSocketOpts {
  dataDir: string
  /** The loaded engine's routes now (null: no engine). Read per request, like the TCP door. */
  routes: () => readonly EngineRoute[] | null
  /** The capability guard for a path: a ready refusal, or null to proceed. */
  guard: (pathname: string) => Response | null
}

export function runtimeSocketPath(dataDir: string): string {
  return join(dataDir, 'run', 'runtime.sock')
}

/** PURE: bind the socket at all? Never on a central, and only when some engine route asks for it. */
export function shouldBindRuntimeSocket(o: { central: boolean; routes: readonly EngineRoute[] | null }): boolean {
  return !o.central && !!o.routes?.some(r => r.localSocket === true)
}

/** The socket's request handler (exported for tests). */
export async function handleRuntimeSocketRequest(req: Request, o: Pick<RuntimeSocketOpts, 'routes' | 'guard'>): Promise<Response> {
  const url = new URL(req.url)
  const routes = o.routes() ?? []
  for (const route of routes) {
    if (route.localSocket !== true) continue
    if (url.pathname !== route.prefix && !url.pathname.startsWith(route.prefix + '/')) continue
    const denied = o.guard(url.pathname)
    if (denied) return denied
    const res = await route.handle(req, url, { clientIp: 'unix', transport: 'unix' })
    if (res !== null) return res
  }
  return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
}

export function startRuntimeSocket(o: RuntimeSocketOpts): { path: string; stop(): void } {
  const dir = join(o.dataDir, 'run')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const path = runtimeSocketPath(o.dataDir)
  if (existsSync(path)) unlinkSync(path)
  const server = Bun.serve({ unix: path, fetch: req => handleRuntimeSocketRequest(req, o) })
  chmodSync(path, 0o600)
  let stopped = false
  return {
    path,
    stop() {
      if (stopped) return
      stopped = true
      try { server.stop(true) } catch { /* already */ }
      try { if (existsSync(path)) unlinkSync(path) } catch { /* gone */ }
    },
  }
}
