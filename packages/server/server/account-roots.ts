/**
 * account-roots.ts — a config ROOT per extra login (flag `multi-account`, spec §4, slice D1).
 *
 * A second account of the same harness needs its own login folder, and the harness only moves it
 * through one environment variable (`ISOLATION_ENV`). This module makes that folder, shares the
 * NON-credential configuration with the default root by symlink, starts the harness's own login in
 * it, and later turns the confirmed identity into an account.
 *
 * Rules that must hold:
 * - **A credential is never linked or copied.** `ROOT_SHARED` is an allowlist; `looksLikeCredential`
 *   is a second, independent refusal over the same names, and `account-roots.test.ts` greps the table
 *   for the credential file names of `backup-plan.ts`'s `HARNESS_SECRETS`.
 * - Directories are 0700. Credentials the harness writes inside a root stay there.
 * - **Deleting a root's directory needs `{confirm: <the root path>}`.** Without it the account is only
 *   retired (history and billing kept, invisible to agents).
 * - Equal treatment: every behaviour is a table keyed by `HarnessId`. A harness with no isolation
 *   variable (antigravity, opencode) is refused in words, not by a branch.
 * - Audit uses the existing `account.update`/`account.delete` actions with `meta.op` (the action union is
 *   the engine contract's and is held equal to it by engine-api-mirrors.test.ts).
 * - Nothing here logs an identity. The probes return whitelisted strings and stay in
 *   `harness-accounts.ts`.
 */
import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, rm, stat, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { HARNESS_ORDER, featureOn, type HarnessId } from '@agentistics/core'
import { AGENTISTICS_DATA_DIR, PORT } from './config'
import {
  ISOLATION_ENV, IDENTITY_PROBES, bind as bindAccount, byId, forceProbe, readAccounts, retireAccount,
  type AccountIdentity, type HarnessAccount,
} from './harness-accounts'
import { agentisticsMcpLaunch, rootMcpRegistration } from './mcp-launch'
import { reportAuditFailure, writeAudit } from './audit'
import { claudeKeychainService, launchLoginProcess, loginLog, LOGIN_ADAPTERS, LOGIN_MESSAGES, LoginFailure, startAccountLogin, type LoginError, type LoginHandle, type LoginInfo, type LoginOptions } from './account-login'
import { applyAccountToPlan } from './sessions/account-plan'

export { applyAccountToPlan }

/** The files/folders of a harness's config directory that every account shares. `null`: no roots. */
export const ROOT_SHARED: Record<HarnessId, string[] | null> = {
  claude: ['settings.json', 'skills', 'agents', 'commands', 'CLAUDE.md', 'plugins'],
  codex: ['config.toml', 'AGENTS.md', 'prompts'],
  // `config.json` holds `copilotTokens`/`loggedInUsers`: never shared.
  copilot: ['agents'],
  gemini: ['settings.json', 'GEMINI.md'],
  // `config.toml` may hold `api_key`: never shared.
  kimi: ['mcp.json'],
  antigravity: null,
  opencode: null,
}

/** Where, inside the root the isolation variable points at, the harness keeps its config. */
export const ROOT_CONFIG_SUBDIR: Record<HarnessId, string> = {
  claude: '', codex: '', copilot: '', kimi: '', antigravity: '', opencode: '',
  // GEMINI_CLI_HOME is the user's HOME for gemini: it creates `.gemini` inside it (its enterprise docs).
  gemini: '.gemini',
}

/**
 * How each harness signs in, read from the CLI's own `--help` (claude 2.1 `auth login`, codex `login`,
 * copilot `login`, kimi `login`). gemini has no login subcommand: its first run asks. `null`: no roots.
 */
export const LOGIN_START = LOGIN_ADAPTERS

/**
 * A file whose EXISTENCE (never its content) shows a harness without an identity probe has been
 * signed in. A harness with neither a probe nor a marker never binds a root by itself: "the login
 * session ended" is not a login (someone can close the pane). Being on disk, the evidence survives a
 * server restart.
 */
const LOGIN_MARKER: Record<HarnessId, { path: string; anyEntryBut?: string[] } | null> = {
  claude: null, codex: null, copilot: null, antigravity: null, opencode: null,
  // kimi writes `config.toml` with its DEFAULT text on first start (so it is no evidence of a login)
  // and keeps the device-code login's token in `<KIMI_CODE_HOME>/credentials/` (its toolkit's
  // `FileTokenStorage(join(homeDir, 'credentials'))`, read from the kimi 0.41 bundle, 2026-10-16).
  // That folder also holds MCP OAuth state under `mcp/`, which is not a kimi login, so the marker is
  // "credentials/ has an entry other than mcp". Names only; no file in it is ever read.
  kimi: { path: 'credentials', anyEntryBut: ['mcp'] },
  gemini: { path: join('.gemini', 'oauth_creds.json') },
}

