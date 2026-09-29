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
import { HOME_DIR } from '../config'
import type { ChatDriver } from './types'
import { findCli } from './cli-detect'


// MCP config file path for copilot
const COPILOT_MCP_CONFIG = path.join(HOME_DIR, '.copilot', 'mcp-config.json')


function copilotIsAvailable(): boolean {
  return findCli('copilot')
}

/**
 * Register the agentistics MCP server for Copilot by writing/merging
 * ~/.copilot/mcp-config.json. Idempotent — skips if entry already matches.
 */
async function ensureCopilotMcp(port: number): Promise<void> {
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

  async stream(message, history, model, cb, _resumeSessionId, opts) {
    // Build inline history prefix (no native resume in copilot -p mode)
    const recent = history.filter(h => h.content.trim()).slice(-8)
    let prompt = ''
    for (const h of recent) {
      prompt += `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}\n\n`
    }
    prompt += recent.length > 0 ? `User: ${message}` : message

    const args = [
      'copilot',
      '-p', prompt,
      '--output-format', 'json',
      '--stream', 'on',
      '--allow-all-tools',
    ]

    if (model && model !== 'auto') {
      args.push('--model', model)
    }

    // Pass agentistics MCP inline so it doesn't require a persisted config
    if (existsSync(COPILOT_MCP_CONFIG)) {
      args.push('--additional-mcp-config', `@${COPILOT_MCP_CONFIG}`)
    }

    try {
      const proc = Bun.spawn(args, {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'inherit',
      })

      opts?.signal?.addEventListener(
        'abort',
        () => { try { proc.kill() } catch { /* already dead */ } },
        { once: true },
      )

      const decoder = new TextDecoder()
      let lineBuffer = ''
      let gotResult = false
      const seenTools = new Set<string>()

      for await (const raw of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
        lineBuffer += decoder.decode(raw, { stream: true })
        const lines = lineBuffer.split('\n')
        lineBuffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const event = JSON.parse(trimmed) as Record<string, unknown>
            const type = event['type'] as string | undefined

            if (type === 'assistant.message_delta') {
              // Streaming text delta — primary source of incremental text
              const data = event['data'] as { deltaContent?: string } | undefined
              if (typeof data?.deltaContent === 'string' && data.deltaContent) {
                cb.onChunk(data.deltaContent)
              }
            } else if (type === 'assistant.message') {
              // Complete turn — emit any tool requests and session info
              const data = event['data'] as {
                content?: string
                toolRequests?: Array<{ name?: string; toolName?: string }>
                model?: string
              } | undefined
              // Emit tool names
              for (const tool of data?.toolRequests ?? []) {
                const name = tool.name ?? tool.toolName ?? ''
                if (name && !seenTools.has(name)) {
                  seenTools.add(name)
                  cb.onTool(name)
                }
              }
            } else if (type === 'assistant.tool_request') {
              // Tool request event (may appear separately)
              const data = event['data'] as { name?: string; toolName?: string } | undefined
              const name = data?.name ?? data?.toolName ?? ''
              if (name && !seenTools.has(name)) {
                seenTools.add(name)
                cb.onTool(name)
              }
            } else if (type === 'result') {
              gotResult = true
              const ev = event as { sessionId?: string; exitCode?: number }
              if (ev.sessionId && cb.onSessionId) cb.onSessionId(ev.sessionId)
              if (ev.exitCode !== 0) {
                cb.onError(`copilot CLI exited with code ${ev.exitCode ?? 'unknown'}`)
                return
              }
            }
          } catch { /* ignore malformed lines */ }
        }
      }

      const exit = await proc.exited
      if (exit !== 0 && !gotResult) {
        const errText = await new Response(proc.stderr).text()
        cb.onError(`copilot CLI exited with code ${exit}: ${errText.slice(0, 300)}`)
        return
      }
      cb.onDone()
    } catch (err) {
      cb.onError(`copilot not found or failed to start: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
}
