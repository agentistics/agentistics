/**
 * kimi-mcp.ts — P-20: the agentistics MCP in KIMI's user-scope config, so a kimi session started by
 * agentop (TUI under tmux, or any one the person starts) has the same tools every other assistant has.
 *
 * Kimi has no `mcp add` subcommand (kimi 2.1.1 `--help`: only the `/mcp-config` skill inside a session),
 * but it reads `$KIMI_CODE_HOME/mcp.json` (default `~/.kimi-code/mcp.json`) at session start. VERIFIED
 * 2026-10-09 against kimi 2.1.1 with a throwaway home: an `agentistics` entry there exposes
 * `mcp__agentistics__<tool>` to the model, over `kimi acp` and over the TUI alike. (A STRUCTURED session
 * does not depend on this file — the driver hands the MCP to `session/new` itself.)
 *
 * The same rules as the other registrations (`chat-drivers/*`): only the canonical server may write the
 * user's config (`mayRegisterHarnessMcp`), the entry launches THIS binary's own `agentop mcp`
 * (`mcp-launch.ts`), the merge preserves every key it did not author, a document it cannot merge into is
 * REFUSED rather than repaired, and running it twice changes nothing.
 */
import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { KIMI_DIR } from './config'
import { agentisticsMcpLaunch, sameMcpLaunch, CANONICAL_MCP_NAME, type McpLaunch } from './mcp-launch'
import { mayRegisterHarnessMcp } from './mcp-registration'

export type KimiMcpPlan =
  | { action: 'noop' }
  | { action: 'write'; text: string }
  | { action: 'refuse'; reason: string }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** PURE. What to do with the current content of `mcp.json` (`null` = no file yet). */
export function planKimiMcp(existing: string | null, want: McpLaunch, apiUrl: string): KimiMcpPlan {
  let doc: Record<string, unknown> = {}
  if (existing !== null && existing.trim() !== '') {
    let parsed: unknown
    try { parsed = JSON.parse(existing) } catch { return { action: 'refuse', reason: 'mcp.json is not valid JSON' } }
    if (!isRecord(parsed)) return { action: 'refuse', reason: 'mcp.json is not a JSON object' }
    doc = parsed
  }
  const servers = doc['mcpServers']
  if (servers !== undefined && !isRecord(servers)) return { action: 'refuse', reason: 'mcp.json "mcpServers" is not an object' }
  const current = servers?.[CANONICAL_MCP_NAME]
  if (isRecord(current) && sameMcpLaunch(current as { command?: unknown; args?: unknown }, want)
      && isRecord(current['env']) && current['env']['AGENTISTICS_API'] === apiUrl) return { action: 'noop' }
  const entry = { ...(isRecord(current) ? current : {}), command: want.command, args: want.args, env: { ...(isRecord(current) && isRecord(current['env']) ? current['env'] : {}), AGENTISTICS_API: apiUrl } }
  return { action: 'write', text: `${JSON.stringify({ ...doc, mcpServers: { ...(servers ?? {}), [CANONICAL_MCP_NAME]: entry } }, null, 2)}\n` }
}

/** Where kimi reads its user-scope MCP servers: `KIMI_CODE_HOME` first, as kimi itself does. */
export function kimiMcpPath(): string {
  return join(process.env.KIMI_CODE_HOME || KIMI_DIR, 'mcp.json')
}

/** UNGATED write of the entry into `file` (the gate is `ensureKimiMcp`'s). Returns what happened. */
export async function writeKimiMcp(file: string, port: number): Promise<'written' | 'unchanged' | 'refused' | 'no-kimi'> {
  if (!existsSync(dirname(file))) return 'no-kimi' // kimi was never run here
  const existing = existsSync(file) ? await readFile(file, 'utf-8') : null
  const plan = planKimiMcp(existing, agentisticsMcpLaunch(), `http://localhost:${port}`)
  if (plan.action === 'noop') return 'unchanged'
  if (plan.action === 'refuse') { console.warn(`[mcp] kimi: left ${file} alone — ${plan.reason}`); return 'refused' }
  const tmp = `${file}.agentop-${process.pid}.tmp`
  await writeFile(tmp, plan.text, { mode: 0o600 })
  await rename(tmp, file)
  return 'written'
}

/** Best-effort, idempotent; a machine without kimi is left untouched (no directory, no file). */
export async function ensureKimiMcp(port: number): Promise<void> {
  if (!mayRegisterHarnessMcp(port)) return
  await writeKimiMcp(kimiMcpPath(), port)
}
