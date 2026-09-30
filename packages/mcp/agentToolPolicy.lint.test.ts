import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AGENT_INTENT_ROUTE,
  AGENT_TOOL_NAMES,
  AGENT_TOOL_POLICY,
  D_DIRECT_UNTIL_P2,
  NEVER_PREFERENCE_KEYS,
  neverRouteFor,
  type AgentToolName,
} from '@agentistics/core'
import { routeCapability } from '../server/server/capability-guard'

/**
 * The policy table is only worth something if it cannot drift from the MCP it describes. Nothing
 * reads it at runtime yet (the gate is P2), so this grep IS the enforcement — the shape of
 * `tokens.lint.test.ts`: read the MCP's own source and refuse what the table does not allow.
 *
 *  1. every tool in `TOOLS` has a row, and every row has a tool;
 *  2. a row's `routes` are EXACTLY the routes its handler calls (a table that names a milder route
 *     than the code calls is worse than no table);
 *  3. a `D` handler calls only the intent route — except the `D_DIRECT_UNTIL_P2` list, which may
 *     only hold `D` tools;
 *  4. the MCP source never mentions the intent DECIDE route (only a person decides);
 *  5. no call anywhere in the MCP calls a `NEVER_ROUTES` entry, and no security preference key is
 *     so much as named;
 *  6. `capability` / `host` agree with the server's own `capability-guard.ts`.
 */

const MCP_SOURCE = readFileSync(join(import.meta.dir, 'agentistics-mcp.ts'), 'utf8')

export interface ApiCall { method: string; path: string }

/** Reads the path starting at `from` (which points at `/api/`), `*` for a `${…}` segment. */
function readPath(src: string, from: number): string {
  let out = ''
  let i = from
  while (i < src.length) {
    const c = src[i]!
    if (c === '$' && src[i + 1] === '{') {
      let depth = 0
      let j = i + 1
      for (; j < src.length; j++) {
        if (src[j] === '{') depth++
        else if (src[j] === '}' && --depth === 0) break
      }
      // A `${…}` right after a `/` is a path segment; glued to a word it is a query suffix.
      if (out.endsWith('/')) out += '*'
      i = j + 1
      continue
    }
    if (!/[A-Za-z0-9_\-/.]/.test(c)) break
    out += c
    i++
  }
  return out
}

