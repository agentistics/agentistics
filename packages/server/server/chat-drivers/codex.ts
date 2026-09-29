/**
 * Codex CLI chat driver for the Nay backend.
 *
 * Spawns `codex exec --json --skip-git-repo-check -m <model>`,
 * pipes the prompt to stdin (with inline history for new sessions),
 * and parses the JSONL events emitted on stdout.
 *
 * Codex exec --json event schema (verified by live invocation, gpt-5.4-mini):
 *   { type: "thread.started",  thread_id: string }              → session ID
 *   { type: "turn.started" }                                    → begin
 *   { type: "item.started",   item: { id, type, ... } }        → item begins
 *   { type: "item.completed", item: { id, type, text?, name?, ... } }
 *       item.type === "agent_message"    → full response text  (→ onChunk)
 *       item.type === "mcp_tool_call_begin" / "exec_command_begin" → tool call (→ onTool)
 *   { type: "agent_message_delta", delta: string }              → incremental chunk (if streaming)
 *   { type: "turn.completed", usage: { input_tokens, cached_input_tokens, output_tokens } }
 *   { type: "turn.failed",    error: { message: string } }      → fatal
 *   { type: "error",          message: string }                 → fatal
 *   { type: "stream_error",   message?: string }                → fatal
 *
 * Codex does not support session resume via --resume in exec mode; history is
 * inlined into the prompt as labelled turns (same approach as streamViaClaude).
 */

import path from 'node:path'
import { agentisticsMcpLaunch } from '../mcp-launch'
import { existsSync } from 'node:fs'
import { HOME_DIR } from '../config'
import type { ChatDriver } from './types'
import type { ChatMessage } from '../chat-tty'
import { findCli } from './cli-detect'

// chat-drivers/ is one level deeper than chat-tty.ts, so 4 levels up to reach the repo root
const CODEX_CONFIG_PATH = path.join(HOME_DIR, '.codex', 'config.toml')
const CODEX_AUTH_PATH = path.join(HOME_DIR, '.codex', 'auth.json')
const MCP_SERVER_NAME = 'agentistics'

function codexIsAvailable(): boolean {
  return findCli('codex')
}

/**
 * Read ~/.codex/config.toml as raw text.
 * Returns empty string if missing or unreadable.
 */
async function readCodexConfig(): Promise<string> {
  try {
    return await Bun.file(CODEX_CONFIG_PATH).text()
  } catch {
    return ''
  }
}

/**
 * Register the agentistics MCP server for Codex via `codex mcp add`.
 * Idempotent — skips if already registered with the same URL and script path.
 *
 * Codex writes MCP servers to ~/.codex/config.toml under [mcp_servers.<name>].
 * We check the raw TOML for the AGENTISTICS_API URL and script path to avoid
 * re-registering on every server restart.
 */
