/**
 * AMBIENTE (F3b) — the single list of config files the server's boot rewrites to register its MCP.
 *
 * A throwaway server (`agentop run --rm`) that inherits a real HOME, or a path the real store points at, would write ITS port
 * into the owner's real harness configs. The ambiente watches exactly these files before and after the run (sentinel,
 * `flows/ambiente-host.ts`), so this list must be the SAME one the `ensure*` writers use: they derive their path from
 * `mcpTargetPath`, and `mcp-targets.test.ts` checks the pairing. PURE: no IO, `home` and `env` are arguments.
 */
import { join } from 'node:path'

export type McpHarness = 'claude' | 'codex' | 'gemini' | 'copilot' | 'kimi' | 'opencode' | 'antigravity'
/** A Record so a harness added to `McpHarness` fails the build until it has a path (never a hand-kept list). */
const MCP_PATH_KEYS: Record<McpHarness, true> = { claude: true, codex: true, gemini: true, copilot: true, kimi: true, opencode: true, antigravity: true }
export const MCP_HARNESSES = Object.keys(MCP_PATH_KEYS) as McpHarness[]

export interface McpTarget { harness: McpHarness; path: string }

/** The file a harness's MCP registration lives in, for a given HOME (and the env that moves kimi/opencode). */
export function mcpTargetPath(harness: McpHarness, home: string, env: Record<string, string | undefined> = {}): string {
  switch (harness) {
    case 'claude': return join(home, '.claude.json')
    case 'codex': return join(home, '.codex', 'config.toml')
    case 'gemini': return join(home, '.gemini', 'settings.json')
    case 'copilot': return join(home, '.copilot', 'mcp-config.json')
    case 'kimi': return join(env.KIMI_CODE_HOME || env.KIMI_DIR || join(home, '.kimi-code'), 'mcp.json')
    case 'opencode': return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode', 'opencode.json')
    case 'antigravity': return join(home, '.gemini', 'config', 'mcp_config.json')
  }
}

/** Every file the boot may rewrite: one per harness, plus the config roots of the REAL store's extra accounts. */
export function mcpTargets(home: string, opts: { env?: Record<string, string | undefined>; accountRoots?: ReadonlyArray<{ harness: string; root: string }> } = {}): McpTarget[] {
  const out: McpTarget[] = MCP_HARNESSES.map(harness => ({ harness, path: mcpTargetPath(harness, home, opts.env) }))
  // opencode also reads `.jsonc`: both spellings are watched.
  out.push({ harness: 'opencode', path: mcpTargetPath('opencode', home, opts.env).replace(/\.json$/, '.jsonc') })
  for (const r of opts.accountRoots ?? []) {
    if (r.harness === 'claude') out.push({ harness: 'claude', path: join(r.root, '.claude.json') })
    else if (r.harness === 'codex') out.push({ harness: 'codex', path: join(r.root, 'config.toml') })
    else if (r.harness === 'copilot') out.push({ harness: 'copilot', path: join(r.root, 'mcp-config.json') })
    else if (r.harness === 'gemini') out.push({ harness: 'gemini', path: join(r.root, '.gemini', 'settings.json') })
  }
  return out
}
