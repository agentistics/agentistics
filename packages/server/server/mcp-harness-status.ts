/**
 * mcp-harness-status.ts — PURE: what each harness's OWN `mcp list` says about a server, as one shape.
 *
 * A person whose Figma server read "Needs authentication" stopped using the product, so the state
 * of an MCP server has to be said honestly and the same way for every assistant. The rules:
 *
 * - **Read it from the harness, never guess it.** Every parser below was written against output
 *   captured from the installed CLI (versions in `HARNESS_MCP.measured`); the fixtures in
 *   `mcp-harness-status.test.ts` are those captures.
 * - **A state the harness does not report is not invented.** Codex reports whether credentials
 *   exist, not whether the server answers (`authenticated`); Gemini says `Disconnected` without
 *   saying why (`disconnected`); Copilot and Antigravity list configuration and nothing else
 *   (`unknown`). A confident `connected` is only ever printed where the harness itself printed one.
 * - **A parser that cannot read its input answers `null`, never an empty list.** "I could not read
 *   that" and "there are no servers" are different facts and a surface renders them differently.
 */

import type { HarnessId } from '@agentistics/core'

export type McpAuthState =
  /** The harness connected to it just now. */
  | 'connected'
  /** Credentials are stored; the harness did not say whether the server answered. */
  | 'authenticated'
  /** The server asked for OAuth and no valid credentials are stored. The case that lost a user. */
  | 'needs-auth'
  /** Not connected, and the harness does not say why (it may be auth, it may be a crash). */
  | 'disconnected'
  /** The harness tried and failed — `detail` carries its own words. */
  | 'error'
  | 'disabled'
  /** Configured in a repository file the user has not approved yet (Claude Code's `.mcp.json`). */
  | 'pending'
  /** Listed, but the harness reports no health for it. */
  | 'unknown'

export interface McpHarnessServer {
  name: string
  /** URL or command, exactly as the harness printed it. */
  target: string
  transport?: 'stdio' | 'http' | 'sse'
  state: McpAuthState
  /** The harness's own words for a failure or a caveat. Never a secret: it is what `mcp list` printed. */
  detail?: string
}

/** What the parser could tell beyond the rows. */
export interface McpListParse {
  servers: McpHarnessServer[]
  /** Gemini only enables MCP in trusted folders and says so in a warning line. */
  untrustedFolder?: boolean
}

// biome-ignore lint: ANSI is the point
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
export function stripAnsi(s: string): string { return s.replace(ANSI, '') }

function transportOfTarget(target: string, hint?: string): McpHarnessServer['transport'] {
  const h = (hint ?? '').toLowerCase()
  if (h === 'sse') return 'sse'
  if (h === 'http' || h === 'streamable_http') return 'http'
  if (h === 'stdio' || h === 'local') return 'stdio'
  return /^https?:\/\//i.test(target) ? 'http' : 'stdio'
}

// ---- Claude Code ---------------------------------------------------------------------------------

/**
 * `claude mcp list` (2.1.295):
 *
 *   Checking MCP server health…
 *
 *   figma: https://mcp.figma.com/mcp (HTTP) - ! Needs authentication
 *   plugin:figma:figma: https://mcp.figma.com/mcp (HTTP) - ! Needs authentication
 *   echo: bun run /x/mcp-echo.ts - ✔ Connected
 *   broken: /nonexistent/bin  - ✘ Failed to connect — ENOENT: …
 *
 * The name can hold colons (`plugin:figma:figma`) and spaces (`claude.ai Figma`), so it is split at
 * the first `": "` — a colon followed by a space — which no name and no URL contains.
 */
const CLAUDE_ROW = /^(.+?): (.*?)\s+- ([✔✓✘!⏸⚠○])\s*(.*)$/u