async function ensureCodexMcp(port: number): Promise<void> {
  const apiUrl = `http://localhost:${port}`
  // `agentop mcp` on an installed binary, the script in a checkout — see `mcp-launch.ts`.
  const launch = agentisticsMcpLaunch()

  // Quick idempotency check: if the URL and every piece of the launch already appear in the
  // config, skip re-registration (same approach as registerMcpGlobally for Claude).
  const rawConfig = await readCodexConfig()
  const urlOk = rawConfig.includes(apiUrl)
  const launchOk = [launch.command, ...launch.args].every(part => rawConfig.includes(part))
    && !(launch.command !== 'bun' && rawConfig.includes('agentistics-mcp.ts'))
  if (urlOk && launchOk) return

  // A stale entry (the old script path) is removed first, so the add below cannot collide with it.
  if (rawConfig.includes(`mcp_servers.${MCP_SERVER_NAME}`)) {
    await Bun.spawn(['codex', 'mcp', 'remove', MCP_SERVER_NAME], { stdout: 'pipe', stderr: 'pipe' }).exited
  }

  // Use the Codex CLI to add at user scope
  const proc = Bun.spawn(
    [
      'codex', 'mcp', 'add',
      '--env', `AGENTISTICS_API=${apiUrl}`,
      MCP_SERVER_NAME,
      '--', launch.command, ...launch.args,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  await proc.exited
}

/**
 * Build the inline prompt string that includes recent history.
 * Codex exec does not support session resume in headless mode, so history is
 * prepended as labelled turns (same approach as streamViaClaude for new sessions).
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

// Codex exec --json event types (only the fields we care about)
type CodexThreadStartedEvent  = { type: 'thread.started';  thread_id: string }
type CodexItemCompletedEvent  = { type: 'item.completed';  item: { type: string; text?: string; name?: string } }
type CodexMessageDeltaEvent   = { type: 'agent_message_delta'; delta: string }
type CodexTurnCompletedEvent  = { type: 'turn.completed';  usage?: { input_tokens?: number; output_tokens?: number } }
type CodexTurnFailedEvent     = { type: 'turn.failed';     error: { message: string } }
type CodexErrorEvent          = { type: 'error' | 'stream_error'; message?: string }

type CodexExecEvent =
  | CodexThreadStartedEvent
  | CodexItemCompletedEvent
  | CodexMessageDeltaEvent
  | CodexTurnCompletedEvent
  | CodexTurnFailedEvent
  | CodexErrorEvent
  | { type: string }

export const codexDriver: ChatDriver = {
  id: 'codex',
  label: 'Codex',

  isAvailable() {
    return codexIsAvailable()
  },

  authReady() {
    return existsSync(CODEX_AUTH_PATH)
  },

  setup: {
    installCmd: 'npm i -g @openai/codex',
    loginCmd: 'codex login',
    docUrl: 'https://github.com/openai/codex',
  },

  async ensureMcp(port: number) {
    await ensureCodexMcp(port)
  },

  async stream(message, history, model, cb, _resumeSessionId, opts) {
    // Codex exec does not support session resume in --json headless mode;
    // always inline history into the prompt.
    const prompt = buildPrompt(message, history)

    const args = [
      'codex', 'exec',
      '--json',
      '--skip-git-repo-check',
      ...(model ? ['-m', model] : []),
      '-',  // read prompt from stdin
    ]

    try {
      const proc = Bun.spawn(args, {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'pipe',
      })

      // Honor abort signal
      opts?.signal?.addEventListener('abort', () => {
        try { proc.kill() } catch { /* already dead */ }
      }, { once: true })

      // Write prompt to stdin then close
      proc.stdin.write(prompt)
      proc.stdin.end()

      const decoder = new TextDecoder()
      let lineBuffer = ''
      let gotCompletion = false
      const seenTools = new Set<string>()
      // Track whether any delta was emitted for the current turn.
      // If deltas arrived, item.completed's full text is a duplicate — skip it.
      let turnHadDeltas = false

      for await (const raw of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
        if (opts?.signal?.aborted) break
        lineBuffer += decoder.decode(raw, { stream: true })
        const lines = lineBuffer.split('\n')
        lineBuffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          let event: CodexExecEvent
          try {
            event = JSON.parse(trimmed) as CodexExecEvent
          } catch {
            continue // ignore malformed lines
          }

          switch (event.type) {
            case 'thread.started': {
              const ev = event as CodexThreadStartedEvent
              if (ev.thread_id && cb.onSessionId) cb.onSessionId(ev.thread_id)
              break
            }

            case 'item.completed': {
              const ev = event as CodexItemCompletedEvent
              const item = ev.item
              if (item.type === 'agent_message' && typeof item.text === 'string' && item.text) {
                // Only use the full text when no streaming deltas were emitted for this
                // turn — otherwise the content was already streamed and this would duplicate it.
                if (!turnHadDeltas) {
                  cb.onChunk(item.text)
                }
              } else if (
                (item.type === 'mcp_tool_call_begin' || item.type === 'exec_command_begin') &&
                typeof item.name === 'string'
              ) {
                if (!seenTools.has(item.name)) {
                  seenTools.add(item.name)
                  cb.onTool(item.name)
                }
              }
              break
            }

            case 'agent_message_delta': {
              // Incremental text chunk — emitted when Codex streams long responses.
              // Mark this turn as having deltas so item.completed full text is skipped.
              const ev = event as CodexMessageDeltaEvent
              if (typeof ev.delta === 'string' && ev.delta) {
                turnHadDeltas = true
                cb.onChunk(ev.delta)
              }
              break
            }

            case 'turn.completed': {
              gotCompletion = true
              // Reset delta flag for the next turn
              turnHadDeltas = false
              break
            }

            case 'turn.failed': {
              const ev = event as CodexTurnFailedEvent
              cb.onError(ev.error?.message ?? 'codex CLI error')
              return
            }

            case 'error':
            case 'stream_error': {
              const ev = event as CodexErrorEvent
              cb.onError(ev.message ?? 'codex CLI error')
              return
            }

            default:
              break
          }
        }
      }

      const exitCode = await proc.exited
      if (exitCode !== 0 && !gotCompletion) {
        const errText = await new Response(proc.stderr).text()
        cb.onError(`codex CLI exited with code ${exitCode}: ${errText.slice(0, 300)}`)
        return
      }
      cb.onDone()
    } catch (err) {
      cb.onError(`codex not found or failed to start: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
}
