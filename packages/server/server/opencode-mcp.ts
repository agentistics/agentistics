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
 * opencode merges `opencode.json` and `opencode.jsonc`, and BOTH may carry comments and trailing commas (JSONC).
 *
 * OPENCODE.PAPÉIS (measured 2026-10-31, opencode 1.19.5, `opencode debug config` in a scratch HOME): the merge is
 * per key and `.jsonc` WINS over `.json`. A commented file is never rewritten (a rewrite would drop the person's
 * comments), so `planOpencodeMcpFiles` reads both as JSONC and puts our entry where it both TAKES EFFECT and can be
 * written losslessly: the file that already holds it, else a plain `.json`, else the sibling `.jsonc` (which wins).
 * A commented file that already carries our exact entry is fine as it is. Before this, one comment in the person's
 * `opencode.json` (a custom provider, typically) left every opencode session without the agentistics tools.
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

/** PURE. JSONC -> JSON text: line and block comments and trailing commas removed, strings left intact. */
export function stripJsonc(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1); i = j + 1; continue
    }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue }
    if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; continue }
    if (c === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j]!)) j++
      if (text[j] === '}' || text[j] === ']') { i++; continue }
    }
    out += c; i++
  }
  return out
}

type Parsed = { doc: Record<string, unknown>; plain: boolean } | { refuse: string }

function parseDoc(existing: string | null): Parsed {
  if (existing === null || existing.trim() === '') return { doc: {}, plain: true }
  let parsed: unknown
  let plain = true
  try { parsed = JSON.parse(existing) } catch {
    plain = false
    try { parsed = JSON.parse(stripJsonc(existing)) } catch { return { refuse: 'the opencode config does not parse (a syntax error)' } }
  }
  if (!isRecord(parsed)) return { refuse: 'the opencode config is not a JSON object' }
  return { doc: parsed, plain }
}

const COMMENTED = 'the opencode config has comments, and rewriting it would drop them'

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
  if (!r.plain) return { action: 'refuse', reason: COMMENTED }
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
  if (!r.plain) return { action: 'refuse', reason: COMMENTED }
  const { [CANONICAL_MCP_NAME]: _gone, ...rest } = servers
  const { mcp: _m, ...others } = r.doc
  const next = Object.keys(rest).length > 0 ? { ...others, mcp: rest } : others
  return { action: 'write', text: `${JSON.stringify(next, null, 2)}\n` }
}

export type OpencodeConfigName = 'opencode.json' | 'opencode.jsonc'

/**
 * PURE. Which of the two user-scope files gets our entry, given their contents (`null` = absent), and what to do
 * to it. `.jsonc` overrides `.json` key by key, so an entry in `.jsonc` is the one that counts.
 */
export function planOpencodeMcpFiles(
  files: { json: string | null; jsonc: string | null }, want: McpLaunch, apiUrl: string,
): { file: OpencodeConfigName; plan: OpencodeMcpPlan } {
  const json = { name: 'opencode.json' as const, text: files.json, parsed: parseDoc(files.json) }
  const jsonc = { name: 'opencode.jsonc' as const, text: files.jsonc, parsed: parseDoc(files.jsonc) }
  const holds = (p: Parsed) => 'doc' in p && isRecord(p.doc['mcp']) && CANONICAL_MCP_NAME in (p.doc['mcp'] as Record<string, unknown>)
  const plan = (f: typeof json | typeof jsonc) => ({ file: f.name, plan: planOpencodeMcp(f.text, want, apiUrl) })
  // The winning file already names us: only there can the entry be fixed.
  if (files.jsonc !== null && holds(jsonc.parsed)) return plan(jsonc)
  if (files.json !== null) {
    const p = plan(json)
    if (p.plan.action !== 'refuse' || !('doc' in json.parsed)) return p
    // A commented `.json`: write the sibling `.jsonc` instead (it wins), unless it is commented too.
    if (files.jsonc === null || ('doc' in jsonc.parsed && jsonc.parsed.plain)) return plan(jsonc)
    return p
  }
  if (files.jsonc !== null) {
    const p = plan(jsonc)
    // A commented `.jsonc` without our entry: a new `.json` beside it takes effect for that key.
    return p.plan.action === 'refuse' && 'doc' in jsonc.parsed ? plan(json) : p
  }
  return plan(json)
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

/** Both user-scope files, read as they are, and the one `planOpencodeMcpFiles` picks written. */
export async function writeOpencodeMcpDir(dir: string, port: number): Promise<'written' | 'unchanged' | 'refused' | 'no-opencode'> {
  if (!existsSync(dir)) return 'no-opencode'
  const read = async (n: OpencodeConfigName) => existsSync(join(dir, n)) ? await readFile(join(dir, n), 'utf-8') : null
  const pick = planOpencodeMcpFiles({ json: await read('opencode.json'), jsonc: await read('opencode.jsonc') }, agentisticsMcpLaunch(), `http://localhost:${port}`)
  return apply(join(dir, pick.file), pick.plan)
}

/** Best-effort, idempotent; a machine without opencode is left untouched. */
export async function ensureOpencodeMcp(port: number): Promise<void> {
  if (!mayRegisterHarnessMcp(port)) return
  await writeOpencodeMcpDir(opencodeConfigDir(), port)
}