/** Does the root show a login? Existence (and, for a folder marker, entry NAMES) only — never content. */
async function hasLoginMarker(harness: HarnessId, root: string): Promise<boolean> {
  const marker = LOGIN_MARKER[harness]
  if (!marker) return false
  const at = join(root, marker.path)
  if (!marker.anyEntryBut) return stat(at).then(() => true, () => false)
  const names = await readdir(at).catch(() => [] as string[])
  return names.some(n => !marker.anyEntryBut!.includes(n))
}

const DEFAULT_CONFIG_DIR: Record<HarnessId, () => string> = {
  claude: () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
  codex: () => process.env.CODEX_HOME ?? join(homedir(), '.codex'),
  copilot: () => process.env.COPILOT_HOME ?? join(homedir(), '.copilot'),
  gemini: () => join(process.env.GEMINI_CLI_HOME ?? homedir(), '.gemini'),
  kimi: () => process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code'),
  antigravity: () => join(homedir(), '.gemini', 'antigravity-cli'),
  opencode: () => process.env.OPENCODE_DIR ?? join(homedir(), '.local', 'share', 'opencode'),
}

/** Second, independent refusal: a name that reads like a credential is never linked, table or not. */
const CREDENTIAL_NAME = /cred|token|auth|oauth|secret|api[-_.]?key|\.pem$|\.key$|\.sealed$|^\.env|google_accounts|loggedin/i
export const looksLikeCredential = (name: string): boolean => CREDENTIAL_NAME.test(name)

const say = (en: string) => en
/** Keep an unreadable Claude root alive for Verify again, but never indefinitely. */
export const LOGIN_UNREADABLE_RETENTION_MS = 10 * 60_000

export type RootRefusal = 'disabled' | 'unsupported' | 'unknown_harness' | 'login_unavailable' | 'unsafe_path' | LoginError
export interface RootCreated {
  ok: true
  pendingId: string
  root: string
  env: Record<string, string>
  linked: string[]
}
export interface RootRefused { ok: false; reason: RootRefusal; message: string }

export interface PendingRoot { pendingId: string; harness: HarnessId; root: string; login?: LoginInfo }
export interface RootRow {
  harness: HarnessId
  root: string
  /** `pending`: waiting for the login to finish. `bound`: an account owns it. `retired`: its account was removed. */
  status: 'pending' | 'bound' | 'retired' | 'failed'
  pendingId?: string
  accountId?: string
  label?: string
  plan?: string
  error?: LoginError
  /** What the assistant's CLI said when the attempt failed after a code — masked, no code, no link. */
  detail?: string
  /** A Claude login that completed but could not be read is retained for a bounded re-probe. */
  retainedUntil?: number
  login?: LoginInfo
  /**
   * A pending folder with no sign-in process behind it in THIS server (it restarted, or the attempt
   * was abandoned): its link can never be completed, so the screen offers "start again", never a
   * dead "open login". The poller still binds it if a login did land on disk.
   */
  stale?: true
}

export interface AccountRootsDeps {
  /** Parent of every root: `<data>/accounts`. */
  base?: string
  flagOn?: () => boolean
  defaultDir?: (harness: HarnessId) => string
  login?: typeof startAccountLogin
  /** Which sign-in-capable CLIs are installed now. Default: a fresh lookup on the harness search path. */
  installed?: () => HarnessId[]
  loginOptions?: LoginOptions
  /** Is an account session still running? */
  sessionLive?: (sessionId: string) => Promise<boolean>
  /** Managed sessions started with this account id (D3 stamps `accountId` on the row). */
  sessionsOfAccount?: (accountId: string) => Promise<string[]>
  registerMcp?: (harness: HarnessId, root: string) => Promise<void>
  probe?: (harness: HarnessId, root: string) => Promise<AccountIdentity>
  bind?: typeof bindAccount
  retire?: typeof retireAccount
  getAccount?: typeof byId
  listAccounts?: typeof readAccounts
  audit?: typeof writeAudit
  /** Where the pending-login probe's outcome is recorded (facts only: no output, no token). */
  log?: (line: string) => void
  /** Told when an audit write fails (op + target only, never the sink's diagnostic). */
  onAuditFailure?: (op: unknown, targetId: string | undefined) => void
}

// `<data>/accounts`. The backup exclusion of the roots (credentials live inside) is its own row in
// `backup-plan.ts`, whose pattern is what keeps `accounts.json` (the registry) out of that rule.
const defaultBase = () => join(resolve(AGENTISTICS_DATA_DIR), 'accounts')

/** PURE. The env a session of this root gets (and the login session needs). */
export function rootEnv(harness: HarnessId, root: string): Record<string, string> {
  const variable = ISOLATION_ENV[harness]
  return variable ? { [variable]: root } : {}
}

