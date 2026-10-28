/** Headless account login. Output and pasted authorization codes never enter logs or files. */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import type { HarnessId } from '@agentistics/core'
import { isSessionGoneError, SHELL_SOCKET } from './sessions/tmux-cli'

export type LoginKind = 'paste' | 'device'
export type LoginError = 'login_unavailable' | 'login_timeout' | 'login_failed' | 'plaintext_refused' | 'invalid_code' | 'keychain_unreadable' | 'login_not_saved' | 'login_unreadable'
export interface LoginInfo { kind: LoginKind; url: string; code?: string; expiresAt: number; error?: 'invalid_code' }
interface LoginAdapter { argv: string[]; kind: LoginKind; pty: boolean; hosts: readonly string[]; path: RegExp }
// @harness-adapters-only: login protocols are facts of each vendor CLI, not a preferred assistant.
export const LOGIN_ADAPTERS: Record<HarnessId, LoginAdapter | null> = {
  claude: { argv: ['claude', 'auth', 'login', '--claudeai'], kind: 'paste', pty: true, hosts: ['claude.com', 'claude.ai', 'platform.claude.com', 'console.anthropic.com'], path: /^\/(?:cai\/)?oauth\/authorize\/?$/ },
  gemini: { argv: ['gemini'], kind: 'paste', pty: true, hosts: ['accounts.google.com'], path: /^\/o\/oauth2\/(?:v2\/)?auth(?:\/|$)/ },
  codex: { argv: ['codex', 'login', '--device-auth'], kind: 'device', pty: false, hosts: ['auth.openai.com'], path: /^\/codex\/device\/?$/ },
  copilot: { argv: ['copilot', 'login', '--device-code'], kind: 'device', pty: false, hosts: ['github.com'], path: /^\/login\/device\/?$/ },
  kimi: { argv: ['kimi', 'login'], kind: 'device', pty: false, hosts: ['kimi.com', 'www.kimi.com', 'auth.kimi.com', 'kimi.moonshot.cn'], path: /device|oauth/i },
  antigravity: null,
  opencode: null,
}
export const LOGIN_MESSAGES: Record<LoginError, string> = {
  login_unavailable: 'Could not start sign-in. Check that the assistant and tmux are installed.',
  login_timeout: 'Sign-in expired. Start again to get a new link and code.',
  login_failed: 'Sign-in did not finish. Start again.',
  plaintext_refused: 'The system keychain is unavailable. Copilot could not save the login securely; storing the token in plain text was refused.',
  invalid_code: 'Enter the authorization code shown by the sign-in page.',
  keychain_unreadable: 'macOS did not let agentistics read the Claude login it just saved. Open Keychain Access, find the "Claude Code-credentials" item for this account and allow access, or sign in again and choose "Always Allow" when macOS asks.',
  login_not_saved: 'The sign-in finished, but the login was not saved on this computer. Try again; if it repeats, sign in once in a terminal with `claude auth login`.',
  login_unreadable: 'Claude signed in, but agentistics could not read the login on this Mac. Verify again; no new code is needed.',
}
export class LoginFailure extends Error {
  constructor(readonly reason: LoginError, readonly detail?: string) { super(LOGIN_MESSAGES[reason]) }
}

/**
 * PURE. Mask what a login screen may carry that is not for a log or a screen: the pasted code
 * itself, URLs (their query holds the PKCE state) and any long token-shaped run.
 */
