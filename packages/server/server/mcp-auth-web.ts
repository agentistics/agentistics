/**
 * mcp-auth-web.ts — the HTTP door of `mcp-auth.ts`. It holds NO rule: parse, delegate, answer.
 *
 *   GET  /api/mcp/harnesses                         what each harness can list / authenticate
 *   GET  /api/mcp/status?harness=&path=&refresh=1   one harness's servers, with the state IT reports
 *   GET  /api/mcp/auth?id=                          poll one sign-in
 *   POST /api/mcp/auth  {action: start|paste|cancel, …}
 *
 * All four are `localShell` in `capability-guard.ts`: listing health-checks every configured server
 * and a sign-in spawns the harness's login — host power, unreachable on an exposed instance.
 */

import { HARNESS_MCP } from './mcp-harness-status'
import {
  cancelMcpAuth, mcpOverview, mcpStatus, pasteMcpAuth, pollMcpAuth, realDeps, startMcpAuth, type McpAuthDeps,
} from './mcp-auth'
import { LIMITS, readJsonLimited } from './limits'
import { safeError } from './errors'
import type { HarnessId } from '@agentistics/core'

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...extra, 'Content-Type': 'application/json' } })

const langOf = (v: unknown): 'pt' | 'en' => (v === 'pt' ? 'pt' : 'en')

export const MCP_AUTH_PATHS: ReadonlySet<string> = new Set([
  '/api/mcp/harnesses', '/api/mcp/status', '/api/mcp/auth',
])

/** `null` when the path is not ours, so index.ts falls through to its other routes. */
export async function handleMcpAuthRoute(
  req: Request, url: URL, headers: Record<string, string>, verbose: boolean, deps: McpAuthDeps = realDeps,
): Promise<Response | null> {
  if (!MCP_AUTH_PATHS.has(url.pathname)) return null
  try {
    if (url.pathname === '/api/mcp/harnesses' && req.method === 'GET') {
      return json(200, { harnesses: mcpOverview(deps) }, headers)
    }
    if (url.pathname === '/api/mcp/status' && req.method === 'GET') {
      const harness = url.searchParams.get('harness') ?? ''
      if (!Object.hasOwn(HARNESS_MCP, harness)) return json(404, { error: 'unknown_harness' }, headers)
      const path = url.searchParams.get('path')
      const status = await mcpStatus(harness as HarnessId, {
        refresh: url.searchParams.get('refresh') === '1',
        ...(path && path.startsWith('/') ? { cwd: path } : {}),
      }, deps)
      return json(200, status, headers)
    }
    if (url.pathname === '/api/mcp/auth' && req.method === 'GET') {
      const view = await pollMcpAuth(url.searchParams.get('id') ?? '', langOf(url.searchParams.get('lang')), deps)
      return view ? json(200, { ok: true, flow: view }, headers) : json(404, { ok: false, error: 'no_such_flow' }, headers)
    }
    if (url.pathname === '/api/mcp/auth' && req.method === 'POST') {
      const read = await readJsonLimited<{
        action?: string; harness?: string; server?: string; id?: string; redirect?: string; lang?: string; projectPath?: string
      }>(req, LIMITS.bodyBytes)
      if (!read.ok) return json(read.error === 'too_large' ? 413 : 400, { ok: false, message: read.error }, headers)
      const b = read.value
      const lang = langOf(b.lang)
      if (b.action === 'start') {
        const out = await startMcpAuth({
          harness: String(b.harness ?? ''), server: String(b.server ?? ''), lang,
          ...(typeof b.projectPath === 'string' && b.projectPath.startsWith('/') ? { cwd: b.projectPath } : {}),
        }, deps)
        return json(out.ok ? 200 : 409, out, headers)
      }
      if (b.action === 'paste') {
        const out = await pasteMcpAuth(String(b.id ?? ''), String(b.redirect ?? ''), lang, deps)
        return json(out.ok ? 200 : 409, out, headers)
      }
      if (b.action === 'cancel') {
        const view = await cancelMcpAuth(String(b.id ?? ''), lang, deps)
        return view ? json(200, { ok: true, flow: view }, headers) : json(404, { ok: false, error: 'no_such_flow' }, headers)
      }
      return json(400, { ok: false, message: 'bad_action' }, headers)
    }
    return json(405, { error: 'method_not_allowed' }, headers)
  } catch (err) {
    return json(500, { ok: false, ...safeError(err, { verbose }).body }, headers)
  }
}