export function claudeStateOf(text: string): { state: McpAuthState; detail?: string } {
  const t = text.trim()
  if (/needs authentication|needs auth|authentication required|not authenticated/i.test(t)) return { state: 'needs-auth' }
  if (/^connected/i.test(t)) return { state: 'connected' }
  if (/pending approval/i.test(t)) return { state: 'pending' }
  if (/^disabled/i.test(t)) return { state: 'disabled' }
  if (/fail|error|refused|timed out/i.test(t)) return { state: 'error', detail: t.replace(/^failed to connect\s*[—-]?\s*/i, '') || t }
  return { state: 'unknown', ...(t ? { detail: t } : {}) }
}

export function parseClaudeMcpList(out: string): McpListParse | null {
  const text = stripAnsi(out)
  if (/no mcp servers configured/i.test(text)) return { servers: [] }
  const servers: McpHarnessServer[] = []
  let sawHeader = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (/^checking mcp server health/i.test(line)) { sawHeader = true; continue }
    const m = CLAUDE_ROW.exec(line)
    if (!m) continue
    const [, name, targetRaw, , status] = m
    const hint = /\((HTTP|SSE|STDIO)\)\s*$/i.exec(targetRaw!)
    const target = targetRaw!.replace(/\s*\((HTTP|SSE|STDIO)\)\s*$/i, '').trim()
    const s = claudeStateOf(status!)
    servers.push({
      name: name!, target, transport: transportOfTarget(target, hint?.[1]),
      state: s.state, ...(s.detail ? { detail: s.detail } : {}),
    })
  }
  if (servers.length === 0 && !sawHeader) return null
  return { servers }
}

// ---- Codex ---------------------------------------------------------------------------------------

/**
 * `codex mcp list --json` (0.161.0): an array with `auth_status` per server — `not_logged_in`,
 * `bearer_token`, `unsupported` (a stdio server has no auth concept) and, once signed in, an OAuth
 * value. Codex reports CREDENTIALS, not health, so a signed-in server is `authenticated`, never
 * `connected`.
 */
export function parseCodexMcpListJson(out: string): McpListParse | null {
  let doc: unknown
  try { doc = JSON.parse(out) } catch { return null }
  if (!Array.isArray(doc)) return null
  const servers: McpHarnessServer[] = []
  for (const raw of doc) {
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>
    const name = typeof r.name === 'string' ? r.name : ''
    if (!name) continue
    const t = (typeof r.transport === 'object' && r.transport !== null ? r.transport : {}) as Record<string, unknown>
    const isHttp = typeof t.url === 'string'
    const target = isHttp ? String(t.url) : [t.command, ...(Array.isArray(t.args) ? t.args : [])].filter(x => typeof x === 'string' && x).join(' ')
    const auth = typeof r.auth_status === 'string' ? r.auth_status : ''
    let state: McpAuthState
    let detail: string | undefined
    if (r.enabled === false) {
      state = 'disabled'
      if (typeof r.disabled_reason === 'string') detail = r.disabled_reason
    } else if (auth === 'not_logged_in') state = 'needs-auth'
    else if (auth === 'bearer_token') { state = 'authenticated'; detail = 'bearer token' }
    else if (auth === 'o_auth' || auth === 'oauth' || auth === 'logged_in') { state = 'authenticated'; detail = 'OAuth' }
    else state = 'unknown'
    servers.push({ name, target, transport: isHttp ? 'http' : 'stdio', state, ...(detail ? { detail } : {}) })
  }
  return { servers }
}

// ---- OpenCode ------------------------------------------------------------------------------------

/**
 * `opencode mcp list` (1.17.9) draws a box:
 *
 *   ┌  MCP Servers
 *   │
 *   ●  ⚠ figma needs authentication
 *   │      https://mcp.figma.com/mcp
 *   │
 *   ●  ✗ echo failed
 *   │      MCP error -32000: Connection closed
 *   │      true
 *
 * The line after the header is the error (when it failed) and the LAST detail line is the target.
 */