export function maskLoginText(text: string, secrets: readonly string[] = []): string {
  let out = stripLoginAnsi(text)
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join('•••')
  return out.replace(/https?:\/\/\S+/g, '<link>').replace(/[A-Za-z0-9_\-#.~]{24,}/g, '•••')
}
/**
 * PURE. What the CLI said after the code: the text after the last paste prompt, else the last
 * non-empty lines. Masked and bounded, so it can be shown and logged.
 */
export function loginScreenSaid(screen: string, secrets: readonly string[] = []): string | undefined {
  const text = maskLoginText(screen, secrets)
  const prompt = /Paste code here(?: if prompted)?\s*>?|Enter the authorization code\s*:?/gi
  let cut = -1
  for (const m of text.matchAll(prompt)) cut = m.index! + m[0].length
  const tail = cut >= 0 ? text.slice(cut) : text.split('\n').filter(l => l.trim()).slice(-3).join('\n')
  const said = tail.split('\n').map(l => l.trim()).filter(l => l && !/^Pane is dead/i.test(l)).join(' ').replace(/\s+/g, ' ').trim()
  return said ? said.slice(0, 300) : undefined
}

export const stripLoginAnsi = (s: string) => s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
export function loginRefusal(output: string): LoginError | undefined {
  return /keychain (?:is |was )?(?:unavailable|inaccessible|not available)|(?:failed|unable) to (?:access|open|store.+(?:in|to)) (?:the )?keychain|(?:store|save) (?:the |your )?token in (?:the )?plain\s*text(?: config file)?|token (?:was |could )?not (?:be )?saved/i.test(stripLoginAnsi(output)) ? 'plaintext_refused' : undefined
}
/** Accept only authorization URLs on the adapter's hosts, never URLs from arbitrary diagnostics. */
export function parseLoginOutput(harness: HarnessId, output: string, now = Date.now()): LoginInfo | null {
  const adapter = LOGIN_ADAPTERS[harness]
  if (!adapter) return null
  const text = stripLoginAnsi(output)
  const urls = text.match(/https:\/\/[^\s<>"'\x00-\x1f]+(?=[\s<>"'\x00-\x1f])/g) ?? []
  const url = urls.reverse().map(s => s.replace(/[),.;]+$/, '')).find(s => {
    try { const u = new URL(s); return adapter.hosts.includes(u.hostname) && adapter.path.test(u.pathname) && !u.username && !u.password && u.port === '' && !(harness === 'claude' && /^http:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/.test(u.searchParams.get('redirect_uri') ?? '')) } catch { return false }
  })
  if (!url) return null
  // Claude's displayed fallback link uses the manual redirect; no localhost callback is exposed.
  if (harness === 'claude') {
    const u = new URL(url)
    const redirect = u.searchParams.get('redirect_uri')
    if (redirect?.startsWith('http://localhost') || redirect?.startsWith('http://127.0.0.1')) return null
  }
  const code = text.match(/(?:enter\s+(?:the\s+)?(?:one-time\s+)?code|one-time\s+code)\s*[:\s]*([A-Z0-9]{4}(?:-[A-Z0-9]{4,5})+)\b/i)?.[1]
    ?? text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,5})\b/)?.[1]
    ?? new URL(url).searchParams.get('user_code') ?? undefined
  if (adapter.kind === 'device' && !code) return null
  const seconds = text.match(/(?:code\s+)?expires in\s+(\d+)\s*s\b/i)?.[1]
  const minutes = text.match(/expires in\s+(\d+)\s*minutes?/i)?.[1]
  const ttl = seconds ? Number(seconds) * 1000 : minutes ? Number(minutes) * 60_000 : harness === 'gemini' ? 300_000 : 900_000
  return { kind: adapter.kind, url, ...(adapter.kind === 'device' ? { code } : {}), expiresAt: now + Math.min(ttl, 900_000) }
}

