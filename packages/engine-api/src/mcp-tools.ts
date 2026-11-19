/**
 * mcp-tools.ts — MCP tools an engine declares in its manifest (1.30).
 *
 * The public MCP server lists `GET /api/engine/mcp-tools` and exposes each valid entry as a tool; a
 * call is proxied to the declared route under `/api/engine/x/`. Nothing here is specific to any one
 * feature. PURE: the host judges a manifest with `mcpToolRefusals` at load — a tool it cannot
 * expose safely is refused (declared absence), never half-listed.
 */
import { ENGINE_ASSET_PREFIX } from './surfaces'

/** The only names an engine tool may carry: `agentistics_x_` + 2..40 of `[a-z0-9_]`. */
export const MCP_TOOL_NAME = /^agentistics_x_[a-z0-9_]{2,40}$/

export interface EngineMcpTool {
  name: string
  description: string
  /** A JSON-schema object (`type: 'object'`) describing the arguments. */
  inputSchema: Record<string, unknown>
  /** R reads; W is a reversible write (audited like every other W tool). Nothing destructive travels here. */
  risk: 'R' | 'W'
  method: 'GET' | 'POST'
  /** Under `ENGINE_ASSET_PREFIX`; the host never proxies elsewhere. */
  path: string
}

export type McpToolRefusalReason =
  | 'bad-name' | 'duplicate-name' | 'bad-description' | 'bad-schema' | 'bad-risk' | 'bad-method' | 'bad-path'

/** PURE. May the MCP server proxy to `path`? Same-origin, under the engine prefix, no dot-segments or encodings. */
export function mcpToolPathOk(path: unknown): path is string {
  if (typeof path !== 'string' || !path.startsWith(ENGINE_ASSET_PREFIX)) return false
  if (path.length > 256 || /[\\?#%\s]/.test(path) || path.includes('//')) return false
  let u: URL
  try { u = new URL(path, 'http://same-origin.invalid') } catch { return false }
  if (u.origin !== 'http://same-origin.invalid' || u.pathname !== path) return false
  const rest = path.slice(ENGINE_ASSET_PREFIX.length)
  return rest.length > 0 && !rest.split('/').some(s => s === '' || s === '.' || s === '..')
}

/** PURE. The refusals for a manifest's MCP tools; empty means every one may be offered. */
export function mcpToolRefusals(
  tools: readonly EngineMcpTool[] | undefined,
): { name: string; reason: McpToolRefusalReason }[] {
  const out: { name: string; reason: McpToolRefusalReason }[] = []
  const seen = new Set<string>()
  for (const t of tools ?? []) {
    const name = typeof t?.name === 'string' ? t.name : ''
    if (!MCP_TOOL_NAME.test(name)) { out.push({ name, reason: 'bad-name' }); continue }
    if (seen.has(name)) { out.push({ name, reason: 'duplicate-name' }); continue }
    seen.add(name)
    if (typeof t.description !== 'string' || t.description.trim() === '' || t.description.length > 1000) out.push({ name, reason: 'bad-description' })
    const s = t.inputSchema as { type?: unknown } | null | undefined
    if (!s || typeof s !== 'object' || Array.isArray(s) || s.type !== 'object') out.push({ name, reason: 'bad-schema' })
    if (t.risk !== 'R' && t.risk !== 'W') out.push({ name, reason: 'bad-risk' })
    if (t.method !== 'GET' && t.method !== 'POST') out.push({ name, reason: 'bad-method' })
    if (!mcpToolPathOk(t.path)) out.push({ name, reason: 'bad-path' })
  }
  return out
}