export function parseOpencodeMcpList(out: string): McpListParse | null {
  const text = stripAnsi(out)
  if (!/MCP Servers/.test(text)) return null
  const servers: McpHarnessServer[] = []
  let cur: { name: string; word: string; detail: string[] } | null = null
  const flush = () => {
    if (!cur) return
    const target = cur.detail.length > 0 ? cur.detail[cur.detail.length - 1]! : ''
    const extra = cur.detail.slice(0, -1).join(' ')
    const w = cur.word.toLowerCase()
    const state: McpAuthState =
      /needs auth/.test(w) ? 'needs-auth'
        : /^connected/.test(w) ? 'connected'
          : /^failed|error/.test(w) ? 'error'
            : /^disabled/.test(w) ? 'disabled'
              : 'unknown'
    servers.push({
      name: cur.name, target, transport: transportOfTarget(target),
      state, ...(state === 'error' && extra ? { detail: extra } : {}),
    })
    cur = null
  }
  for (const raw of text.split(/\r?\n/)) {
    const head = /^[●○]\s+[✓✗⚠○●]?\s*(\S+)\s+(.*)$/u.exec(raw.trim())
    if (head && !raw.trim().startsWith('│')) { flush(); cur = { name: head[1]!, word: head[2]!.trim(), detail: [] }; continue }
    const d = /^│\s{2,}(.+)$/u.exec(raw.trim())
    if (d && cur) { cur.detail.push(d[1]!.trim()); continue }
    if (/^└/.test(raw.trim())) flush()
  }
  flush()
  return { servers }
}

// ---- Gemini --------------------------------------------------------------------------------------

/**
 * `gemini mcp list` (0.63.0):
 *
 *   Configured MCP servers:
 *
 *   ✗ figma: https://mcp.figma.com/mcp (http) - Disconnected
 *   ✓ echo: true  (stdio) - Connected
 *   ○ x: … - Disabled
 *
 * In a folder Gemini has not been told to trust it prints a warning and lists EVERY server as
 * Disabled — a statement about the folder, not the servers — so those rows are `unknown` and the
 * parse carries `untrustedFolder`.
 */
export function parseGeminiMcpList(out: string): McpListParse | null {
  const text = stripAnsi(out)
  if (/no mcp servers configured/i.test(text)) return { servers: [] }
  if (!/configured mcp servers/i.test(text)) return null
  const untrusted = /folder is untrusted|untrusted folder/i.test(text)
  const servers: McpHarnessServer[] = []
  for (const raw of text.split(/\r?\n/)) {
    const m = /^([✓✗○◐●])\s+(.+?): (.*?)\s*\((stdio|http|sse)\)\s+-\s+(\w+)/u.exec(raw.trim())
    if (!m) continue
    const [, , name, target, kind, word] = m
    const w = word!.toLowerCase()
    let state: McpAuthState =
      w === 'connected' ? 'connected' : w === 'disconnected' ? 'disconnected' : w === 'disabled' ? 'disabled'
        : w === 'connecting' ? 'unknown' : 'unknown'
    if (untrusted) state = 'unknown'
    servers.push({ name: name!, target: target!.trim(), transport: transportOfTarget(target!, kind), state })
  }
  return { servers, ...(untrusted ? { untrustedFolder: true } : {}) }
}

// ---- Copilot -------------------------------------------------------------------------------------

/**
 * `copilot mcp list` (1.0.94):
 *
 *   User servers:
 *     figma (http)
 *     echo (local)
 *
 * Configuration only — Copilot's CLI prints no health, so every row is `unknown`.
 */
export function parseCopilotMcpList(out: string): McpListParse | null {
  const text = stripAnsi(out)
  if (/no mcp servers configured/i.test(text)) return { servers: [] }
  const servers: McpHarnessServer[] = []
  let sawSection = false
  for (const raw of text.split(/\r?\n/)) {
    if (/^\S.*servers?:\s*$/i.test(raw.trim()) && !/^\s/.test(raw)) { sawSection = true; continue }
    const m = /^\s+(\S.*?)\s+\((http|sse|local|stdio)(?:,\s*([^)]*))?\)\s*$/i.exec(raw)
    if (!m) continue
    const flag = (m[3] ?? '').toLowerCase()
    servers.push({
      name: m[1]!, target: '', transport: transportOfTarget('', m[2]),
      state: /disabled/.test(flag) ? 'disabled' : 'unknown',
    })
  }
  if (servers.length === 0 && !sawSection) return null
  return { servers }
}