export interface LoginProcess {
  /** PTY reads replace the visible pane; pipe reads append chunks. */
  snapshot?: boolean
  read: () => Promise<string | null>
  write: (code: string) => Promise<void>
  stop: () => Promise<void>
  exited: Promise<number>
}
export interface LoginRequest { harness: HarnessId; pendingId: string; root: string; env: Record<string, string> }
export interface LoginHandle {
  ready: Promise<LoginInfo>
  info: () => LoginInfo | undefined
  submit: (code: unknown) => Promise<void>
  stop: () => Promise<void>
  /** Has a code been typed into this sign-in? */
  submitted?: () => boolean
}
export interface LoginOptions {
  launch?: (req: LoginRequest) => Promise<LoginProcess>
  readyTimeoutMs?: number
  overallTimeoutMs?: number
  /** After a pasted code, how long the CLI may be gone with no account bound before it is a failure. */
  bindGraceMs?: number
  /** After a pasted code, how long the CLI may stay alive with no account bound before it is a failure. */
  submitTimeoutMs?: number
  /**
   * When a sign-in that got a code ends with no account bound and no CLI error, say WHY when it can
   * be known (macOS: is the keychain item there?). `undefined` keeps `login_failed`.
   */
  diagnose?: (req: LoginRequest) => Promise<LoginError | undefined>
  /** Where a failed sign-in's (masked) CLI screen is recorded. */
  log?: (line: string) => void
  now?: () => number
}
/** The controller holds only public link/device metadata. Pasted codes are written once and discarded. */
export async function startAccountLogin(req: LoginRequest, onFailure: (reason: LoginError, detail?: string) => Promise<void>, opts: LoginOptions = {}): Promise<LoginHandle> {
  const proc = await (opts.launch ?? launchLoginProcess)(req).catch(() => { throw new LoginFailure('login_unavailable') })
  let info: LoginInfo | undefined, stopped = false, submitted = false, hasSubmitted = false, buffer = ''
  let resolveReady!: (info: LoginInfo) => void, rejectReady!: (e: LoginFailure) => void
  const ready = new Promise<LoginInfo>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  // Attach immediately: a process can fail before the HTTP caller starts awaiting `ready`.
  void ready.catch(() => {})
  const now = opts.now ?? Date.now
  const deadline = now() + (opts.overallTimeoutMs ?? 900_000)
  let linkAt: number | undefined
  let invalidCount = 0, invalidAtSubmit = 0, promptCount = 0, promptsAtSubmit = 0
  // The last screen after a code, MASKED: never the code itself. Read when the attempt fails.
  let lastScreen = '', submitTimer: ReturnType<typeof setTimeout> | undefined
  const secrets: string[] = []
  const log = opts.log ?? loginLog
  const stop = async (failure?: LoginError) => {
    if (stopped) return
    stopped = true; buffer = ''; secrets.length = 0; clearTimeout(readyTimer); clearTimeout(expiryTimer); clearTimeout(submitTimer)
    try { await proc.stop() } catch { stopped = false; throw new LoginFailure('login_failed') }
    if (!failure) rejectReady(new LoginFailure('login_failed'))
  }
  const fail = async (reason: LoginError, why?: string, diagnosable = false) => {
    if (stopped) return
    let diagnosis: LoginError | undefined
    if (diagnosable && hasSubmitted) diagnosis = await (opts.diagnose ?? diagnoseLogin)(req).catch(() => undefined)
    if (diagnosis) reason = diagnosis === 'login_not_saved' || diagnosis === 'keychain_unreadable' ? 'login_unreadable' : diagnosis
    if (stopped) return
    const detail = hasSubmitted
      ? [diagnosis === 'login_not_saved' ? 'the Claude keychain item was absent' : diagnosis === 'keychain_unreadable' ? 'the Claude keychain item was present but unreadable' : undefined, loginScreenSaid(lastScreen, secrets)].filter(Boolean).join('; ') || undefined
      : undefined
    if (hasSubmitted) log(`[account-login] ${req.harness} sign-in ${why ?? reason}; the CLI screen said: ${detail ?? '(nothing)'}`)
    try { await stop(reason); await onFailure(reason, detail) } finally { rejectReady(new LoginFailure(reason, detail)) }
  }
  const readyTimer = setTimeout(() => { void fail('login_timeout').catch(() => {}) }, opts.readyTimeoutMs ?? 30_000)
  let expiryTimer = setTimeout(() => { void fail('login_timeout').catch(() => {}) }, opts.overallTimeoutMs ?? 900_000)
  readyTimer.unref?.(); expiryTimer.unref?.()
  void (async () => {
    try {
      while (!stopped) {
        const chunk = await proc.read()
        if (chunk === null) break
        // PTY reads are snapshots. After input, inspect only this snapshot and retain public
        // metadata, never a pasted code's echo or raw diagnostics between reads.
        if (!hasSubmitted) buffer = (proc.snapshot ? chunk : buffer + chunk).slice(-65536)
        const output = hasSubmitted ? chunk : buffer
        if (hasSubmitted) lastScreen = maskLoginText(chunk, secrets)
        const text = stripLoginAnsi(output)
        invalidCount = (text.match(/invalid_grant|invalid (?:authorization )?code|(?:authorization |authentication )?code (?:is |was )?(?:invalid|expired)|authentication failed/gi) ?? []).length
        promptCount = (text.match(/Paste code here|Enter the authorization code/gi) ?? []).length
        const invalid = submitted && (invalidCount > invalidAtSubmit || promptCount > promptsAtSubmit)
        if (invalid && info) {
          submitted = false; info = { ...info, error: 'invalid_code' }
          log(`[account-login] ${req.harness} sign-in concluded invalid_code: ${invalidCount > invalidAtSubmit ? 'the CLI said the code is invalid' : 'the CLI asked for the code again'}; the CLI screen said: ${loginScreenSaid(lastScreen, secrets) ?? '(nothing)'}`)
        }
        if (req.harness === 'copilot' && loginRefusal(output)) { await fail('plaintext_refused'); return }
        const parsed = parseLoginOutput(req.harness, output, linkAt ?? now())
        if (parsed) {
          linkAt ??= now()
          parsed.expiresAt = Math.min(parsed.expiresAt, deadline)
          if (!info || parsed.url !== info.url || parsed.expiresAt < info.expiresAt) {
            const retry = hasSubmitted && info?.kind === 'paste'
            if (retry) {
              submitted = false
              log(`[account-login] ${req.harness} sign-in concluded invalid_code: the CLI printed a new sign-in link after the code; the CLI screen said: ${loginScreenSaid(lastScreen, secrets) ?? '(nothing)'}`)
            }
            info = { ...parsed, ...(retry || info?.error ? { error: 'invalid_code' as const } : {}) }; clearTimeout(readyTimer); clearTimeout(expiryTimer)
            expiryTimer = setTimeout(() => { void fail('login_timeout').catch(() => {}) }, Math.max(0, parsed.expiresAt - now()))
            expiryTimer.unref?.(); resolveReady(parsed)
          }
        }
      }
      const exit = await proc.exited
      if (!stopped && (exit !== 0 || !info)) await fail('login_failed', `ended with status ${exit}`)
      // A successful CLI exit is not proof of identity. Root polling must still bind the account —
      // but not forever: a CLI that ended after the code and left no login behind is a failure the
      // screen must SAY (the binding stops this handle first, which makes `fail` a no-op).
      else if (!stopped && hasSubmitted) {
        clearTimeout(submitTimer)
        const grace = setTimeout(() => { void fail('login_failed', 'ended with no login saved', true).catch(() => {}) }, opts.bindGraceMs ?? 30_000)
        grace.unref?.()
      }
    } catch { await fail('login_failed').catch(() => {}) }
  })()
  return {
    ready, info: () => info, stop, submitted: () => hasSubmitted,
    async submit(code) {
      if (stopped || !info || info.kind !== 'paste' || submitted) throw new LoginFailure('login_failed')
      if (typeof code !== 'string' || !code.trim() || code.length > 8192 || /[\x00-\x20\x7f]/.test(code.trim())) throw new LoginFailure('invalid_code')
      submitted = true; hasSubmitted = true; invalidAtSubmit = invalidCount; promptsAtSubmit = promptCount; buffer = ''; info = { ...info, error: undefined }
      secrets.push(code.trim(), ...code.trim().split('#').filter(p => p.length >= 4))
      // A CLI that stays alive after the code without a login bound must not leave the screen
      // "waiting" forever: past this, the attempt fails with what the CLI is showing.
      clearTimeout(submitTimer)
      submitTimer = setTimeout(() => { void fail('login_failed', 'still waiting after the code', true).catch(() => {}) }, opts.submitTimeoutMs ?? 30_000)
      submitTimer.unref?.()
      try { await proc.write(code.trim()) } catch { await fail('login_failed', 'could not type the code'); throw new LoginFailure('login_failed') }
    },
  }
}

