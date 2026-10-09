/**
 * mcp-auth.ts — listing each harness's MCP servers with the state the harness itself reports, and
 * running the harness's OWN OAuth login for one that needs it.
 *
 * The rules are the pure `mcp-harness-status.ts` (what each CLI prints, and what each can do) and
 * `mcp-auth-flow.ts` (the state machine). This is the IO, and it holds the decisions that are not
 * pure:
 *
 * 1. **READ-ONLY on every harness's files.** Status comes from the harness's `mcp list`; the login
 *    is the harness's `mcp login`. Nothing here opens `~/.claude.json`, `~/.codex/config.toml` or a
 *    credentials file — the harness rewrites those itself, and the credential it stores after a
 *    login is its own to write (the `mcp-admin.ts` rule, extended to authentication).
 * 2. **THE SERVER NAME IS NEVER FREE TEXT.** A login starts only for a name the harness's current
 *    list returned, whose state is `needs-auth`. A name from the client reaches an argv element only
 *    by being equal to one the harness printed — so this can neither create an entry (no duplicate
 *    `figma` beside `plugin:figma:figma`) nor feed a flag to the CLI.
 * 3. **THE LOGIN RUNS IN A PANE ON ITS OWN SOCKET** (`MCP_AUTH_SOCKET`), not in a fleet session: a
 *    login is not a conversation and must not appear as a row, be probed for dialogs, or be counted
 *    as a session waiting on a person. Every pane is killed when its flow ends, and the socket's
 *    server is cleared once per process before the first one — a pane left by a previous process is
 *    otherwise a live OAuth listener nobody owns.
 * 4. **HOST POWER**: listing health-checks (so, starts) every configured server and the login spawns
 *    a process — `localShell` in `capability-guard.ts`, like `/api/mcp/check`.
 */

import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { HarnessId } from '@agentistics/core'
import {
  HARNESS_MCP, findDuplicates, type McpAuthState, type McpHarnessServer, type McpListParse,
} from './mcp-harness-status'
import {
  AUTH_KEEP_MS, EXIT_MARKER, advance, cancelled, failureText, isTerminal, newFlow, settle,
  validRedirectPaste, type AuthFlow, type PaneObservation,
} from './mcp-auth-flow'
import { MCP_AUTH_SOCKET } from './sessions/tmux-socket'
import { newSessionArgs, tmuxName } from './sessions/tmux-cli'
import { userSearchPath } from './sessions/user-path'

export interface McpAuthDeps {
  /** Run a harness CLI to completion. `missing` when the binary is not on PATH. */
  run(bin: string, argv: string[], o: { cwd: string; timeoutMs: number }): Promise<{ code: number | null; out: string; missing?: boolean }>
  tmux(args: string[]): Promise<{ code: number; out: string; err: string }>
  hasBin(bin: string): boolean
  now(): number
  id(): string
  home(): string
}

// ---- the real world --------------------------------------------------------------------------

async function realRun(bin: string, argv: string[], o: { cwd: string; timeoutMs: number }) {
  const path = userSearchPath()
  if (!Bun.which(bin, { PATH: path })) return { code: null, out: '', missing: true }
  try {
    const proc = Bun.spawn([bin, ...argv], {
      cwd: o.cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env: { ...process.env, PATH: path, NO_COLOR: '1' },
    })
    const timer = setTimeout(() => proc.kill(), o.timeoutMs)
    try {
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      await proc.exited
      return { code: proc.exitCode, out: `${out}${err ? `\n${err}` : ''}` }
    } finally { clearTimeout(timer) }
  } catch { return { code: null, out: '', missing: true } }
}