// ---- Antigravity ---------------------------------------------------------------------------------

/** `agy mcp list` (1.3.2): a `NAME TYPE STATUS COMMAND/URL` table where STATUS is enabled/disabled. */
export function parseAgyMcpList(out: string): McpListParse | null {
  const text = stripAnsi(out)
  if (/no mcp servers configured/i.test(text)) return { servers: [] }
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  const head = lines.findIndex(l => /^NAME\s+TYPE\s+STATUS/i.test(l.trim()))
  if (head < 0) return null
  const servers: McpHarnessServer[] = []
  for (const l of lines.slice(head + 1)) {
    const m = /^(\S+)\s+(stdio|http|sse)\s+(enabled|disabled)\s+(.*)$/i.exec(l.trim())
    if (!m) continue
    servers.push({
      name: m[1]!, target: m[4]!.trim(), transport: transportOfTarget(m[4]!, m[2]),
      state: m[3]!.toLowerCase() === 'disabled' ? 'disabled' : 'unknown',
    })
  }
  return { servers }
}

// ---- the table -----------------------------------------------------------------------------------

export interface McpListSpec {
  argv: string[]
  parse: (out: string) => McpListParse | null
  /** Seconds the harness may take: `claude mcp list` health-checks every server. */
  timeoutMs: number
}

export interface McpLoginSpec {
  argv: (name: string) => string[]
  /**
   * Can the person paste the redirect URL back? Claude Code prints "Or paste the redirect URL here:"
   * (measured, `--no-browser`), which is what makes a login from a phone or a remote session work.
   * Codex and OpenCode finish only when the browser reaches a localhost callback on THIS machine.
   */
  pasteBack: boolean
}

export interface HarnessMcpSpec {
  bin: string
  /** `null`: the CLI has no way to list its MCP servers — said in `noList`. */
  list: McpListSpec | null
  /** `null`: no non-interactive OAuth login — said in `noLogin`. */
  login: McpLoginSpec | null
  noList?: { pt: string; en: string }
  noLogin?: { pt: string; en: string }
  /** `<cli> <version>` the formats above were measured against, and when. */
  measured: string
}

/**
 * One entry per harness (`Record<HarnessId, …>`: a new id fails the build here until somebody
 * decides what it offers). **Every `login: null` and every `list: null` carries its sentence and the
 * evidence behind it** — a missing button with no reason reads as a broken one.
 */
