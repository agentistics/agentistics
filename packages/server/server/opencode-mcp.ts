/**
 * opencode-mcp.ts — the agentistics MCP in OPENCODE's user-scope config, so an opencode session started
 * by agentop under tmux (the TUI route) or by the person has the same tools every other assistant has.
 * A STRUCTURED (ACP) session does not depend on this file — the driver hands the MCP to `session/new`.
 *
 * FORMAT MEASURED 2026-10-30 against opencode 1.17.9 in a throwaway HOME (`agentop run --rm`):
 * `opencode mcp add agentistics --env AGENTISTICS_API=… -- <cmd> <args>` creates
 * `$XDG_CONFIG_HOME/opencode/opencode.jsonc` (default `~/.config/opencode/`) holding
 * `{"$schema":"https://opencode.ai/config.json","mcp":{"agentistics":{"type":"local",
 *   "command":[cmd,...args],"environment":{"AGENTISTICS_API":"…"}}}}` — note `command` is ONE ARRAY and the
 * env key is `environment`, unlike kimi's `command`+`args`+`env`. `opencode mcp list` read it back.
 * opencode merges `opencode.json` and `opencode.jsonc`; we edit whichever exists (`.json` first) and create
 * `.json` otherwise. A file with comments does not parse as JSON and is REFUSED, never rewritten.
 */
import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { HOME_DIR } from './config'
import { agentisticsMcpLaunch, CANONICAL_MCP_NAME, type McpLaunch } from './mcp-launch'
import { mayRegisterHarnessMcp } from './mcp-registration'

export type OpencodeMcpPlan =
  | { action: 'noop' }
  | { action: 'write'; text: string }
  | { action: 'refuse'; reason: string }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function parseDoc(existing: string | null): { doc: Record<string, unknown> } | { refuse: string } {
  if (existing === null || existing.trim() === '') return { doc: {} }
  let parsed: unknown
  try { parsed = JSON.parse(existing) } catch { return { refuse: 'the opencode config is not plain JSON (comments or a syntax error)' } }
  if (!isRecord(parsed)) return { refuse: 'the opencode config is not a JSON object' }
  return { doc: parsed }
}

/** PURE. What to do with the current content of the opencode config (`null` = no file yet). */
export function planOpencodeMcp(existing: string | null, want: McpLaunch, apiUrl: string): OpencodeMcpPlan {
  const r = parseDoc(existing)
  if ('refuse' in r) return { action: 'refuse', reason: r.refuse }
  const doc = r.doc
  const servers = doc['mcp']
  if (servers !== undefined && !isRecord(servers)) return { action: 'refuse', reason: 'the opencode config "mcp" is not an object' }
  const current = servers?.[CANONICAL_MCP_NAME]
  const command = [want.command, ...want.args]
  const cur = isRecord(current) ? current : {}
  const curEnv = isRecord(cur['environment']) ? cur['environment'] : {}
  const curCommand: unknown[] | null = Array.isArray(cur['command']) ? cur['command'] : null
  if (cur['type'] === 'local' && curCommand !== null && curCommand.length === command.length
      && command.every((c, i) => curCommand[i] === c) && curEnv['AGENTISTICS_API'] === apiUrl) return { action: 'noop' }
  const entry = { ...cur, type: 'local', command, environment: { ...curEnv, AGENTISTICS_API: apiUrl } }
  const next = { ...(existing === null || existing.trim() === '' ? { $schema: 'https://opencode.ai/config.json' } : {}), ...doc, mcp: { ...(servers ?? {}), [CANONICAL_MCP_NAME]: entry } }
  return { action: 'write', text: `${JSON.stringify(next, null, 2)}\n` }
}

/** PURE. The config without our entry (other servers and keys untouched), or noop when we are not in it. */
export function planOpencodeMcpRemoval(existing: string | null): OpencodeMcpPlan {
  if (existing === null) return { action: 'noop' }
  const r = parseDoc(existing)
  if ('refuse' in r) return { action: 'refuse', reason: r.refuse }
  const servers = r.doc['mcp']
  if (!isRecord(servers)) return { action: 'noop' }
  if (!(CANONICAL_MCP_NAME in servers)) return { action: 'noop' }
  const { [CANONICAL_MCP_NAME]: _gone, ...rest } = servers
  const { mcp: _m, ...others } = r.doc
  const next = Object.keys(rest).length > 0 ? { ...others, mcp: rest } : others
  return { action: 'write', text: `${JSON.stringify(next, null, 2)}\n` }
}

/** The directory opencode reads its user-scope config from (`XDG_CONFIG_HOME` first, as opencode does). */
export function opencodeConfigDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(HOME_DIR, '.config'), 'opencode')
}

/** Which file we edit: `opencode.json` if present, else `opencode.jsonc` if present, else a new `.json`. */
export function opencodeMcpPath(): string {
  const dir = opencodeConfigDir()
  for (const name of ['opencode.json', 'opencode.jsonc']) if (existsSync(join(dir, name))) return join(dir, name)
  return join(dir, 'opencode.json')
}

async function apply(file: string, plan: OpencodeMcpPlan): Promise<'written' | 'unchanged' | 'refused'> {
  if (plan.action === 'noop') return 'unchanged'
  if (plan.action === 'refuse') { console.warn(`[mcp] opencode: left ${file} alone — ${plan.reason}`); return 'refused' }
  const tmp = `${file}.agentop-${process.pid}.tmp`
  await writeFile(tmp, plan.text, { mode: 0o600 })
  await rename(tmp, file)
  return 'written'
}

/** UNGATED write (the gate is `ensureOpencodeMcp`'s). A machine where opencode never ran has no config dir. */
export async function writeOpencodeMcp(file: string, port: number): Promise<'written' | 'unchanged' | 'refused' | 'no-opencode'> {
  if (!existsSync(dirname(file))) return 'no-opencode'
  const existing = existsSync(file) ? await readFile(file, 'utf-8') : null
  return apply(file, planOpencodeMcp(existing, agentisticsMcpLaunch(), `http://localhost:${port}`))
}

/** UNGATED removal of our entry; leaves everything else in the file. */
export async function removeOpencodeMcp(file: string): Promise<'written' | 'unchanged' | 'refused'> {
  if (!existsSync(file)) return 'unchanged'
  return apply(file, planOpencodeMcpRemoval(await readFile(file, 'utf-8')))
}

/** Best-effort, idempotent; a machine without opencode is left untouched. */
export async function ensureOpencodeMcp(port: number): Promise<void> {
  if (!mayRegisterHarnessMcp(port)) return
  await writeOpencodeMcp(opencodeMcpPath(), port)
}