async function realTmux(args: string[]) {
  try {
    const p = Bun.spawn(['tmux', ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    return { code: await p.exited, out, err }
  } catch { return { code: 127, out: '', err: '' } }
}

export const realDeps: McpAuthDeps = {
  run: realRun,
  tmux: realTmux,
  hasBin: bin => Bun.which(bin, { PATH: userSearchPath() }) !== null,
  now: () => Date.now(),
  id: () => randomUUID().replace(/-/g, '').slice(0, 10),
  home: () => process.env.HOME || homedir(),
}

// ---- the overview ----------------------------------------------------------------------------

const LABELS: Record<HarnessId, string> = {
  claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', copilot: 'Copilot CLI',
  antigravity: 'Antigravity', kimi: 'Kimi Code', opencode: 'OpenCode',
}

export interface McpHarnessOverview {
  id: HarnessId
  label: string
  installed: boolean
  canList: boolean
  canAuthenticate: boolean
  /** Why it cannot, in the user's words — absent when it can. */
  note?: { pt: string; en: string }
  measured: string
}

export function mcpOverview(deps: McpAuthDeps = realDeps): McpHarnessOverview[] {
  return (Object.keys(HARNESS_MCP) as HarnessId[]).map(id => {
    const s = HARNESS_MCP[id]
    const note = s.list === null ? s.noList : s.login === null ? s.noLogin : undefined
    return {
      id, label: LABELS[id], installed: deps.hasBin(s.bin),
      canList: s.list !== null, canAuthenticate: s.login !== null,
      ...(note ? { note } : {}), measured: s.measured,
    }
  })
}

// ---- listing -------------------------------------------------------------------------------

export type McpStatusKind = 'ok' | 'cli-missing' | 'no-mcp-command' | 'failed'

export interface McpStatusRow extends McpHarnessServer {
  /** A login can be started for this row right now. */
  canAuthenticate: boolean
  /** Another entry in this harness points at the same URL — reported, never merged. */
  duplicateOf?: string
}

export interface McpHarnessStatus {
  harness: HarnessId
  kind: McpStatusKind
  servers: McpStatusRow[]
  untrustedFolder?: boolean
  /** The harness's own words for a failed read, or the sentence for a harness that cannot list. */
  message?: { pt: string; en: string }
  checkedAt: number
}

const TTL_MS = 45_000
const cache = new Map<string, { at: number; value: McpHarnessStatus }>()
const inflight = new Map<string, Promise<McpHarnessStatus>>()

/** Tests only. */
export function forgetMcpStatusCache(): void { cache.clear(); inflight.clear() }

function toRows(harness: HarnessId, parsed: McpListParse): McpStatusRow[] {
  const spec = HARNESS_MCP[harness]
  const dup = findDuplicates(parsed.servers)
  return parsed.servers.map(s => ({
    ...s,
    canAuthenticate: spec.login !== null && s.state === 'needs-auth',
    ...(dup.has(s.name) ? { duplicateOf: dup.get(s.name)! } : {}),
  }))
}

async function readStatus(harness: HarnessId, cwd: string, deps: McpAuthDeps): Promise<McpHarnessStatus> {
  const spec = HARNESS_MCP[harness]
  const checkedAt = deps.now()
  if (spec.list === null) {
    return { harness, kind: 'no-mcp-command', servers: [], message: spec.noList, checkedAt }
  }
  const r = await deps.run(spec.bin, spec.list.argv, { cwd, timeoutMs: spec.list.timeoutMs })
  if (r.missing) {
    return {
      harness, kind: 'cli-missing', servers: [], checkedAt,
      message: { pt: `O comando \`${spec.bin}\` não está nesta máquina.`, en: `The \`${spec.bin}\` command is not on this machine.` },
    }
  }
  const parsed = spec.list.parse(r.out)
  if (parsed === null) {
    const said = r.out.replace(/\s+/g, ' ').trim().slice(0, 300)
    return {
      harness, kind: 'failed', servers: [], checkedAt,
      message: {
        pt: `Não consegui ler a lista de MCP de ${LABELS[harness]}.${said ? ` Ele disse: ${said}` : ''}`,
        en: `I could not read ${LABELS[harness]}'s MCP list.${said ? ` It said: ${said}` : ''}`,
      },
    }
  }
  return {
    harness, kind: 'ok', servers: toRows(harness, parsed), checkedAt,
    ...(parsed.untrustedFolder ? { untrustedFolder: true } : {}),
  }
}

/** One harness's MCP servers. Cached for `TTL_MS`; concurrent askers share one CLI run. */
export async function mcpStatus(
  harness: HarnessId, o: { cwd?: string; refresh?: boolean } = {}, deps: McpAuthDeps = realDeps,
): Promise<McpHarnessStatus> {
  const cwd = o.cwd ?? deps.home()
  const key = `${harness}|${cwd}`
  const hit = cache.get(key)
  if (!o.refresh && hit && deps.now() - hit.at < TTL_MS) return hit.value
  const running = inflight.get(key)
  if (running) return running
  const p = readStatus(harness, cwd, deps).then(value => {
    // A failed read is not cached: the next press should try again, not repeat an old error.
    if (value.kind === 'ok') cache.set(key, { at: deps.now(), value })
    return value
  }).finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

function invalidate(harness: HarnessId): void {
  for (const k of [...cache.keys()]) if (k.startsWith(`${harness}|`)) cache.delete(k)
}

// ---- the sign-in flow ------------------------------------------------------------------------

export type AuthStartResult =
  | { ok: true; flow: AuthView }
  | { ok: false; code: 'unknown-harness' | 'no-login' | 'not-listed' | 'not-needed' | 'too-many' | 'no-tmux' | 'no-cli' | 'spawn-failed'; message: string }

/** What the client sees. The failure is already a sentence in the asked language. */
export interface AuthView {
  id: string
  harness: string
  server: string
  phase: AuthFlow['phase']
  url?: string
  pasteBack: boolean
  verified?: boolean
  message?: string
}

const MAX_ACTIVE = 3
const flows = new Map<string, { flow: AuthFlow; lang: 'pt' | 'en'; cwd: string }>()
let socketCleared = false

/** Tests only. */
export function forgetMcpAuthFlows(): void { flows.clear(); socketCleared = false }

export function viewOf(flow: AuthFlow, lang: 'pt' | 'en'): AuthView {
  const failed = flow.phase === 'failed' && flow.failure
  return {
    id: flow.id, harness: flow.harness, server: flow.server, phase: flow.phase,
    ...(flow.url ? { url: flow.url } : {}), pasteBack: flow.pasteBack,
    ...(flow.verified !== undefined ? { verified: flow.verified } : {}),
    ...(failed ? { message: failureText(flow.failure!, lang, flow.tail) } : {}),
  }
}

const say = (lang: 'pt' | 'en', pt: string, en: string) => (lang === 'pt' ? pt : en)

async function killPane(id: string, deps: McpAuthDeps): Promise<void> {
  await deps.tmux(['-L', MCP_AUTH_SOCKET, 'kill-session', '-t', tmuxName(id)])
}

async function sweep(deps: McpAuthDeps): Promise<void> {
  const now = deps.now()
  for (const [id, rec] of [...flows]) {
    const f = rec.flow
    if (isTerminal(f.phase) && f.endedAt !== undefined && now - f.endedAt > AUTH_KEEP_MS) {
      flows.delete(id)
      await killPane(id, deps)
    }
  }
}

/** Start the harness's own login for one listed server that needs it. */
export async function startMcpAuth(
  o: { harness: string; server: string; lang: 'pt' | 'en'; cwd?: string }, deps: McpAuthDeps = realDeps,
): Promise<AuthStartResult> {
  const { lang } = o
  if (!Object.hasOwn(HARNESS_MCP, o.harness)) {
    return { ok: false, code: 'unknown-harness', message: say(lang, 'Assistente desconhecido.', 'Unknown assistant.') }
  }
  const harness = o.harness as HarnessId
  const spec = HARNESS_MCP[harness]
  if (spec.login === null) {
    const n = spec.noLogin ?? spec.noList
    return { ok: false, code: 'no-login', message: n ? n[lang] : say(lang, 'Este assistente não tem login de MCP.', 'This assistant has no MCP login.') }
  }
  await sweep(deps)

  // Decision 2: the name must be one the harness lists right now, and it must need authentication.
  const status = await mcpStatus(harness, { refresh: true, ...(o.cwd ? { cwd: o.cwd } : {}) }, deps)
  if (status.kind === 'cli-missing') return { ok: false, code: 'no-cli', message: failureText('no-cli', lang) }
  const row = status.servers.find(s => s.name === o.server)
  if (!row) {
    return { ok: false, code: 'not-listed', message: say(lang, 'Esse servidor não está na lista do assistente.', 'That server is not in the assistant’s list.') }
  }
  if (row.state !== 'needs-auth') {
    return { ok: false, code: 'not-needed', message: say(lang, 'Esse servidor não está pedindo autenticação.', 'That server is not asking for authentication.') }
  }

  // One login per server at a time: pressing twice returns the one in flight.
  for (const rec of flows.values()) {
    if (rec.flow.harness === harness && rec.flow.server === o.server && !isTerminal(rec.flow.phase)) {
      return { ok: true, flow: viewOf(rec.flow, lang) }
    }
  }
  const active = [...flows.values()].filter(r => !isTerminal(r.flow.phase)).length
  if (active >= MAX_ACTIVE) {
    return { ok: false, code: 'too-many', message: say(lang, 'Já há autenticações demais em andamento. Termine uma antes.', 'Too many sign-ins are already in progress. Finish one first.') }
  }
  if ((await deps.tmux(['-V'])).code !== 0) return { ok: false, code: 'no-tmux', message: failureText('no-tmux', lang) }

  // Decision 3: clear leftovers once per process, on OUR socket only (`kill-server` is per socket).
  if (!socketCleared) { socketCleared = true; await deps.tmux(['-L', MCP_AUTH_SOCKET, 'kill-server']) }

  const id = `mcpauth-${deps.id()}`
  // `"$@"` runs the harness's argv as separate words — the server name is never re-parsed by a shell.
  const argv = ['sh', '-c', `"$@"; code=$?; echo; echo "${EXIT_MARKER}$code]"; sleep 3600`, 'sh', spec.bin, ...spec.login.argv(o.server)]
  const cwd = deps.home()
  const made = await deps.tmux(newSessionArgs({ id, cwd, argv, socket: MCP_AUTH_SOCKET, path: userSearchPath() }))
  if (made.code !== 0) return { ok: false, code: 'spawn-failed', message: failureText('spawn-failed', lang, made.err.trim().slice(0, 200)) }

  const flow = newFlow({ id, harness, server: o.server, pasteBack: spec.login.pasteBack, now: deps.now() })
  flows.set(id, { flow, lang, cwd: o.cwd ?? cwd })
  return { ok: true, flow: viewOf(flow, lang) }
}

async function capture(id: string, deps: McpAuthDeps): Promise<string | null> {
  const r = await deps.tmux(['-L', MCP_AUTH_SOCKET, 'capture-pane', '-p', '-J', '-t', tmuxName(id), '-S', '-200'])
  return r.code === 0 ? r.out : null
}

/** One poll: read the pane, advance, and — when the CLI exited 0 — ask the harness what it now says. */
export async function pollMcpAuth(id: string, lang: 'pt' | 'en', deps: McpAuthDeps = realDeps): Promise<AuthView | null> {
  const rec = flows.get(id)
  if (!rec) return null
  let flow = rec.flow
  if (!isTerminal(flow.phase)) {
    const obs: PaneObservation = { now: deps.now(), capture: await capture(id, deps) }
    flow = advance(flow, obs)
    if (flow.phase === 'finishing') {
      const harness = flow.harness as HarnessId
      invalidate(harness)
      const status = await mcpStatus(harness, { refresh: true, cwd: rec.cwd }, deps)
      const row = status.kind === 'ok' ? status.servers.find(s => s.name === flow.server) : undefined
      // A list that read fine but no longer has the row, or one that could not be read, cannot verify.
      const state: McpAuthState | null = row ? row.state : null
      flow = settle(flow, state, deps.now())
    }
    rec.flow = flow
    if (isTerminal(flow.phase)) { invalidate(flow.harness as HarnessId); await killPane(id, deps) }
  }
  return viewOf(flow, lang)
}

/** Hand the redirect URL a browser was sent to back to the CLI's prompt (Claude Code only). */
export async function pasteMcpAuth(
  id: string, redirect: string, lang: 'pt' | 'en', deps: McpAuthDeps = realDeps,
): Promise<{ ok: true; flow: AuthView } | { ok: false; message: string }> {
  const rec = flows.get(id)
  if (!rec) return { ok: false, message: say(lang, 'Essa autenticação não existe mais.', 'That sign-in no longer exists.') }
  if (!rec.flow.pasteBack || rec.flow.phase !== 'awaiting') {
    return { ok: false, message: say(lang, 'Este assistente conclui sozinho, quando o navegador abre o link neste computador.', 'This assistant finishes by itself, once the browser opens the link on this computer.') }
  }
  if (!validRedirectPaste(redirect)) {
    return { ok: false, message: say(lang, 'Isso não parece o endereço de retorno. Cole o endereço inteiro, que começa com http://localhost e tem code= nele.', 'That does not look like the return address. Paste the whole address, which starts with http://localhost and has code= in it.') }
  }
  const t = redirect.trim()
  const lit = await deps.tmux(['-L', MCP_AUTH_SOCKET, 'send-keys', '-t', tmuxName(id), '-l', t])
  const enter = lit.code === 0 ? await deps.tmux(['-L', MCP_AUTH_SOCKET, 'send-keys', '-t', tmuxName(id), 'Enter']) : lit
  if (enter.code !== 0) return { ok: false, message: failureText('pane-gone', lang) }
  const view = await pollMcpAuth(id, lang, deps)
  return { ok: true, flow: view ?? viewOf(rec.flow, lang) }
}

export async function cancelMcpAuth(id: string, lang: 'pt' | 'en', deps: McpAuthDeps = realDeps): Promise<AuthView | null> {
  const rec = flows.get(id)
  if (!rec) return null
  rec.flow = cancelled(rec.flow, deps.now())
  await killPane(id, deps)
  return viewOf(rec.flow, lang)
}