export const HARNESS_MCP: Record<HarnessId, HarnessMcpSpec> = {
  claude: {
    bin: 'claude',
    list: { argv: ['mcp', 'list'], parse: parseClaudeMcpList, timeoutMs: 60_000 },
    login: { argv: name => ['mcp', 'login', name, '--no-browser'], pasteBack: true },
    measured: 'claude 2.1.295, 2026-10-09 (`claude mcp list`, `claude mcp login --help`)',
  },
  codex: {
    bin: 'codex',
    list: { argv: ['mcp', 'list', '--json'], parse: parseCodexMcpListJson, timeoutMs: 20_000 },
    login: { argv: name => ['mcp', 'login', name], pasteBack: false },
    measured: 'codex 0.161.0, 2026-10-09 (`codex mcp list --json`, `codex mcp login`)',
  },
  opencode: {
    bin: 'opencode',
    list: { argv: ['mcp', 'list'], parse: parseOpencodeMcpList, timeoutMs: 40_000 },
    login: { argv: name => ['mcp', 'auth', name], pasteBack: false },
    measured: 'opencode 1.17.9, 2026-10-09 (`opencode mcp list`, `opencode mcp auth`)',
  },
  gemini: {
    bin: 'gemini',
    list: { argv: ['mcp', 'list'], parse: parseGeminiMcpList, timeoutMs: 40_000 },
    login: null,
    noLogin: {
      pt: 'O Gemini só autentica servidores MCP por dentro de uma sessão, com o comando /mcp auth <servidor>. A CLI dele não tem login fora disso.',
      en: 'Gemini only authenticates MCP servers from inside a session, with the /mcp auth <server> command. Its CLI has no login outside that.',
    },
    measured: 'gemini 0.63.0, 2026-10-09 (`gemini mcp --help` lists add/remove/list/enable/disable only)',
  },
  copilot: {
    bin: 'copilot',
    list: { argv: ['mcp', 'list'], parse: parseCopilotMcpList, timeoutMs: 20_000 },
    login: null,
    noLogin: {
      pt: 'O Copilot CLI não tem login de OAuth para servidores MCP: servidor remoto com autenticação usa um cabeçalho (copilot mcp add --header "Authorization: Bearer …").',
      en: 'Copilot CLI has no OAuth login for MCP servers: an authenticated remote server uses a header (copilot mcp add --header "Authorization: Bearer …").',
    },
    measured: 'copilot 1.0.94, 2026-10-09 (`copilot mcp --help`: list/get/add/remove/enable/disable; `mcp add --help` documents --header)',
  },
  antigravity: {
    bin: 'agy',
    list: { argv: ['mcp', 'list'], parse: parseAgyMcpList, timeoutMs: 20_000 },
    login: null,
    noLogin: {
      pt: 'O Antigravity (agy) não tem login de OAuth para servidores MCP: servidor remoto com autenticação usa um cabeçalho (agy mcp add --header "Authorization: Bearer …").',
      en: 'Antigravity (agy) has no OAuth login for MCP servers: an authenticated remote server uses a header (agy mcp add --header "Authorization: Bearer …").',
    },
    measured: 'agy 1.3.2, 2026-10-09 (`agy mcp` subcommands: add/remove/list/enable/disable; `agy mcp add --help` documents --header)',
  },
  kimi: {
    bin: 'kimi',
    list: null,
    login: null,
    noList: {
      pt: 'O Kimi Code 2.1.1 não tem o comando `mcp`: não há como listar nem autenticar servidores MCP por ele. O `kimi login` é só a conta do Kimi.',
      en: 'Kimi Code 2.1.1 has no `mcp` command, so its MCP servers cannot be listed or authenticated through it. `kimi login` is the Kimi account only.',
    },
    measured: 'kimi 2.1.1, 2026-10-09 (`kimi --help` has no mcp command)',
  },
}

/** Does this state need the person to act? It decides the badge colour and the "Authenticate" button. */
export function stateNeedsAuth(s: McpAuthState): boolean { return s === 'needs-auth' }

/**
 * THE NO-DUPLICATE RULE. Two entries pointing at one URL — a user-scope `figma` beside the plugin's
 * `plugin:figma:figma` — are two logins and two sets of tools for the same server. They are REPORTED
 * (`duplicateOf` on the row, a sentence on the card) and never merged, created or removed by this
 * product: which one to keep is the person's call.
 */
export function normalizeMcpUrl(u: string): string {
  try {
    const x = new URL(u)
    return `${x.protocol}//${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, '')}`
  } catch { return u.trim().toLowerCase() }
}

export function findDuplicates(servers: readonly McpHarnessServer[]): Map<string, string> {
  const byUrl = new Map<string, string>()
  const dup = new Map<string, string>()
  for (const s of servers) {
    if (s.transport === 'stdio' || !/^https?:\/\//i.test(s.target)) continue
    const key = normalizeMcpUrl(s.target)
    const first = byUrl.get(key)
    if (first === undefined) byUrl.set(key, s.name)
    else dup.set(s.name, first)
  }
  return dup
}

/** Would adding `url` as `name` create a second entry for a server that is already listed? */
export function wouldDuplicate(servers: readonly McpHarnessServer[], name: string, url: string): string | null {
  const key = normalizeMcpUrl(url)
  for (const s of servers) {
    if (s.name === name) return null // replacing the same name is an edit, not a duplicate
    if (s.transport !== 'stdio' && /^https?:\/\//i.test(s.target) && normalizeMcpUrl(s.target) === key) return s.name
  }
  return null
}
