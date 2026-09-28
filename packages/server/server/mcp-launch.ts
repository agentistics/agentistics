/**
 * mcp-launch.ts — HOW an assistant should start the agentistics MCP server on THIS machine.
 *
 * Every registration (`claude mcp add`, `codex mcp add`, `gemini mcp add`, copilot's
 * `mcp-config.json`) used to write the same command: `bun run <repo>/packages/mcp/agentistics-mcp.ts`.
 * That file exists only in a CLONE of this repository, and `bun` only where someone installed it.
 * On a machine that installed the `agentop` binary — every user who is not developing agentistics —
 * the path resolved inside the binary's virtual root (`/$bunfs/root/...`, see `autostart.ts`'s note
 * on `import.meta.dir`) and named nothing on disk. The registration "succeeded", the startup banner
 * printed `mcp ●`, and the assistant failed to launch the server every time it tried, so the MCP
 * never came up anywhere but the author's own checkout.
 *
 * The binary already carries the MCP server (`agentop mcp` serves it over stdio), so the answer is:
 *
 * - a CHECKOUT (the script is really there): keep `bun run <script>`, so a developer's MCP runs the
 *   source they are editing rather than whichever binary happens to be installed;
 * - anything else: `<the agentop binary> mcp` — the executable that is running right now, by its
 *   absolute path, so it does not depend on the PATH of whichever assistant launches it.
 *
 * PURE: `mcpLaunch` decides from facts; `agentisticsMcpLaunch` gathers them.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'

export interface McpLaunch {
  command: string
  args: string[]
}

export function mcpLaunch(facts: { scriptPath: string; scriptExists: boolean; execPath: string }): McpLaunch {
  if (facts.scriptExists) return { command: 'bun', args: ['run', facts.scriptPath] }
  return { command: facts.execPath, args: ['mcp'] }
}

/** Whether a registration already on disk launches exactly this. */
export function sameMcpLaunch(
  existing: { command?: unknown; args?: unknown } | undefined,
  want: McpLaunch,
): boolean {
  if (!existing || existing.command !== want.command || !Array.isArray(existing.args)) return false
  return existing.args.length === want.args.length && existing.args.every((a, i) => a === want.args[i])
}

/** This repository's MCP script, resolved from this module's own location. */
const MCP_SCRIPT = path.resolve(import.meta.dir, '..', '..', 'mcp', 'agentistics-mcp.ts')

export function agentisticsMcpLaunch(): McpLaunch {
  return mcpLaunch({ scriptPath: MCP_SCRIPT, scriptExists: existsSync(MCP_SCRIPT), execPath: process.execPath })
}

/** One MCP entry as `~/.claude.json` stores it — only the fields read here. */
export interface McpEntry {
  command?: unknown
  args?: unknown
  env?: unknown
}

/**
 * Whether an entry launches THE AGENTISTICS MCP, whatever it is called and however it was installed:
 * the script from a clone, the npm package (`@agentistics/mcp` / `agentistics-mcp`), or some
 * `agentop mcp`. The `AGENTISTICS_API` variable is the MCP's own and nobody else's.
 */
export function isAgentisticsMcp(entry: McpEntry): boolean {
  const cmd = typeof entry.command === 'string' ? entry.command : ''
  const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : []
  const line = [cmd, ...args].join(' ')
  if (/agentistics-mcp|@agentistics\/mcp/.test(line)) return true
  if (/(^|\/)agentop(\.exe)?$/.test(cmd) && args[0] === 'mcp') return true
  const env = entry.env && typeof entry.env === 'object' ? entry.env as Record<string, unknown> : {}
  return typeof env['AGENTISTICS_API'] === 'string'
}

export interface StaleMcp {
  scope: 'user' | 'local'
  name: string
  /** For `local`: the project directory the entry belongs to — `claude mcp remove` must run there. */
  project?: string
}

/**
 * Every OTHER copy of the agentistics MCP in `~/.claude.json` — PURE.
 *
 * The canonical registration is the user-scope entry named `agentistics`, which `registerMcpGlobally`
 * rewrites on every boot to launch the installed binary. That alone was not enough: a machine whose
 * MCP had not come up had one registered by hand — reported as an assistant installing the npm
 * package, an OLDER version with no task-board tools — under another name, or in a project's LOCAL
 * scope, which Claude Code prefers over user scope. That copy kept answering with the old tools
 * however many times the server restarted. So every entry that launches the agentistics MCP and is
 * NOT the canonical one is reported here, to be removed: two registrations of one server is at best
 * a duplicate tool list and at worst the stale one winning.
 *
 * Only entries this function can prove are the agentistics MCP (`isAgentisticsMcp`) are ever
 * listed — somebody else's server is never touched. Project `.mcp.json` files are not read: they
 * belong to a repository, and editing a checked-in file on boot is not agentop's to do.
 */
export function staleAgentisticsMcps(claudeJson: unknown): StaleMcp[] {
  if (!claudeJson || typeof claudeJson !== 'object') return []
  const root = claudeJson as { mcpServers?: unknown; projects?: unknown }
  const out: StaleMcp[] = []
  const servers = (v: unknown): [string, McpEntry][] =>
    v && typeof v === 'object' ? Object.entries(v as Record<string, McpEntry>).filter(([, e]) => e && typeof e === 'object') : []
  for (const [name, entry] of servers(root.mcpServers)) {
    if (name !== CANONICAL_MCP_NAME && isAgentisticsMcp(entry)) out.push({ scope: 'user', name })
  }
  if (root.projects && typeof root.projects === 'object') {
    for (const [project, cfg] of Object.entries(root.projects as Record<string, { mcpServers?: unknown }>)) {
      for (const [name, entry] of servers(cfg?.mcpServers)) {
        if (isAgentisticsMcp(entry)) out.push({ scope: 'local', name, project })
      }
    }
  }
  return out
}

/** The name the canonical registration is kept under, in every harness. */
export const CANONICAL_MCP_NAME = 'agentistics'
