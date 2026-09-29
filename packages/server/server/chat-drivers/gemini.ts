/**
 * Gemini CLI chat driver for the Nay backend.
 *
 * Spawns `gemini --prompt <text> -o stream-json -m <model> --approval-mode yolo`,
 * pipes the prompt to stdin (with inline history), and parses the JSONL stream-json
 * events emitted on stdout.
 *
 * Gemini stream-json event schema (from source analysis of @google/gemini-cli bundle):
 *   { type: "init",        timestamp, session_id, model }
 *   { type: "message",     timestamp, role: "user"|"assistant", content, delta?: true }
 *   { type: "tool_use",    timestamp, tool_name, tool_id, parameters }
 *   { type: "tool_result", timestamp, tool_id, status, output, error? }
 *   { type: "error",       timestamp, severity, message }
 *   { type: "result",      timestamp, status: "success"|"error", stats, error? }
 */

import path from 'node:path'
import { agentisticsMcpLaunch, sameMcpLaunch } from '../mcp-launch'
import { existsSync } from 'node:fs'
import { HOME_DIR } from '../config'
import type { ChatDriver } from './types'
import type { ChatMessage } from '../chat-tty'
import { findCli } from './cli-detect'

// chat-drivers/ is one level deeper than chat-tty.ts, so 4 levels up to reach the repo root
const GEMINI_SETTINGS_PATH = path.join(HOME_DIR, '.gemini', 'settings.json')
const GEMINI_OAUTH_PATH = path.join(HOME_DIR, '.gemini', 'oauth_creds.json')
const MCP_SERVER_NAME = 'agentistics'

function geminiIsAvailable(): boolean {
  return findCli('gemini')
}

/**
 * Read the user-scope Gemini settings (~/.gemini/settings.json).
 * Returns an empty object if missing or invalid.
 */