/**
 * PURE. The macOS keychain item Claude Code keeps a login in, for the env it runs under — mirrored
 * from the CLI (2.1.310): `Claude Code-credentials` plus `-<sha256(dir)[:8]>` when CLAUDE_CONFIG_DIR
 * (or CLAUDE_SECURESTORAGE_CONFIG_DIR, which wins) is set; the dir is used as written, NFC-normalized.
 * The login and the probe must name the SAME item, or a login that worked is never seen.
 */
export function claudeKeychainService(env: Record<string, string | undefined>): string {
  const secure = env.CLAUDE_SECURESTORAGE_CONFIG_DIR
  const dir = secure !== undefined ? secure : env.CLAUDE_CONFIG_DIR
  if (!dir) return 'Claude Code-credentials'
  return `Claude Code-credentials-${new Bun.CryptoHasher('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8)}`
}

/**
 * macOS only, claude only: does the keychain hold the item this root's login writes? Asked by EXIT
 * CODE alone — no `-w`, stdout and stderr discarded — so no secret is ever read. Found while the
 * probe sees no login → macOS refused agentistics access; absent → the login was never saved.
 */
export async function diagnoseLogin(req: LoginRequest, platform = process.platform, run?: (argv: string[]) => Promise<number>): Promise<LoginError | undefined> {
  if (platform !== 'darwin' || req.harness !== 'claude') return undefined
  const service = claudeKeychainService({ ...req.env })
  const account = keychainAccount()
  // Do not constrain the lookup by account: Claude can derive `acct` differently when USER is
  // absent in env -i, while the service suffix still identifies this isolated root. No -w/-g means
  // the command never reads a credential value.
  const argv = ['security', 'find-generic-password', '-s', service]
  const listedArgv = ['security', 'dump-keychain']
  const found = run
    ? { code: await run(argv), stdout: '' }
    : await runClaudeInLoginContext(req.root, argv)
  const listed = run
    ? { code: 127, stdout: '' }
    : await runClaudeInLoginContext(req.root, listedArgv)
  const listable = listed.code === 0 && listed.stdout.includes(service)
  loginLog(`[account-login] claude keychain item "${service}" account "${account}" ${found.code === 0 ? 'exists' : 'is absent'} after the sign-in (same login context; listable=${listable ? 'yes' : 'no'})`)
  return found.code === 0 ? 'keychain_unreadable' : 'login_not_saved'
}
/** Mirrors the CLI's keychain account: $USER, else the OS user name, else its fixed fallback. */
function keychainAccount(): string {
  let name: string
  try { name = process.env.USER || userInfo().username } catch { name = 'claude-code-user' }
  return /^[a-zA-Z0-9._-]+$/.test(name) ? name : 'claude-code-user'
}
async function runQuiet(argv: string[]): Promise<number> {
  try { return await Bun.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).exited } catch { return 127 }
}