/** Link the allowlisted names that exist in `from` into `to`. Returns the names linked. */
export async function linkSharedFiles(
  names: readonly string[], from: string, to: string,
): Promise<string[]> {
  const linked: string[] = []
  for (const name of names) {
    if (looksLikeCredential(name) || name.includes('/') || name.includes('..')) continue
    const source = join(resolve(from), name)
    try { await lstat(source) } catch { continue }
    try {
      await symlink(source, join(to, name))
      linked.push(name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  return linked
}

/**
 * HOTFIX.LOGIN-EXPIRADO. Can "Sign in again" run from the app for this account, re-binding the SAME
 * id? An account in its own root needs a harness that can move its login folder and has a login
 * recipe; an account on the harness's DEFAULT folder needs a recipe and an identity probe (the probe is
 * what proves the new login is the same person) — gemini's first-run login writes into the folder's
 * settings, so its default folder is not offered. Retired accounts are removed, not expired.
 */
export function reloginSupported(a: Pick<HarnessAccount, 'harness' | 'root' | 'retired'>): boolean {
  if (a.retired || !LOGIN_ADAPTERS[a.harness]) return false
  if (a.root) return ISOLATION_ENV[a.harness] !== null
  return IDENTITY_PROBES[a.harness] !== null && a.harness !== 'gemini'
}

/** PURE. Where an account is signed in: the binding that names it (its own root first), else its recorded root. */
export function reloginRoot(file: { bindings: Record<string, string> }, a: Pick<HarnessAccount, 'id' | 'harness' | 'root'>): string | null {
  const roots = Object.entries(file.bindings).filter(([k, v]) => v === a.id && k.startsWith(`${a.harness}:`)).map(([k]) => k.slice(a.harness.length + 1) || null)
  if (a.root && roots.includes(a.root)) return a.root
  return roots.find(r => r !== null) ?? (roots.length ? null : a.root)
}

export type ReloginStatus =
  | { status: 'pending'; accountId: string; login?: LoginInfo }
  | { status: 'done'; accountId: string; boundId: string; same: boolean }
  | { status: 'failed'; accountId: string; error: LoginError; message: string; detail?: string }

export function createAccountRoots(deps: AccountRootsDeps = {}) {
  const base = () => deps.base ?? defaultBase()
  const flagOn = deps.flagOn ?? (() => featureOn('multi-account'))
  const defaultDir = deps.defaultDir ?? ((h: HarnessId) => DEFAULT_CONFIG_DIR[h]())
  const audit = deps.audit ?? writeAudit
  const onAuditFailure = deps.onAuditFailure ?? reportAuditFailure
  // Audit delivery may wait on a remote database. Keep the record without holding the login
  // response or serialized root mutations behind that connection timeout.
  const auditLater = (input: Parameters<typeof writeAudit>[0]) => {
    const reportFailure = () => onAuditFailure(input.meta?.op, input.targetId)
    void Promise.resolve().then(() => audit(input, reportFailure)).catch(reportFailure)
  }
  const logins = new Map<string, LoginHandle>()
  const log = deps.log ?? loginLog
  /** The last probe outcome logged per pending root: a line per CHANGE, not per 2 s poll. */
  const probeNotes = new Map<string, string>()
  const noteProbe = (dir: PendingRoot, note: string) => {
    if (probeNotes.get(dir.pendingId) === note) return
    probeNotes.set(dir.pendingId, note)
    const item = dir.harness === 'claude' ? ` (keychain item "${claudeKeychainService(rootEnv(dir.harness, dir.root))}")` : ''
    log(`[account-roots] pending ${dir.harness} root ${dir.pendingId}${item}: probe ${note}`)
  }
  const failures = new Map<string, RootRow & { failedAt: number }>()
  /** Pending ids between folder creation and the login handle existing: not stale yet. */
  const starting = new Set<string>()
  const login = deps.login ?? startAccountLogin
  const probe = deps.probe ?? ((h: HarnessId, root: string) => forceProbe(h, root))
  const bind = deps.bind ?? bindAccount
  const retire = deps.retire ?? retireAccount
  const getAccount = deps.getAccount ?? byId
  const listAccounts = deps.listAccounts ?? readAccounts
  const sessionLive = deps.sessionLive ?? (async () => false)
  const sessionsOfAccount = deps.sessionsOfAccount ?? (async () => [])
  const registerMcp = deps.registerMcp ?? defaultRegisterMcp
  let mutations: Promise<unknown> = Promise.resolve()
  const serialized = <T>(run: () => Promise<T>): Promise<T> => {
    const next = mutations.then(run, run)
    mutations = next.catch(() => {})
    return next
  }
  let polling = false
  let timer: ReturnType<typeof setInterval> | undefined

  /** A path is a root only if it is exactly `<base>/<harness>/<id>`: nothing else is ever removed. */
  const isRootPath = (path: string): boolean => {
    const rel = resolve(path).slice(resolve(base()).length + 1).split(sep)
    return resolve(path).startsWith(resolve(base()) + sep) && rel.length === 2 && rel.every(Boolean)
      && HARNESS_ORDER.includes(rel[0] as HarnessId)
  }

  /** True when any existing component from `<base>` down to `path` is a symlink (or `base` itself is). */
  const hasSymlinkPart = async (path: string): Promise<boolean> => {
    const start = resolve(base())
    const parts = [start, ...resolve(path).slice(start.length + 1).split(sep).filter(Boolean).map((_, i, arr) => join(start, ...arr.slice(0, i + 1)))]
    for (const part of parts) {
      const info = await lstat(part).catch(() => null)
      if (info?.isSymbolicLink()) return true
    }
    return false
  }

  async function listDirs(): Promise<PendingRoot[]> {
    const out: PendingRoot[] = []
    for (const harness of HARNESS_ORDER) {
      let names: string[]
      try { names = await readdir(join(base(), harness)) } catch { continue }
      for (const pendingId of names) {
        if (failures.has(pendingId)) continue
        const root = join(base(), harness, pendingId)
        try { if (!(await lstat(root)).isDirectory()) continue } catch { continue }
        out.push({ pendingId, harness, root, ...(logins.get(pendingId)?.info() ? { login: logins.get(pendingId)!.info() } : {}) })
      }
    }
    return out
  }

  async function list(): Promise<RootRow[]> {
    const accounts = (await listAccounts()).accounts
    const rows: RootRow[] = []
    for (const dir of await listDirs()) {
      const owner = accounts.find(a => a.harness === dir.harness && a.root && resolve(a.root) === resolve(dir.root))
      rows.push({
        harness: dir.harness, root: dir.root, pendingId: dir.pendingId,
        status: !owner ? 'pending' : owner.retired ? 'retired' : 'bound',
        ...(owner ? { accountId: owner.id, label: owner.label, plan: owner.plan } : {}),
        ...(dir.login ? { login: dir.login } : {}),
        ...(!owner && !logins.has(dir.pendingId) && !starting.has(dir.pendingId) ? { stale: true as const } : {}),
      })
    }
    for (const [id, row] of failures) {
      if (row.error === 'login_unreadable' && row.retainedUntil !== undefined && Date.now() >= row.retainedUntil) {
        if (isRootPath(row.root) && !(await hasSymlinkPart(row.root))) await rm(row.root, { recursive: true, force: true })
        delete row.retainedUntil
      }
      if (Date.now() - row.failedAt > 900_000) failures.delete(id)
      else { const { failedAt, ...publicRow } = row; rows.push(publicRow) }
    }
    return rows
  }

  async function createRoot(harness: HarnessId): Promise<RootCreated | RootRefused> {
    if (!flagOn()) return { ok: false, reason: 'disabled', message: say('Multiple accounts are not enabled.') }
    if (!HARNESS_ORDER.includes(harness)) return { ok: false, reason: 'unknown_harness', message: say('Unknown assistant.') }
    const shared = ROOT_SHARED[harness]
    if (ISOLATION_ENV[harness] === null || shared === null || LOGIN_START[harness] === null) {
      return {
        ok: false, reason: 'unsupported',
        message: say(`This assistant keeps a single login per computer — it has no setting that moves its data folder, so a second account cannot be kept apart.`),
      }
    }
    const pendingId = `r_${randomBytes(6).toString('hex')}`
    const root = join(base(), harness, pendingId)
    if (await hasSymlinkPart(join(base(), harness))) {
      return { ok: false, reason: 'unsafe_path', message: say('The accounts folder contains a link, so it was left alone.') }
    }
    await mkdir(join(base(), harness), { recursive: true, mode: 0o700 })
    if (await hasSymlinkPart(join(base(), harness))) {
      return { ok: false, reason: 'unsafe_path', message: say('The accounts folder contains a link, so it was left alone.') }
    }
    await chmod(base(), 0o700)
    await chmod(join(base(), harness), 0o700)
    const config = join(root, ROOT_CONFIG_SUBDIR[harness])
    await mkdir(config, { recursive: true, mode: 0o700 })
    await chmod(root, 0o700)
    if (config !== root) await chmod(config, 0o700)
    const linked = await linkSharedFiles(shared, defaultDir(harness), config)
    await registerMcp(harness, root).catch(() => {})
    auditLater({ action: 'account.update', ip: 'local', targetId: pendingId, meta: { op: 'root_create', harness } })
    return { ok: true, pendingId, root, env: rootEnv(harness, root), linked }
  }

  async function discardPendingUnlocked(harness: HarnessId, pendingId: string, root: string, error: LoginError, detail?: string) {
    // A timeout racing a successful bind must never remove a bound account's credentials.
    if ((await listAccounts()).accounts.some(a => a.root && resolve(a.root) === resolve(root))) return
    if (error === 'login_unreadable') {
      const retainedUntil = Date.now() + LOGIN_UNREADABLE_RETENTION_MS
      failures.set(pendingId, { harness, pendingId, root, status: 'failed', error, retainedUntil, ...(detail ? { detail } : {}), failedAt: Date.now() })
      log(`[account-roots] pending ${harness} root ${pendingId}: retaining root for Verify again until ${new Date(retainedUntil).toISOString()}`)
      logins.delete(pendingId)
      return
    }
    failures.set(pendingId, { harness, pendingId, root, status: 'failed', error, ...(detail ? { detail } : {}), failedAt: Date.now() })
    logins.delete(pendingId)
    if (isRootPath(root) && !(await hasSymlinkPart(root))) await rm(root, { recursive: true, force: true })
  }

  async function startLogin(harness: HarnessId, pendingId: string, root: string, signal?: AbortSignal): Promise<LoginInfo> {
    const handle = await login({ harness, pendingId, root, env: rootEnv(harness, root) },
      (reason, detail) => serialized(() => discardPendingUnlocked(harness, pendingId, root, reason, detail)), deps.loginOptions)
    logins.set(pendingId, handle)
    if (signal?.aborted) await handle.stop()
    try { return await handle.ready } catch (error) { await handle.stop(); logins.delete(pendingId); throw error }
  }

  /** Create a private root and wait for the CLI's link/code, without creating a managed session. */
  async function addRoot(harness: HarnessId, signal?: AbortSignal): Promise<({ ok: true; pendingId: string; root: string } & LoginInfo) | RootRefused> {
    const made = await createRoot(harness)
    if (!made.ok) return made
    starting.add(made.pendingId)
    const cancelled = () => { void removeRoot(made.pendingId).catch(() => {}) }
    signal?.addEventListener('abort', cancelled, { once: true })
    try {
      if (signal?.aborted) throw new LoginFailure('login_failed')
      const info = await startLogin(harness, made.pendingId, made.root, signal)
      if (signal?.aborted) { await removeRoot(made.pendingId); throw new LoginFailure('login_failed') }
      ensurePoller()
      return { ok: true, pendingId: made.pendingId, root: made.root, ...info }
    } catch (error) {
      await serialized(async () => {
        const bound = (await listAccounts()).accounts.some(a => a.root && resolve(a.root) === resolve(made.root))
        if (!bound && isRootPath(made.root) && !(await hasSymlinkPart(made.root))) await rm(made.root, { recursive: true, force: true })
        failures.delete(made.pendingId)
      })
      const reason = error instanceof LoginFailure ? error.reason : 'login_unavailable'
      return { ok: false, reason, message: LOGIN_MESSAGES[reason] }
    } finally { starting.delete(made.pendingId); signal?.removeEventListener('abort', cancelled) }
  }

  async function submitCode(id: string, code: unknown) {
    const handle = logins.get(id)
    if (!handle) return { ok: false as const, reason: 'not_found', message: 'This sign-in is no longer available.' }
    try { await handle.submit(code); return { ok: true as const } }
    catch (error) {
      const reason = error instanceof LoginFailure ? error.reason : 'login_failed'
      return { ok: false as const, reason, message: LOGIN_MESSAGES[reason] }
    }
  }

  /** Re-read a completed Claude login without asking for another authorization code. */
  async function verifyPending(id: string) {
    const row = failures.get(id)
    if (!row || row.error !== 'login_unreadable') return { ok: false as const, reason: 'not_found', message: 'This sign-in is no longer available.' }
    if ((row.retainedUntil ?? 0) <= Date.now()) {
      failures.delete(id)
      if (isRootPath(row.root) && !(await hasSymlinkPart(row.root))) await rm(row.root, { recursive: true, force: true })
      return { ok: false as const, reason: 'login_timeout', message: LOGIN_MESSAGES.login_timeout }
    }
    const identity = await probe(row.harness, row.root).catch(() => null)
    if (!identity || identity.key === 'default') return { ok: false as const, reason: 'login_unreadable', message: LOGIN_MESSAGES.login_unreadable }
    const { account } = await bind(row.root, { harness: row.harness, ...identity })
    failures.delete(id)
    auditLater({ action: 'account.update', ip: 'local', targetId: account.id, meta: { op: 'root_login', harness: row.harness } })
    return { ok: true as const, accountId: account.id }
  }

  /** One pass: probe each pending root; a confirmed identity mints or adopts the account. */
  async function pollPendingUnlocked(): Promise<string[]> {
    if (polling) return []
    polling = true
    try {
      const bound: string[] = []
      const accounts = (await listAccounts()).accounts
      for (const dir of await listDirs()) {
        if (accounts.some(a => a.root && resolve(a.root) === resolve(dir.root))) continue
        let identity: AccountIdentity | null = null
        if (IDENTITY_PROBES[dir.harness]) {
          const found = await probe(dir.harness, dir.root).catch(() => null)
          if (found && found.key !== 'default') identity = found
          // Only once a code went in: before that "no login" is the expected answer.
          if (logins.get(dir.pendingId)?.submitted?.()) noteProbe(dir, !found ? 'failed' : identity ? 'found the login' : 'sees no login')
        } else {
          // No probe: only the harness's own marker on disk shows a login, and the fallback key is never an identity.
          if (await hasLoginMarker(dir.harness, dir.root)) {
            const found = await probe(dir.harness, dir.root).catch(() => null)
            if (found && found.key !== 'default') identity = found
          }
        }
        if (!identity) continue
        const { account } = await bind(dir.root, { harness: dir.harness, ...identity })
        await logins.get(dir.pendingId)?.stop()
        logins.delete(dir.pendingId)
        bound.push(account.id)
        auditLater({ action: 'account.update', ip: 'local', targetId: account.id, meta: { op: 'root_login', harness: dir.harness } })
      }
      return bound
    } finally { polling = false }
  }

  const pollPending = () => serialized(pollPendingUnlocked)

  /** Boot pass (spec §4.3): every claude/copilot root gets the MCP registration again. Best effort. */
  async function reregisterMcp(): Promise<void> {
    if (!flagOn()) return
    for (const dir of await listDirs()) {
      if (!rootMcpRegistration(dir.harness, dir.root, { command: '', args: [] }, '')) continue
      await registerMcp(dir.harness, dir.root).catch(() => {})
    }
  }

  function ensurePoller(intervalMs = 2000): void {
    if (timer) return
    timer = setInterval(() => {
      void pollPending().then(() => pollRelogins()).then(async () => {
        if (!(await list()).some(r => r.status === 'pending') && !reloginPending()) stopPoller()
      }).catch(() => {})
    }, intervalMs)
    timer.unref?.()
  }
  function stopPoller(): void { if (timer) { clearInterval(timer); timer = undefined } }

  /**
   * Remove a root. `id` is an account id or a pending id. A live session in it refuses (409
   * `root_in_use`); the account is retired; the directory goes only with `confirm === root`.
   */
  async function removeRootUnlocked(id: string, body: { confirm?: unknown } = {}): Promise<
    { ok: true; retired: boolean; removedDir: boolean; root: string; confirmWith?: string }
    | { ok: false; status: 404 | 409 | 400; reason: string; message: string }
  > {
    const failed = failures.get(id)
    if (failed) {
      failures.delete(id)
      if (isRootPath(failed.root) && !(await hasSymlinkPart(failed.root))) await rm(failed.root, { recursive: true, force: true })
      return { ok: true, retired: false, removedDir: true, root: failed.root }
    }
    let account = await getAccount(id)
    const dir = (await listDirs()).find(d => d.pendingId === id
      || (account?.root ? resolve(d.root) === resolve(account.root) : false))
    if (!account && dir) account = (await listAccounts()).accounts.find(a => a.root && resolve(a.root) === resolve(dir.root)) ?? null
    if (account && dir?.pendingId === id) return { ok: true, retired: false, removedDir: false, root: account.root! }
    const root = account?.root ?? dir?.root
    if (!root) return { ok: false, status: 404, reason: 'not_found', message: say('No such account root.') }
    if (body.confirm !== undefined && body.confirm !== root) {
      return { ok: false, status: 400, reason: 'confirm_mismatch', message: say('The confirmation must be the exact folder path of this root.') }
    }
    // A pending root (no account yet) is ours and holds nothing but the login: Cancel ends the login
    // process THIS module spawned and drops the folder. Any other session in it still refuses.
    const pending = !account && !!dir
    const watched = [id, ...(dir ? [dir.pendingId] : [])]
    const sessions = new Set<string>()
    for (const w of watched) {
      for (const s of await sessionsOfAccount(w)) sessions.add(s)
    }
    for (const s of sessions) {
      if (await sessionLive(s).catch(() => true)) {
        return { ok: false, status: 409, reason: 'root_in_use', message: say('A session is still running in this account. End it first.') }
      }
    }
    if (pending && dir) {
      try { await logins.get(dir.pendingId)?.stop() }
      catch { return { ok: false, status: 409, reason: 'root_in_use', message: 'The sign-in process could not be stopped. Try again.' } }
      logins.delete(dir.pendingId)
    }
    // Pending roots are dropped without a typed confirmation: there is no account to keep.
    if (pending && body.confirm === undefined) body = { confirm: root }
    if (body.confirm === root) {
      const bad = !isRootPath(root) || await hasSymlinkPart(root)
      if (bad) return { ok: false, status: 400, reason: 'not_a_root', message: say('That folder is not an account root.') }
    }
    let retired = false
    if (account) { await retire(account.id); retired = true; auditLater({ action: 'account.update', ip: 'local', targetId: account.id, meta: { op: 'root_retire', harness: account.harness } }) }
    let removedDir = false
    if (body.confirm === root) {
      await rm(root, { recursive: true, force: true })
      removedDir = true
      if (dir) logins.delete(dir.pendingId)
      auditLater({ action: 'account.delete', ip: 'local', targetId: account?.id ?? dir?.pendingId ?? id, meta: { op: 'root_delete', harness: account?.harness ?? dir?.harness } })
    }
    return { ok: true, retired, removedDir, root, ...(removedDir ? {} : { confirmWith: root }) }
  }

  const removeRoot = (id: string, body: { confirm?: unknown } = {}) => serialized(() => removeRootUnlocked(id, body))

  // ── Sign in again (HOTFIX.LOGIN-EXPIRADO) ────────────────────────────────────────────────────
  interface Relogin {
    accountId: string; harness: HarnessId; root: string | null; pendingId: string
    /** Working folder of a default-root sign-in (the CLI's cwd and private PATH), removed after. */
    scratch?: string
    /** The CLI's own exit status, once it ended by itself (never after we stopped it). */
    exited?: number
    state: ReloginStatus
    at: number
  }
  const relogins = new Map<string, Relogin>()
  const dropScratch = async (r: Relogin) => {
    if (r.scratch && resolve(r.scratch).startsWith(resolve(base()) + sep)) await rm(r.scratch, { recursive: true, force: true }).catch(() => {})
  }

  /**
   * Start a sign-in for an EXISTING account, in the folder it already lives in. The new login lands
   * where the old one was, and the bind re-adopts the same id (nickname, plan, history and the agent
   * switch kept: they are fields of the record, never touched here). Completion is the CLI ending
   * with status 0 — an identity probe alone cannot tell a fresh token from the expired one, which
   * still names its owner.
   */
  async function relogin(accountId: string, signal?: AbortSignal): Promise<({ ok: true; pendingId: string } & LoginInfo) | RootRefused | { ok: false; reason: 'not_found' | 'retired'; message: string }> {
    if (!flagOn()) return { ok: false, reason: 'disabled', message: say('Multiple accounts are not enabled.') }
    const account = await getAccount(accountId)
    if (!account) return { ok: false, reason: 'not_found', message: say('No such account.') }
    if (account.retired) return { ok: false, reason: 'retired', message: say('This account was removed.') }
    const file = await listAccounts()
    const root = reloginRoot(file, account)
    if (!reloginSupported({ ...account, root })) {
      return { ok: false, reason: 'unsupported', message: say('This assistant cannot be signed in again from the app for this account.') }
    }
    if (root && (!isRootPath(root) || await hasSymlinkPart(root) || !(await stat(root).then(s => s.isDirectory(), () => false)))) {
      return { ok: false, reason: 'unsafe_path', message: say('The account folder is missing or is not an account folder.') }
    }
    const live = relogins.get(account.id)
    if (live?.state.status === 'pending') {
      const info = logins.get(live.pendingId)?.info()
      if (info) return { ok: true, pendingId: live.pendingId, ...info }
      await cancelRelogin(account.id)
    }
    const pendingId = `l_${randomBytes(6).toString('hex')}`
    let workdir = root
    let scratch: string | undefined
    if (!workdir) {
      scratch = join(base(), '.relogin', pendingId)
      await mkdir(scratch, { recursive: true, mode: 0o700 })
      workdir = scratch
    }
    // A sign-in that died mid-way can leave its private PATH folder behind; the next one recreates it.
    await rm(join(workdir, '.login-bin'), { recursive: true, force: true }).catch(() => {})
    const entry: Relogin = { accountId: account.id, harness: account.harness, root, pendingId, ...(scratch ? { scratch } : {}), state: { status: 'pending', accountId: account.id }, at: Date.now() }
    relogins.set(account.id, entry)
    const baseLaunch = deps.loginOptions?.launch ?? launchLoginProcess
    let stopping = false
    const options: LoginOptions = {
      ...deps.loginOptions,
      launch: async req => {
        const proc = await baseLaunch(req)
        void proc.exited.then(code => { if (!stopping) entry.exited = code })
        return { ...proc, stop: async () => { stopping = true; await proc.stop() } }
      },
    }
    try {
      const handle = await login({ harness: account.harness, pendingId, root: workdir, env: root ? rootEnv(account.harness, root) : {} },
        async (reason, detail) => {
          if (relogins.get(account.id) !== entry || entry.state.status !== 'pending') return
          entry.state = { status: 'failed', accountId: account.id, error: reason, message: LOGIN_MESSAGES[reason], ...(detail ? { detail } : {}) }
          logins.delete(pendingId)
          await dropScratch(entry)
        }, options)
      logins.set(pendingId, handle)
      if (signal?.aborted) { await cancelRelogin(account.id); throw new LoginFailure('login_failed') }
      const info = await handle.ready
      ensurePoller()
      auditLater({ action: 'account.update', ip: 'local', targetId: account.id, meta: { op: 'relogin_start', harness: account.harness } })
      return { ok: true, pendingId, ...info }
    } catch (error) {
      const reason = error instanceof LoginFailure ? error.reason : 'login_unavailable'
      if (relogins.get(account.id) === entry) relogins.delete(account.id)
      await logins.get(pendingId)?.stop().catch(() => {})
      logins.delete(pendingId)
      await dropScratch(entry)
      return { ok: false, reason, message: LOGIN_MESSAGES[reason] }
    }
  }

  function reloginStatus(accountId: string): ReloginStatus | null {
    const entry = relogins.get(accountId)
    if (!entry) return null
    if (entry.state.status === 'pending') {
      const info = logins.get(entry.pendingId)?.info()
      return { status: 'pending', accountId, ...(info ? { login: info } : {}) }
    }
    return entry.state
  }

  async function reloginCode(accountId: string, code: unknown) {
    const entry = relogins.get(accountId)
    if (!entry || entry.state.status !== 'pending') return { ok: false as const, reason: 'not_found', message: 'This sign-in is no longer available.' }
    return submitCode(entry.pendingId, code)
  }

  async function cancelRelogin(accountId: string): Promise<boolean> {
    const entry = relogins.get(accountId)
    if (!entry) return false
    relogins.delete(accountId)
    await logins.get(entry.pendingId)?.stop().catch(() => {})
    logins.delete(entry.pendingId)
    await dropScratch(entry)
    return true
  }

  /** One pass over the sign-ins-again: a CLI that ended with 0 is probed and its login bound in place. */
  async function pollReloginsUnlocked(): Promise<string[]> {
    const bound: string[] = []
    for (const [accountId, entry] of relogins) {
      if (entry.state.status !== 'pending') {
        if (Date.now() - entry.at > 900_000) relogins.delete(accountId)
        continue
      }
      if (entry.exited !== 0) continue
      const identity = await probe(entry.harness, entry.root as string).catch(() => null)
      if (!identity || identity.key === 'default') continue
      const { account } = await bind(entry.root, { harness: entry.harness, ...identity })
      entry.state = { status: 'done', accountId, boundId: account.id, same: account.id === accountId }
      entry.at = Date.now()
      await logins.get(entry.pendingId)?.stop().catch(() => {})
      logins.delete(entry.pendingId)
      await dropScratch(entry)
      bound.push(account.id)
      auditLater({ action: 'account.update', ip: 'local', targetId: account.id, meta: { op: 'relogin', harness: entry.harness } })
    }
    return bound
  }
  const pollRelogins = () => serialized(pollReloginsUnlocked)
  const reloginPending = () => [...relogins.values()].some(r => r.state.status === 'pending')

  return { createRoot, startLogin, addRoot, submitCode, verifyPending, list, pollPending, ensurePoller, stopPoller, removeRoot, reregisterMcp, flagOn, relogin, reloginStatus, reloginCode, cancelRelogin, pollRelogins }
}

export interface McpChild { exited: Promise<number>; kill: (signal?: string) => void }

/**
 * Register the agentistics MCP inside one root, through the harness's own `mcp add`. Best effort:
 * the child gets no stdin and no pipes to fill, and is killed if it does not finish (a first-run
 * prompt in a fresh config dir must not hang the request).
 */
export async function registerRootMcp(
  harness: HarnessId, root: string,
  opts: { spawn?: (argv: string[], env: Record<string, string>) => McpChild; timeoutMs?: number } = {},
): Promise<void> {
  const reg = rootMcpRegistration(harness, root, agentisticsMcpLaunch(), `http://localhost:${PORT}`)
  if (!reg) return
  const spawn = opts.spawn ?? ((argv, env) => Bun.spawn(argv, {
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', env: { ...process.env, ...env },
  }) as unknown as McpChild)
  const timeoutMs = opts.timeoutMs ?? 10_000
  // Each child gets its own kill: a remove that hangs must not leave the add unbounded either.
  const run = async (argv: string[]) => {
    const child = spawn(argv, reg.env)
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    try { await Promise.race([child.exited, new Promise<void>(done => setTimeout(done, timeoutMs + 50))]) } finally { clearTimeout(timer) }
  }
  // Remove, then add: `mcp add` refuses an existing name, so this is what repairs a stale entry.
  await run(reg.removeArgv)
  await run(reg.argv)
}
const defaultRegisterMcp = (harness: HarnessId, root: string) => registerRootMcp(harness, root)

let instance: ReturnType<typeof createAccountRoots> | undefined
export function accountRoots(deps?: AccountRootsDeps): ReturnType<typeof createAccountRoots> {
  if (deps) return createAccountRoots(deps)
  return (instance ??= createAccountRoots({ sessionLive: defaultSessionLive, sessionsOfAccount: defaultSessionsOfAccount }))
}

async function defaultSessionLive(sessionId: string): Promise<boolean> {
  const { ensureSessionHub } = await import('./cli-start')
  const snapshot = await (await ensureSessionHub()).read()
  return snapshot.sessions.some(r => r.id === sessionId && r.status === 'running')
}

async function defaultSessionsOfAccount(accountId: string): Promise<string[]> {
  const { readRegistry } = await import('./sessions/registry')
  return (await readRegistry()).filter(m => (m as { accountId?: string }).accountId === accountId).map(m => m.id)
}
