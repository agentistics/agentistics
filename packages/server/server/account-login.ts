/** Headless account login. Output and pasted authorization codes never enter logs or files. */
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HarnessId } from '@agentistics/core'
import { isSessionGoneError, SHELL_SOCKET } from './sessions/tmux-cli'

export type LoginKind = 'paste' | 'device'
export type LoginError = 'login_unavailable' | 'login_timeout' | 'login_failed' | 'plaintext_refused' | 'invalid_code'
export interface LoginInfo { kind: LoginKind; url: string; code?: string; expiresAt: number }
interface LoginAdapter { argv: string[]; kind: LoginKind; pty: boolean; hosts: readonly string[]; path: RegExp }
// @harness-adapters-only: login protocols are facts of each vendor CLI, not a preferred assistant.
export const LOGIN_ADAPTERS: Record<HarnessId, LoginAdapter | null> = {
  claude: { argv: ['claude', 'auth', 'login', '--claudeai'], kind: 'paste', pty: true, hosts: ['claude.ai', 'platform.claude.com', 'console.anthropic.com'], path: /^\/oauth\/authorize\/?$/ },
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
}
export class LoginFailure extends Error {
  constructor(readonly reason: LoginError) { super(LOGIN_MESSAGES[reason]) }
}

export const stripLoginAnsi = (s: string) => s.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
export function loginRefusal(output: string): LoginError | undefined {
  return /keychain unavailable|store token in plaintext|token (?:was |could )?not (?:be )?saved|token was not saved/i.test(stripLoginAnsi(output)) ? 'plaintext_refused' : undefined
}
/** Accept only authorization URLs on the adapter's hosts, never URLs from arbitrary diagnostics. */
export function parseLoginOutput(harness: HarnessId, output: string, now = Date.now()): LoginInfo | null {
  const adapter = LOGIN_ADAPTERS[harness]
  if (!adapter) return null
  const text = stripLoginAnsi(output)
  const urls = text.match(/https:\/\/[^\s<>"'\x00-\x1f]+(?=[\s<>"'\x00-\x1f])/g) ?? []
  const url = urls.map(s => s.replace(/[),.;]+$/, '')).find(s => {
    try { const u = new URL(s); return adapter.hosts.includes(u.hostname) && adapter.path.test(u.pathname) && !u.username && !u.password && u.port === '' && !(harness === 'claude' && /^http:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/.test(u.searchParams.get('redirect_uri') ?? '')) } catch { return false }
  })
  if (!url) return null
  // Claude's displayed fallback link uses the manual redirect; no localhost callback is exposed.
  if (harness === 'claude') {
    const u = new URL(url)
    const redirect = u.searchParams.get('redirect_uri')
    if (redirect?.startsWith('http://localhost') || redirect?.startsWith('http://127.0.0.1')) return null
  }
  const code = text.match(/(?:enter\s+(?:the\s+)?(?:one-time\s+)?code|one-time\s+code)\s*[:\s]*([A-Z0-9]{4}(?:-[A-Z0-9]{4})+)\b/i)?.[1]
    ?? text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/)?.[1]
    ?? new URL(url).searchParams.get('user_code') ?? undefined
  if (adapter.kind === 'device' && !code) return null
  const seconds = text.match(/(?:code\s+)?expires in\s+(\d+)\s*s\b/i)?.[1]
  const minutes = text.match(/expires in\s+(\d+)\s*minutes?/i)?.[1]
  const ttl = seconds ? Number(seconds) * 1000 : minutes ? Number(minutes) * 60_000 : harness === 'gemini' ? 300_000 : 900_000
  return { kind: adapter.kind, url, ...(adapter.kind === 'device' ? { code } : {}), expiresAt: now + Math.min(ttl, 900_000) }
}

