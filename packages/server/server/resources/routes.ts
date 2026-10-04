/**
 * resources/routes.ts — `/api/resources*`.
 *
 *   GET    /api/resources                      the governor's last snapshot (ticks one if none yet)
 *   POST   /api/resources/kill        {pid}    the one-click fix: SIGTERM an inventory process
 *   POST   /api/resources/helpers     {…}      register a helper (helpers.ts) → {id}
 *   POST   /api/resources/helpers/:id/touch    "something just used it" — resets its idle clock
 *   DELETE /api/resources/helpers/:id          unregister (the helper is NOT killed)
 *   DELETE /api/resources/queue/:id            cancel a spawn the memory gate queued
 *
 * A kill acts only on a pid the governor's OWN inventory holds (never the server itself, never a
 * `server` kind — see governor.ts), re-read at the moment of the request, so this route cannot be
 * used to signal an arbitrary process on the machine.
 */

import { randomUUID } from 'node:crypto'
import { LIMITS, readJsonLimited } from '../limits'
import { governorTick, resourcesSnapshot, type ResourcesSnapshot } from './governor-daemon'
import { killAllowed } from './governor'
import { mutateHelpers, parseHelperRegistration } from './helpers'
import { broadcastNotification } from '../sse'
import { pidAlive } from './proc-read'
import { registeredSpawnQueue } from '../sessions/spawn-queue'

const deps = {
  notify: (n: { type: 'warning' | 'info'; code: string; meta: Record<string, unknown> }) => broadcastNotification(n),
  log: (line: string) => console.log(line),
}

/** A RESPONSE code, not a notification code — see `refuse` in helpers.ts. */
const fail = (code: string) => ({ ok: false, code })

export async function handleResources(req: Request, url: URL, cors: Record<string, string>): Promise<Response | null> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  const path = url.pathname

  if (path === '/api/resources' && req.method === 'GET') {
    const snap: ResourcesSnapshot = resourcesSnapshot() ?? await governorTick(deps)
    return json(snap)
  }

  if (path === '/api/resources/kill' && req.method === 'POST') {
    const read = await readJsonLimited<{ pid?: unknown }>(req, LIMITS.bodyBytes).catch(() => null)
    const raw = read && read.ok ? read.value.pid : undefined
    const pid = typeof raw === 'number' ? raw : NaN
    if (!Number.isInteger(pid)) return json(fail('bad_pid'), 400)
    const fresh = await governorTick(deps)
    if (!killAllowed(fresh.inventory, pid)) return json(fail('not_allowed'), 403)
    try { process.kill(pid, 'SIGTERM') } catch { return json(fail('gone'), 404) }
    deps.log(`[governor] pid ${pid} stopped on request`)
    return json({ ok: true })
  }

  if (path === '/api/resources/helpers' && req.method === 'POST') {
    const read = await readJsonLimited<unknown>(req, LIMITS.bodyBytes).catch(() => null)
    const parsed = parseHelperRegistration(read && read.ok ? read.value : null)
    if (!parsed.ok) return json(fail(parsed.code), 422)
    if (!pidAlive(parsed.value.pid)) return json(fail('bad_pid'), 422)
    const id = `h-${randomUUID().slice(0, 10)}`
    const nowMs = Date.now()
    await mutateHelpers(rs => ({
      // Re-registering a pid replaces its record rather than adding a second one.
      next: [...rs.filter(r => r.pid !== parsed.value.pid), { ...parsed.value, id, registeredMs: nowMs, lastUsedMs: null }],
      result: null,
    }))
    return json({ ok: true, id }, 201)
  }

  const q = /^\/api\/resources\/queue\/([\w-]+)$/.exec(path)
  if (q && req.method === 'DELETE') {
    const queue = registeredSpawnQueue()
    return queue?.cancel(q[1]!) ? json({ ok: true }) : json(fail('no_such_entry'), 404)
  }

  const m = /^\/api\/resources\/helpers\/([\w-]+)(\/touch)?$/.exec(path)
  if (m) {
    const id = m[1]!
    if (m[2] && req.method === 'POST') {
      const found = await mutateHelpers(rs => {
        const hit = rs.some(r => r.id === id)
        return { next: rs.map(r => (r.id === id ? { ...r, lastUsedMs: Date.now() } : r)), result: hit }
      })
      return found ? json({ ok: true }) : json(fail('no_such_helper'), 404)
    }
    if (!m[2] && req.method === 'DELETE') {
      const found = await mutateHelpers(rs => ({ next: rs.filter(r => r.id !== id), result: rs.some(r => r.id === id) }))
      return found ? json({ ok: true }) : json(fail('no_such_helper'), 404)
    }
  }
  return null
}
