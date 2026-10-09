/**
 * agy-mcp.ts — the agentistics MCP in Antigravity's own config (ENGINE.MAP P-20).
 *
 * agy 1.3.2 has `agy mcp add|remove|list` and ONE place servers live: the global
 * `~/.gemini/config/mcp_config.json` (`{ "mcpServers": { name: { command, args, env } } }`, agy's embedded
 * docs). It has NO per-session MCP flag, so unlike claude (`--mcp-config`) or ACP (`session/new`) the
 * registration is global to agy and happens at server boot, like codex/gemini/copilot — which is what
 * `StructuredDeclaration.mcp` for antigravity says.
 *
 * PURE: `planAgyMcp` decides from the file's content; `agyMcpAddArgv` is the one argv that writes it.
 * IO: `ensureAgyMcp` reads, asks `mayRegisterHarnessMcp` (only the user's default server may write
 * user-scope config), and runs agy's own CLI — never edits the file by hand, so agy's format and its
 * file lock stay agy's. An unparseable non-empty file is REFUSED, not repaired.
 */
import path from 'node:path'
import { HOME_DIR } from './config'
import { agentisticsMcpLaunch, CANONICAL_MCP_NAME, sameMcpLaunch, type McpLaunch } from './mcp-launch'
import { mayRegisterHarnessMcp } from './mcp-registration'
import { findCli } from './chat-drivers/cli-detect'

export const AGY_MCP_CONFIG = path.join(HOME_DIR, '.gemini', 'config', 'mcp_config.json')

export type AgyMcpPlan = { action: 'none' } | { action: 'add' } | { action: 'replace' } | { action: 'refuse'; reason: string }

/** PURE. What to do given the config file's text (`null` = the file does not exist). */
export function planAgyMcp(fileText: string | null, launch: McpLaunch, apiUrl: string): AgyMcpPlan {
  const text = (fileText ?? '').trim()
  if (text === '') return { action: 'add' }
  let doc: unknown
  try { doc = JSON.parse(text) } catch { return { action: 'refuse', reason: 'mcp_config.json is not valid JSON' } }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return { action: 'refuse', reason: 'mcp_config.json is not an object' }
  const servers = (doc as { mcpServers?: unknown }).mcpServers
  const entry = typeof servers === 'object' && servers !== null ? (servers as Record<string, unknown>)[CANONICAL_MCP_NAME] : undefined
  if (entry === undefined) return { action: 'add' }
  const e = entry as { command?: unknown; args?: unknown; env?: Record<string, unknown> }
  return e.env?.['AGENTISTICS_API'] === apiUrl && sameMcpLaunch(e, launch) ? { action: 'none' } : { action: 'replace' }
}

/** PURE. `agy mcp add` — flags before the name, `--` before a command (agy's own usage text). */
export function agyMcpAddArgv(launch: McpLaunch, apiUrl: string): string[] {
  return ['agy', 'mcp', 'add', '--env', `AGENTISTICS_API=${apiUrl}`, CANONICAL_MCP_NAME, '--', launch.command, ...launch.args]
}

export const agyMcpRemoveArgv = (): string[] => ['agy', 'mcp', 'remove', CANONICAL_MCP_NAME]

export interface AgyMcpDeps {
  read?: () => Promise<string | null>
  run?: (argv: string[]) => Promise<number>
  may?: (port: number) => boolean
  installed?: () => boolean
  launch?: () => McpLaunch
}

export async function ensureAgyMcp(port: number, deps: AgyMcpDeps = {}): Promise<AgyMcpPlan | { action: 'skipped'; reason: string }> {
  if (!(deps.installed ?? (() => findCli('agy')))()) return { action: 'skipped', reason: 'agy is not installed' }
  if (!(deps.may ?? mayRegisterHarnessMcp)(port)) return { action: 'skipped', reason: 'not the default server' }
  const read = deps.read ?? (async () => { try { return await Bun.file(AGY_MCP_CONFIG).text() } catch { return null } })
  const run = deps.run ?? (async (argv: string[]) => await Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' }).exited)
  const apiUrl = `http://localhost:${port}`
  const launch = (deps.launch ?? agentisticsMcpLaunch)()
  const plan = planAgyMcp(await read(), launch, apiUrl)
  if (plan.action === 'replace') await run(agyMcpRemoveArgv())
  if (plan.action === 'add' || plan.action === 'replace') await run(agyMcpAddArgv(launch, apiUrl))
  return plan
}
