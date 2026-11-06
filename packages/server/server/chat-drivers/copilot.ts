/**
 * Copilot chat driver for the Nay backend.
 *
 * Spawns: copilot -p <prompt> --output-format json [--stream on] --allow-all-tools [--model <m>]
 *
 * Copilot JSON stream event types observed:
 *   assistant.message_delta  → data.deltaContent  (streaming text chunk)
 *   assistant.message        → data.content (complete turn text), data.toolRequests[]
 *   assistant.tool_request   → data.name (tool being called)
 *   result                   → sessionId, exitCode
 */

import path from 'node:path'
import { agentisticsMcpLaunch, sameMcpLaunch } from '../mcp-launch'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { mcpTargetPath } from '../mcp-targets'
import { HOME_DIR } from '../config'
import { mayRegisterHarnessMcp } from '../mcp-registration'
import type { ChatDriver } from './types'
import { findCli } from './cli-detect'


// MCP config file path for copilot
const COPILOT_MCP_CONFIG = mcpTargetPath('copilot', HOME_DIR)


function copilotIsAvailable(): boolean {
  return findCli('copilot')
}

/**
 * Register the agentistics MCP server for Copilot by writing/merging
 * ~/.copilot/mcp-config.json. Idempotent — skips if entry already matches.
 */
async function ensureCopilotMcp(port: number): Promise<void> {
  if (!mayRegisterHarnessMcp(port)) return
  const apiUrl = `http://localhost:${port}`
  // `agentop mcp` on an installed binary, the script in a checkout — see `mcp-launch.ts`.
  const launch = agentisticsMcpLaunch()

  const entry = {
    type: 'stdio' as const,
    command: launch.command,
    args: launch.args,
    env: { AGENTISTICS_API: apiUrl },
  }

  let config: Record<string, unknown> = { mcpServers: {} }

  try {
    const raw = await readFile(COPILOT_MCP_CONFIG, 'utf-8')
    config = JSON.parse(raw) as Record<string, unknown>
    if (!config['mcpServers'] || typeof config['mcpServers'] !== 'object') {
      config['mcpServers'] = {}
    }
  } catch {
    // File doesn't exist or malformed — start fresh
  }

  const servers = config['mcpServers'] as Record<string, unknown>
  const existing = servers['agentistics'] as { env?: Record<string, string>; command?: unknown; args?: unknown } | undefined
  const urlOk = existing?.env?.['AGENTISTICS_API'] === apiUrl

  if (urlOk && sameMcpLaunch(existing, launch)) return // already up to date

  servers['agentistics'] = entry
  await mkdir(path.dirname(COPILOT_MCP_CONFIG), { recursive: true })
  await writeFile(COPILOT_MCP_CONFIG, JSON.stringify(config, null, 2))
}

const COPILOT_CONFIG = path.join(HOME_DIR, '.copilot', 'config.json')

/**
 * Best-effort auth check from ~/.copilot/config.json. The file is JSONC (it has
 * leading `//` comment lines) so we strip line comments before parsing. We treat
 * the user as authenticated if `loggedInUsers` is a non-empty array OR
 * `lastLoggedInUser.login` is set. Returns false on missing file / parse error.
 */
function copilotAuthReady(): boolean {
  try {
    const raw = readFileSync(COPILOT_CONFIG, 'utf-8')
    // Strip whole-line `//` comments (the file is JSONC).
    const stripped = raw.replace(/^\s*\/\/.*$/gm, '')
    const cfg = JSON.parse(stripped) as Record<string, unknown>
    const users = cfg['loggedInUsers']
    if (Array.isArray(users) && users.length > 0) return true
    const last = cfg['lastLoggedInUser'] as { login?: unknown } | undefined
    return typeof last?.login === 'string' && last.login.length > 0
  } catch {
    return false
  }
}

export const copilotDriver: ChatDriver = {
  id: 'copilot',

  label: 'Copilot',

  isAvailable() {
    return copilotIsAvailable()
  },

  authReady() {
    return copilotAuthReady()
  },

  setup: {
    installCmd: 'npm i -g @github/copilot-cli',
    loginCmd: 'gh auth login',
    docUrl: 'https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line',
    note: 'Requires a GitHub Copilot subscription. After installing the CLI, run "gh auth login" to authenticate.',
  },

  async ensureMcp(port: number) {
    await ensureCopilotMcp(port)
  },

}