async function readGeminiSettings(): Promise<Record<string, unknown>> {
  try {
    const raw = await Bun.file(GEMINI_SETTINGS_PATH).text()
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

async function writeGeminiSettings(settings: Record<string, unknown>): Promise<void> {
  await Bun.write(GEMINI_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n')
}

/**
 * Register the agentistics MCP server in Gemini user-scope settings.
 * Idempotent — skips if already registered with the same port.
 */
async function ensureGeminiMcp(port: number): Promise<void> {
  const apiUrl = `http://localhost:${port}`
  // `agentop mcp` on an installed binary, the script in a checkout — see `mcp-launch.ts`.
  const launch = agentisticsMcpLaunch()

  const settings = await readGeminiSettings()
  const servers = (settings['mcpServers'] ?? {}) as Record<string, {
    command?: string
    args?: string[]
    env?: Record<string, string>
  }>

  const existing = servers[MCP_SERVER_NAME]
  const urlOk = existing?.env?.['AGENTISTICS_API'] === apiUrl
  if (urlOk && sameMcpLaunch(existing, launch)) return // already up to date

  // A stale entry (the old script path) is removed first, so the add below replaces it rather
  // than colliding with it.
  if (existing) {
    await Bun.spawn(['gemini', 'mcp', 'remove', '-s', 'user', MCP_SERVER_NAME], { stdout: 'pipe', stderr: 'pipe' }).exited
  }

  // Use the CLI to add at user scope — this is the canonical way and handles
  // the trust / settings merge correctly.
  const proc = Bun.spawn(
    [
      'gemini', 'mcp', 'add', '-s', 'user', '--trust',
      '-e', `AGENTISTICS_API=${apiUrl}`,
      MCP_SERVER_NAME,
      launch.command, ...launch.args,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  await proc.exited
}

/**
 * Build the inline prompt string that includes recent history.
 * Gemini CLI does not support session resume via ID in headless mode,
 * so history is prepended as labelled turns (same approach as streamViaClaude).
 */
function buildPrompt(message: string, history: ChatMessage[]): string {
  const recent = history.filter(h => h.content.trim()).slice(-8)
  if (recent.length === 0) return message
  let prompt = ''
  for (const h of recent) {
    prompt += `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}\n\n`
  }
  prompt += `User: ${message}`
  return prompt
}

// Gemini stream-json event shapes (only the fields we care about)
type GeminiInitEvent       = { type: 'init';        session_id?: string; model?: string }
type GeminiMessageEvent    = { type: 'message';     role: string; content: string; delta?: boolean }
type GeminiToolUseEvent    = { type: 'tool_use';    tool_name: string }
type GeminiResultEvent     = { type: 'result';      status: 'success' | 'error'; error?: { message?: string } }
type GeminiErrorEvent      = { type: 'error';       severity: string; message: string }
type GeminiEvent =
  | GeminiInitEvent
  | GeminiMessageEvent
  | GeminiToolUseEvent
  | GeminiResultEvent
  | GeminiErrorEvent
  | { type: string }

export const geminiDriver: ChatDriver = {
  id: 'gemini',
  label: 'Gemini',

  isAvailable() {
    return geminiIsAvailable()
  },

  authReady() {
    return existsSync(GEMINI_OAUTH_PATH)
  },

  setup: {
    installCmd: 'npm i -g @google/gemini-cli',
    loginCmd: 'gemini',
    docUrl: 'https://goo.gle/gemini-cli',
    note: 'Free-tier access has been discontinued for some accounts and migrated to Antigravity (https://antigravity.google). If you receive an IneligibleTierError at runtime, visit the Antigravity link to check your account eligibility.',
  },

  async ensureMcp(port: number) {
    await ensureGeminiMcp(port)
  },

  async stream(message, history, model, cb, _resumeSessionId, opts) {
    const prompt = buildPrompt(message, history)

    const args = [
      'gemini',
      '--prompt', prompt,
      '-o', 'stream-json',
      ...(model ? ['-m', model] : []),
      '--approval-mode', 'yolo',
    ]

    try {
      const proc = Bun.spawn(args, {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'pipe',
      })

      // Signal-based abort
      opts?.signal?.addEventListener('abort', () => {
        try { proc.kill() } catch { /* already dead */ }
      }, { once: true })

      // Close stdin immediately — prompt is passed via --prompt flag
      proc.stdin.end()

      const decoder = new TextDecoder()
      let lineBuffer = ''
      let gotResult = false
      const seenTools = new Set<string>()

      for await (const raw of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
        if (opts?.signal?.aborted) break
        lineBuffer += decoder.decode(raw, { stream: true })
        const lines = lineBuffer.split('\n')
        lineBuffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          let event: GeminiEvent
          try {
            event = JSON.parse(trimmed) as GeminiEvent
          } catch {
            continue // ignore malformed lines (ANSI warnings etc.)
          }

          switch (event.type) {
            case 'init': {
              const ev = event as GeminiInitEvent
              if (ev.session_id && cb.onSessionId) cb.onSessionId(ev.session_id)
              break
            }
            case 'message': {
              const ev = event as GeminiMessageEvent
              // Only emit assistant delta messages as text chunks
              if (ev.role === 'assistant' && ev.delta && typeof ev.content === 'string' && ev.content) {
                cb.onChunk(ev.content)
              }
              break
            }
            case 'tool_use': {
              const ev = event as GeminiToolUseEvent
              if (typeof ev.tool_name === 'string' && !seenTools.has(ev.tool_name)) {
                seenTools.add(ev.tool_name)
                cb.onTool(ev.tool_name)
              }
              break
            }
            case 'result': {
              gotResult = true
              const ev = event as GeminiResultEvent
              if (ev.status === 'error') {
                cb.onError(ev.error?.message ?? 'gemini CLI error')
                return
              }
              // status === 'success' — fall through to onDone below
              break
            }
            case 'error': {
              const ev = event as GeminiErrorEvent
              // Only treat severity=error as fatal — warnings are non-blocking
              if (ev.severity === 'error') {
                cb.onError(ev.message ?? 'gemini CLI error')
                return
              }
              break
            }
            default:
              break
          }
        }
      }

      const exitCode = await proc.exited
      if (exitCode !== 0 && !gotResult) {
        const errText = await new Response(proc.stderr).text()
        cb.onError(`gemini CLI exited with code ${exitCode}: ${errText.slice(0, 300)}`)
        return
      }
      cb.onDone()
    } catch (err) {
      cb.onError(`gemini not found or failed to start: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
}