export interface LoginProcess {
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
}
export interface LoginOptions {
  launch?: (req: LoginRequest) => Promise<LoginProcess>
  readyTimeoutMs?: number
  overallTimeoutMs?: number
  now?: () => number
}
/** The controller holds only public link/device metadata. Pasted codes are written once and discarded. */
export async function startAccountLogin(req: LoginRequest, onFailure: (reason: LoginError) => Promise<void>, opts: LoginOptions = {}): Promise<LoginHandle> {
  const proc = await (opts.launch ?? launchLoginProcess)(req).catch(() => { throw new LoginFailure('login_unavailable') })
  let info: LoginInfo | undefined, stopped = false, submitted = false, buffer = ''
  let resolveReady!: (info: LoginInfo) => void, rejectReady!: (e: LoginFailure) => void
  const ready = new Promise<LoginInfo>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  // Attach immediately: a process can fail before the HTTP caller starts awaiting `ready`.
  void ready.catch(() => {})
  const now = opts.now ?? Date.now
  const deadline = now() + (opts.overallTimeoutMs ?? 900_000)
  let linkAt: number | undefined
  const stop = async (failure?: LoginError) => {
    if (stopped) return
    stopped = true; buffer = ''; clearTimeout(readyTimer); clearTimeout(expiryTimer)
    try { await proc.stop() } catch { stopped = false; throw new LoginFailure('login_failed') }
    if (!failure) rejectReady(new LoginFailure('login_failed'))
  }
  const fail = async (reason: LoginError) => {
    if (stopped) return
    try { await stop(reason); await onFailure(reason) } finally { rejectReady(new LoginFailure(reason)) }
  }
  const readyTimer = setTimeout(() => { void fail('login_timeout').catch(() => {}) }, opts.readyTimeoutMs ?? 30_000)
  let expiryTimer = setTimeout(() => { void fail('login_timeout').catch(() => {}) }, opts.overallTimeoutMs ?? 900_000)
  readyTimer.unref?.(); expiryTimer.unref?.()
  void (async () => {
    try {
      while (!stopped) {
        const chunk = await proc.read()
        if (chunk === null) break
        if (submitted) continue // Do not parse or retain a CLI's possible echo of the pasted secret.
        buffer = (buffer + chunk).slice(-65536)
        if (req.harness === 'copilot' && loginRefusal(buffer)) { await fail('plaintext_refused'); return }
        const parsed = parseLoginOutput(req.harness, buffer, linkAt ?? now())
        if (parsed) {
          linkAt ??= now()
          parsed.expiresAt = Math.min(parsed.expiresAt, deadline)
          if (!info || parsed.expiresAt < info.expiresAt) {
            info = parsed; clearTimeout(readyTimer); clearTimeout(expiryTimer)
            expiryTimer = setTimeout(() => { void fail('login_timeout').catch(() => {}) }, Math.max(0, parsed.expiresAt - now()))
            expiryTimer.unref?.(); resolveReady(parsed)
          }
        }
      }
      const exit = await proc.exited
      if (!stopped && (exit !== 0 || !info)) await fail('login_failed')
      // A successful CLI exit is not proof of identity. Root polling must still bind the account.
    } catch { await fail('login_failed').catch(() => {}) }
  })()
  return {
    ready, info: () => info, stop,
    async submit(code) {
      if (stopped || !info || info.kind !== 'paste' || submitted) throw new LoginFailure('login_failed')
      if (typeof code !== 'string' || !code.trim() || code.length > 8192 || /[\x00-\x20\x7f]/.test(code.trim())) throw new LoginFailure('invalid_code')
      submitted = true; buffer = ''
      try { await proc.write(code.trim()) } catch { await fail('login_failed'); throw new LoginFailure('login_failed') }
    },
  }
}

const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"
/** Only runtime executables enter PATH. In particular xdg-open/open/browser launchers are absent. */
async function loginEnvironment(req: LoginRequest) {
  const bin = join(req.root, '.login-bin')
  await mkdir(bin, { mode: 0o700 })
  for (const name of ['node', 'bun', 'python3', 'python', 'sh', 'bash', 'env', 'dirname', 'readlink']) {
    const path = Bun.which(name)
    if (path) await symlink(path, join(bin, name))
  }
  // No inherited API keys, access tokens, agent variables, display or browser environment.
  const env: Record<string, string> = { HOME: homedir(), PATH: bin, TERM: 'xterm-256color', LANG: process.env.LANG ?? 'en_US.UTF-8', BROWSER: '/bin/true', NO_BROWSER: 'true', ...req.env }
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
    let ended = false, inputSent = false, last = '', wake: (() => void) | undefined
    let resolveExit!: (code: number) => void
    const exited = new Promise<number>(r => { resolveExit = r })
    try {
      // `env -i` also clears variables inherited from a long-lived tmux server.
      const command = ['/usr/bin/env', '-i', ...Object.entries(env).map(([k,v]) => `${k}=${v}`), executable, ...adapter.argv.slice(1)].map(quote).join(' ')
      await tmux(['new-session', '-d', '-s', name, '-x', '240', '-y', '80', '-c', req.root, command])
    } catch { await clean(); throw new LoginFailure('login_unavailable') }
    return {
      exited,
      async read() {
        while (!ended) {
          if (inputSent) {
            await new Promise<void>(r => { const t = setTimeout(r, 200); wake = () => { clearTimeout(t); r() } })
            continue
          }
          try {
            // -J rejoins soft-wrapped authorization URLs. Nothing is written to disk.
            const out = await tmux(['capture-pane', '-p', '-J', '-t', name, '-S', '-100'])
            if (out !== last) { last = out; return out }
          } catch { ended = true; resolveExit(0); return null }
          await new Promise<void>(r => { const t = setTimeout(r, 200); wake = () => { clearTimeout(t); r() } })
        }
        return null
      },
      async write(code) {
        inputSent = true; last = ''
        // Feed the code on stdin, never argv, a named file, a log or a shell command.
        const buffer = `login-${req.pendingId}`
        await tmux(['load-buffer', '-b', buffer, '-'], code)
        try {
          await tmux(['paste-buffer', '-d', '-r', '-b', buffer, '-t', name])
          await tmux(['send-keys', '-t', name, 'Enter'])
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