/** PURE. `#{pane_dead} #{pane_dead_status}` -> the exit status of a dead pane, or null while alive. */
export function parsePaneDead(out: string): number | null {
  const [dead, status] = out.trim().split(/\s+/)
  if (dead !== '1') return null
  const n = Number(status)
  return Number.isInteger(n) ? n : 1
}

export interface PasteTarget { paste: () => Promise<void>; enter: () => Promise<void>; screen: () => Promise<string> }
/**
 * PURE. Is the typed code still sitting in the input after the Enter? Only then was the Enter lost.
 * `claude auth login` reads stdin with readline and does NOT echo, and while it trades the code for
 * a token its screen does not move — so "the screen did not change" is no evidence at all there.
 */
export function codeStillTyped(screen: string, code: string): boolean {
  const tail = code.slice(-12)
  if (tail.length < 8) return false
  const last = stripLoginAnsi(screen).split('\n').map(l => l.trimEnd()).filter(Boolean).at(-1) ?? ''
  return last.includes(tail)
}
/**
 * Paste, WAIT, then Enter — never in one burst. A TUI reads a fast burst as one paste and can take
 * the Enter inside it as text, leaving the code in the field. Press Enter once more ONLY when the
 * code is still visible in the field: a blind second Enter is an EMPTY LINE to `claude auth login`,
 * which answers "Invalid code. Please make sure the full code was copied." while the real code is
 * still being exchanged — measured on 2.1.310 with a slow token exchange (CONTAS.LOGIN r4).
 */