/** Every API call a piece of MCP source makes, with its method. */
export function apiCallsIn(src: string): ApiCall[] {
  const calls: ApiCall[] = []
  const re = /\b(apiGet|apiSend|fetch|getPrefs|putPrefs)\(/g
  const marks = [...src.matchAll(re)]
  marks.forEach((m, i) => {
    const fn = m[1]!
    const at = m.index! + m[0].length
    // Never look past the next call: its method would be read as this one's.
    const next = marks[i + 1]
    const stop = Math.min(at + 400, next ? next.index! : src.length)
    if (fn === 'getPrefs') return void calls.push({ method: 'GET', path: '/api/preferences' })
    if (fn === 'putPrefs') return void calls.push({ method: 'PUT', path: '/api/preferences' })
    const head = src.slice(at, stop)
    const apiAt = head.indexOf('/api/')
    if (apiAt < 0) return // the helpers' own `fetch(`${API}${path}`)` — the path is their caller's
    const path = readPath(src, at + apiAt)
    let method = 'GET'
    if (fn === 'apiSend') method = /^\s*["'`](\w+)["'`]/.exec(head)?.[1] ?? '?'
    else if (fn === 'fetch') method = /method:\s*["'`](\w+)["'`]/.exec(head)?.[1] ?? 'GET'
    calls.push({ method: method.toUpperCase(), path })
  })
  return calls
}

/** The tool names declared in `TOOLS` (the `name:` fields of the array literal). */
export function declaredTools(src: string): string[] {
  const start = src.indexOf('const TOOLS')
  const end = src.indexOf('server.setRequestHandler(ListToolsRequestSchema')
  return [...src.slice(start, end).matchAll(/name:\s*["'`](agentistics_\w+)["'`]/g)].map((m) => m[1]!)
}

/** Each `case "agentistics_…"` handler's body, keyed by tool name. */
export function handlerBodies(src: string): Map<string, string> {
  const out = new Map<string, string>()
  const marks = [...src.matchAll(/case\s+["'`](agentistics_\w+)["'`]\s*:/g)]
  marks.forEach((m, i) => {
    const from = m.index! + m[0].length
    const next = marks[i + 1]
    const to = next ? next.index! : src.indexOf('default:', from)
    out.set(m[1]!, src.slice(from, to < 0 ? undefined : to))
  })
  return out
}

const norm = (route: string) => route.replace(/:[A-Za-z]+/g, '*')
const key = (c: ApiCall) => `${c.method} ${c.path}`

describe('agent tool policy table', () => {
  const declared = declaredTools(MCP_SOURCE)
  const bodies = handlerBodies(MCP_SOURCE)

  it('reads the real tool list (38 on dev at P1.1)', () => {
    expect(declared.length).toBeGreaterThan(0)
    expect(new Set(declared).size).toBe(declared.length)
    expect(declared.length).toBe(AGENT_TOOL_NAMES.length)
  })

  it('every tool in TOOLS has a row, and every row has a tool', () => {
    const rows: string[] = Object.keys(AGENT_TOOL_POLICY).sort()
    expect([...AGENT_TOOL_NAMES].sort() as string[]).toEqual(rows)
    expect([...declared].sort()).toEqual(rows)
    expect([...bodies.keys()].sort()).toEqual(rows)
  })

  it('every row states a reason', () => {
    for (const [name, p] of Object.entries(AGENT_TOOL_POLICY)) {
      expect(p.reason.trim().length, name).toBeGreaterThan(0)
      expect(p.reason.includes('\n'), name).toBe(false)
    }
  })

  it("a row's routes are exactly the routes its handler calls", () => {
    for (const [name, body] of bodies) {
      const called = new Set(apiCallsIn(body).map(key))
      const declaredRoutes = new Set(AGENT_TOOL_POLICY[name as AgentToolName].routes.map(norm))
      expect([...called].sort(), name).toEqual([...declaredRoutes].sort())
    }
  })

  it('a D handler calls only the intent route, bar the shrinking P2 list', () => {
    for (const t of D_DIRECT_UNTIL_P2) expect(AGENT_TOOL_POLICY[t].risk, t).toBe('D')
    for (const [name, body] of bodies) {
      if (AGENT_TOOL_POLICY[name as AgentToolName].risk !== 'D') continue
      if (D_DIRECT_UNTIL_P2.includes(name as AgentToolName)) continue
      for (const c of apiCallsIn(body)) expect(`${name} → ${key(c)}`).toBe(`${name} → POST ${AGENT_INTENT_ROUTE}`)
    }
  })

  it('the MCP never mentions the decide route', () => {
    expect(/\/decide\b/.test(MCP_SOURCE)).toBe(false)
  })

  it('no MCP call reaches a NEVER route', () => {
    const hits = apiCallsIn(MCP_SOURCE)
      .map((c) => ({ c, hit: neverRouteFor(c.method, c.path) }))
      .filter((x) => x.hit)
      .map((x) => `${key(x.c)} — ${x.hit!.reason}`)
    expect(hits).toEqual([])
  })

  it('the MCP never names a security preference key', () => {
    for (const k of NEVER_PREFERENCE_KEYS) expect(new RegExp(`\\b${k}\\b`).test(MCP_SOURCE), k).toBe(false)
  })

  it("capability and host agree with the server's capability-guard", () => {
    for (const [name, p] of Object.entries(AGENT_TOOL_POLICY)) {
      const caps = new Set(p.routes.map((r) => routeCapability(r.split(' ')[1]!.replace(/:[A-Za-z]+/g, 'x'))))
      caps.delete(null)
      expect([...caps], name).toEqual(p.capability ? [p.capability] : [])
      expect(p.host, name).toBe(p.capability !== undefined)
    }
  })
})

describe('the lint catches what it is for', () => {
  it('neverRouteFor honours the method filter', () => {
    expect(neverRouteFor('GET', '/api/exec')).not.toBeNull()
    expect(neverRouteFor('GET', '/api/fleet/tree/file')).toBeNull()
    expect(neverRouteFor('POST', '/api/fleet/tree/entry')).not.toBeNull()
    expect(neverRouteFor('GET', '/api/provider')).toBeNull()
    expect(neverRouteFor('PUT', '/api/provider/openai')).not.toBeNull()
    expect(neverRouteFor('GET', '/api/executive')).toBeNull()
  })

  it('reads method and path off every call shape the MCP uses', () => {
    const src = [
      'await apiGet(`/api/tasks/${encodeURIComponent(ref)}`)',
      'await apiGet(`/api/tasks/next${q.toString() ? `?${q}` : ""}`)',
      'await apiSend("DELETE", `/api/tasks/${ref}`)',
      'await fetch(`${API}/api/team/members`)',
      'await fetch(`${API}/api/exec`, { method: "POST" })',
      'await getPrefs(); await putPrefs({})',
    ].join('\n')
    expect(apiCallsIn(src).map(key)).toEqual([
      'GET /api/tasks/*', 'GET /api/tasks/next', 'DELETE /api/tasks/*', 'GET /api/team/members',
      'POST /api/exec', 'GET /api/preferences', 'PUT /api/preferences',
    ])
  })
})