export async function submitPasted(t: PasteTarget, opts: { code?: string; settleMs?: number; confirmMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  await t.paste()
  await sleep(opts.settleMs ?? 500)
  await t.enter()
  if (!opts.code) return
  await sleep(opts.confirmMs ?? 1500)
  const after = await t.screen().catch(() => null)
  if (after !== null && codeStillTyped(after, opts.code)) await t.enter()
}

/** The ONE log sink of this module. Callers pass only masked text (`maskLoginText`) or fixed facts. */
export const loginLog = (line: string) => console.warn(line)
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"
/** Only runtime executables enter PATH. In particular xdg-open/open/browser launchers are absent. */
async function loginEnvironment(req: LoginRequest) {
  return makeLoginEnvironment(req.root, req.env)
}
async function makeLoginEnvironment(root: string, extra: Record<string, string> = {}, binName = '.login-bin') {
  const bin = join(root, binName)
  await mkdir(bin, { mode: 0o700 })
  // `security` is macOS's keychain tool: claude stores its login there, and without it on PATH the
  // CLI cannot save the credential it just exchanged (absent on Linux, so nothing is linked there).
  for (const name of ['node', 'bun', 'python3', 'python', 'sh', 'bash', 'env', 'cat', 'dirname', 'readlink', 'security']) {
    const path = Bun.which(name)
    if (path) await symlink(path, join(bin, name))
  }
  // No inherited API keys, access tokens, agent variables, display or browser environment.
  // USER is explicit because LaunchAgent and the tmux server can inherit different values; Claude
  // uses it as the keychain account selector when no account flag is supplied.
  const env: Record<string, string> = { HOME: homedir(), USER: keychainAccount(), PATH: bin, TERM: 'xterm-256color', LANG: process.env.LANG ?? 'en_US.UTF-8', BROWSER: '/bin/true', NO_BROWSER: 'true', ...extra }
  return { bin, env }
}
async function tmux(args: string[], input?: string, missingOkay = false) {
  const child = Bun.spawn(['tmux', '-L', SHELL_SOCKET, ...args], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  if (input !== undefined) child.stdin.write(input)
  child.stdin.end()
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0 && !(missingOkay && isSessionGoneError(err))) throw new LoginFailure('login_failed')
  return out
}

/**
 * Run a non-interactive Claude command in the same clean tmux/socket boundary as login.
 * macOS keychain visibility is tied to that process/session boundary, so a direct child of the
 * LaunchAgent is not an equivalent probe. Output stays in memory and is never logged.
 */
export async function runClaudeInLoginContext(root: string, argv: string[]): Promise<{ stdout: string; code: number }> {
  const executable = await resolveExecutable(argv[0]!)
  if (!executable) return { stdout: '', code: 127 }
  const name = `account-probe-${randomBytes(6).toString('hex')}`
  const { bin, env } = await makeLoginEnvironment(root, { CLAUDE_CONFIG_DIR: root }, `.${name}-bin`)
  // Keep the pane alive briefly after the command exits. A very fast fake/real CLI can disappear
  // between new-session and set-option; preserving the original exit status keeps diagnosis exact.
  const invoked = [executable, ...argv.slice(1)].map(quote).join(' ')
  const command = ['/usr/bin/env', '-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), '/bin/sh', '-c', `${invoked}; code=$?; /bin/sleep 0.2; exit $code`].map(quote).join(' ')
  try {
    await tmux(['new-session', '-d', '-s', name, '-x', '240', '-y', '80', '-c', root, command])
    await tmux(['set-option', '-t', name, 'remain-on-exit', 'on']).catch(() => {})
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const dead = parsePaneDead(await tmux(['display-message', '-p', '-t', name, '#{pane_dead} #{pane_dead_status}']))
      if (dead !== null) return { stdout: await tmux(['capture-pane', '-p', '-J', '-t', name, '-S', '-100']).catch(() => ''), code: dead }
      await new Promise<void>(resolve => setTimeout(resolve, 20))
    }
    return { stdout: await tmux(['capture-pane', '-p', '-J', '-t', name, '-S', '-100']).catch(() => ''), code: 124 }
  } catch {
    return { stdout: '', code: 127 }
  } finally {
    await tmux(['kill-session', '-t', name], undefined, true).catch(() => {})
    await rm(bin, { recursive: true, force: true }).catch(() => {})
  }
}
async function resolveExecutable(name: string): Promise<string | undefined> {
  if (name.includes('/')) return await Bun.file(name).exists() ? name : undefined
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    const candidate = join(dir, name)
    if (await Bun.file(candidate).exists()) return candidate
  }
  return Bun.which(name) ?? undefined
}
/** Hidden PTYs use the existing utility socket: no registry, fleet row, transcript or terminal link. */
export async function launchLoginProcess(req: LoginRequest): Promise<LoginProcess> {
  const adapter = LOGIN_ADAPTERS[req.harness]
  if (!adapter) throw new LoginFailure('login_unavailable')
  const executable = Bun.which(adapter.argv[0]!)
  if (!executable) throw new LoginFailure('login_unavailable')
  // Gemini's first-run method picker would hide the URL. Use a private settings copy, never
  // write through the allowlisted symlink into the user's default configuration.
  if (req.harness === 'gemini') {
    const settingsPath = join(req.root, '.gemini', 'settings.json')
    const settings = await readFile(settingsPath, 'utf8').then(s => JSON.parse(s)).catch(() => ({}))
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new LoginFailure('login_unavailable')
    const local = { ...settings, security: { ...settings.security, auth: { ...settings.security?.auth, selectedType: 'oauth-personal' } } }
    await unlink(settingsPath).catch(() => {})
    await writeFile(settingsPath, JSON.stringify(local), { mode: 0o600 })
  }
  const { bin, env } = await loginEnvironment(req)
  const clean = () => rm(bin, { recursive: true, force: true })
  if (adapter.pty) {
    const name = `account-login-${req.pendingId}`
    let ended = false, last = '', wake: (() => void) | undefined
    let resolveExit!: (code: number) => void
    const exited = new Promise<number>(r => { resolveExit = r })
    try {
      // `env -i` also clears variables inherited from a long-lived tmux server.
      const command = ['/usr/bin/env', '-i', ...Object.entries(env).map(([k,v]) => `${k}=${v}`), executable, ...adapter.argv.slice(1)].map(quote).join(' ')
      await tmux(['new-session', '-d', '-s', name, '-x', '240', '-y', '80', '-c', req.root, command])
      // Keep the pane after the CLI exits: its last words ("Login failed: …") and its exit status
      // are the only account of why a sign-in did not finish.
      await tmux(['set-option', '-t', name, 'remain-on-exit', 'on']).catch(() => {})
      loginLog(`[account-login] ${req.harness} sign-in runs in tmux -L ${SHELL_SOCKET} session ${name}${req.harness === 'claude' ? ` (keychain item "${claudeKeychainService(env)}")` : ''}`)
    } catch { await clean(); throw new LoginFailure('login_unavailable') }
    const capture = () => tmux(['capture-pane', '-p', '-J', '-t', name, '-S', '-100'])
    return {
      exited, snapshot: true,
      async read() {
        while (!ended) {
          try {
            const dead = parsePaneDead(await tmux(['display-message', '-p', '-t', name, '#{pane_dead} #{pane_dead_status}']))
            // -J rejoins soft-wrapped authorization URLs. Nothing is written to disk.
            const out = await capture()
            const digest = new Bun.CryptoHasher('sha256').update(out).digest('hex')
            if (digest !== last) { last = digest; return out }
            if (dead !== null) { ended = true; resolveExit(dead); return null }
          } catch { ended = true; resolveExit(0); return null }
          await new Promise<void>(r => { const t = setTimeout(r, 200); wake = () => { clearTimeout(t); r() } })
        }
        return null
      },
      async write(code) {
        // Feed the code on stdin, never argv, a named file, a log or a shell command.
        const buffer = `login-${req.pendingId}`
        await tmux(['load-buffer', '-b', buffer, '-'], code)
        try {
          await submitPasted({
            paste: () => tmux(['paste-buffer', '-d', '-r', '-b', buffer, '-t', name]).then(() => {}),
            enter: () => tmux(['send-keys', '-t', name, 'C-m']).then(() => {}),
            screen: capture,
          }, { code })
        } finally { await tmux(['delete-buffer', '-b', buffer]).catch(() => {}) }
      },
      async stop() {
        ended = true; last = ''; wake?.()
        await tmux(['kill-session', '-t', name], undefined, true)
        resolveExit(0); await clean()
      },
    }
  }
  const child = spawn(executable, adapter.argv.slice(1), { cwd: req.root, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const queue: string[] = []
  let finished = false, wake: (() => void) | undefined
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  const push = (s: string) => { queue.push(s); if (queue.length > 128) queue.shift(); wake?.(); wake = undefined }
  child.stdout.on('data', push); child.stderr.on('data', push)
  const exited = new Promise<number>(resolve => {
    const done = (code: number) => { if (finished) return; finished = true; resolve(code); wake?.() }
    child.on('error', () => done(1)); child.on('close', code => done(code ?? 1))
  })
  return {
    exited,
    async read() {
      if (!queue.length && !finished) await new Promise<void>(r => { wake = r })
      return queue.shift() ?? null
    },
    async write() { throw new LoginFailure('invalid_code') },
    async stop() {
      queue.length = 0
      if (child.pid && !finished) {
        try { process.kill(-child.pid, 'SIGKILL') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new LoginFailure('login_failed') }
      }
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
      finished = true; wake?.(); await clean()
    },
  }
}
