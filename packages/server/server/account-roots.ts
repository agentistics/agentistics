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
import { AGENTISTICS_DATA_DIR } from './config'
import {
  ISOLATION_ENV, IDENTITY_PROBES, bind as bindAccount, byId, forceProbe, readAccounts, retireAccount,
  type AccountIdentity,
} from './harness-accounts'
import { agentisticsMcpLaunch, rootMcpRegistration } from './mcp-launch'
import { writeAudit } from './audit'
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
export const LOGIN_START: Record<HarnessId, { argv: string[] } | null> = {
  claude: { argv: ['claude', 'auth', 'login'] },
  codex: { argv: ['codex', 'login'] },
  copilot: { argv: ['copilot', 'login'] },
  gemini: { argv: ['gemini'] },
  kimi: { argv: ['kimi', 'login'] },
  antigravity: null,
  opencode: null,
}

/**
 * A file whose EXISTENCE (never its content) shows a harness without an identity probe has been
 * signed in. `null`: the only evidence is that the login session ended.
 */
const LOGIN_MARKER: Record<HarnessId, string | null> = {
  claude: null, codex: null, copilot: null, kimi: null, antigravity: null, opencode: null,
  gemini: join('.gemini', 'oauth_creds.json'),
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

export type RootRefusal = 'disabled' | 'unsupported' | 'unknown_harness' | 'login_unavailable'
export interface RootCreated {
  ok: true
  pendingId: string
  root: string
  env: Record<string, string>
  linked: string[]
}
export interface RootRefused { ok: false; reason: RootRefusal; message: string }

export interface PendingRoot { pendingId: string; harness: HarnessId; root: string; loginSessionId?: string }
export interface RootRow {
  harness: HarnessId
  root: string
  /** `pending`: waiting for the login to finish. `bound`: an account owns it. `retired`: its account was removed. */
  status: 'pending' | 'bound' | 'retired'
  pendingId?: string
  accountId?: string
  loginSessionId?: string
}

export interface LoginSpawn {
  harness: HarnessId
  cwd: string
  label: string
  account: { env: Record<string, string>; loginArgv: string[] }
}

export interface AccountRootsDeps {
  /** Parent of every root: `<data>/accounts`. */
  base?: string
  flagOn?: () => boolean
  defaultDir?: (harness: HarnessId) => string
  /** Starts the login managed session; the real one goes through the control host. */
  spawn?: (req: LoginSpawn) => Promise<{ ok: boolean; message: string; id?: string }>
  /** Is this managed session still running? */
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
}

// The trailing slash is deliberate: `backup-plan.ts` excludes `.agentistics/accounts/` (credentials live
// inside) without also catching the `accounts.json` registry, which a bare prefix would.
const defaultBase = () => join(AGENTISTICS_DATA_DIR, 'accounts/')

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
    const source = join(from, name)
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

export function createAccountRoots(deps: AccountRootsDeps = {}) {
  const base = () => deps.base ?? defaultBase()
  const flagOn = deps.flagOn ?? (() => featureOn('multi-account'))
  const defaultDir = deps.defaultDir ?? ((h: HarnessId) => DEFAULT_CONFIG_DIR[h]())
  const audit = deps.audit ?? writeAudit
  const logins = new Map<string, string>() // pendingId -> login managed session id
  const loginHarness = new Map<string, HarnessId>()
  const probe = deps.probe ?? ((h: HarnessId, root: string) => forceProbe(h, root))
  const bind = deps.bind ?? bindAccount
  const retire = deps.retire ?? retireAccount
  const getAccount = deps.getAccount ?? byId
  const listAccounts = deps.listAccounts ?? readAccounts
  const sessionLive = deps.sessionLive ?? (async () => false)
  const sessionsOfAccount = deps.sessionsOfAccount ?? (async () => [])
  const registerMcp = deps.registerMcp ?? defaultRegisterMcp
  let timer: ReturnType<typeof setInterval> | undefined

  /** A path is a root only if it is exactly `<base>/<harness>/<id>`: nothing else is ever removed. */
  const isRootPath = (path: string): boolean => {
    const rel = resolve(path).slice(resolve(base()).length + 1).split(sep)
    return resolve(path).startsWith(resolve(base()) + sep) && rel.length === 2 && rel.every(Boolean)
      && HARNESS_ORDER.includes(rel[0] as HarnessId)
  }

  async function listDirs(): Promise<PendingRoot[]> {
    const out: PendingRoot[] = []
    for (const harness of HARNESS_ORDER) {
      let names: string[]
      try { names = await readdir(join(base(), harness)) } catch { continue }
      for (const pendingId of names) {
        const root = join(base(), harness, pendingId)
        try { if (!(await lstat(root)).isDirectory()) continue } catch { continue }
        out.push({ pendingId, harness, root, ...(logins.has(pendingId) ? { loginSessionId: logins.get(pendingId)! } : {}) })
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
        ...(owner ? { accountId: owner.id } : {}),
        ...(dir.loginSessionId ? { loginSessionId: dir.loginSessionId } : {}),
      })
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
    await mkdir(join(base(), harness), { recursive: true, mode: 0o700 })
    await chmod(base(), 0o700)
    await chmod(join(base(), harness), 0o700)
    const config = join(root, ROOT_CONFIG_SUBDIR[harness])
    await mkdir(config, { recursive: true, mode: 0o700 })
    await chmod(root, 0o700)
    if (config !== root) await chmod(config, 0o700)
    const linked = await linkSharedFiles(shared, defaultDir(harness), config)
    await registerMcp(harness, root).catch(() => {})
    await audit({ action: 'account.update', ip: 'local', targetId: pendingId, meta: { op: 'root_create', harness } })
    return { ok: true, pendingId, root, env: rootEnv(harness, root), linked }
  }

  async function startLogin(harness: HarnessId, pendingId: string, root: string): Promise<{ ok: boolean; message: string; id?: string }> {
    const start = LOGIN_START[harness]
    if (!start || !deps.spawn) return { ok: false, message: say('Signing in is not available for this assistant.') }
    const out = await deps.spawn({
      harness, cwd: homedir(), label: `Sign in · ${harness}`,
      account: { env: rootEnv(harness, root), loginArgv: start.argv },
    })
    if (out.ok && out.id) { logins.set(pendingId, out.id); loginHarness.set(pendingId, harness) }
    return out
  }

  /** Create the root and open the login session in it. A failed login start leaves no empty root behind. */
  async function addRoot(harness: HarnessId): Promise<{ ok: true; pendingId: string; root: string; sessionId?: string; message: string } | RootRefused> {
    const made = await createRoot(harness)
    if (!made.ok) return made
    const out = await startLogin(harness, made.pendingId, made.root)
    if (!out.ok) {
      await rm(made.root, { recursive: true, force: true })
      return { ok: false, reason: 'login_unavailable', message: out.message }
    }
    ensurePoller()
    return { ok: true, pendingId: made.pendingId, root: made.root, ...(out.id ? { sessionId: out.id } : {}), message: out.message }
  }

  /** One pass: probe each pending root; a confirmed identity mints or adopts the account. */
  async function pollPending(): Promise<string[]> {
    const bound: string[] = []
    const accounts = (await listAccounts()).accounts
    for (const dir of await listDirs()) {
      if (accounts.some(a => a.root && resolve(a.root) === resolve(dir.root))) continue
      const live = dir.loginSessionId ? await sessionLive(dir.loginSessionId).catch(() => true) : false
      let identity: AccountIdentity | null = null
      if (IDENTITY_PROBES[dir.harness]) {
        const found = await probe(dir.harness, dir.root).catch(() => null)
        if (found && found.key !== 'default') identity = found
      } else {
        // No probe: sign-in evidence is the marker file's existence (never read), else the login ended.
        const marker = LOGIN_MARKER[dir.harness]
        const signedIn = marker ? await stat(join(dir.root, marker)).then(() => true, () => false) : !live && !!dir.loginSessionId
        if (signedIn) identity = await probe(dir.harness, dir.root).catch(() => null)
      }
      if (!identity) continue
      const { account } = await bind(dir.root, { harness: dir.harness, ...identity })
      bound.push(account.id)
      await audit({ action: 'account.update', ip: 'local', targetId: account.id, meta: { op: 'root_login', harness: dir.harness } })
    }
    return bound
  }

  function ensurePoller(intervalMs = 60_000): void {
    if (timer) return
    timer = setInterval(() => {
      void pollPending().then(async () => {
        if (!(await list()).some(r => r.status === 'pending')) stopPoller()
      }).catch(() => {})
    }, intervalMs)
    timer.unref?.()
  }
  function stopPoller(): void { if (timer) { clearInterval(timer); timer = undefined } }

  /**
   * Remove a root. `id` is an account id or a pending id. A live session in it refuses (409
   * `root_in_use`); the account is retired; the directory goes only with `confirm === root`.
   */
  async function removeRoot(id: string, body: { confirm?: unknown } = {}): Promise<
    { ok: true; retired: boolean; removedDir: boolean; root: string; confirmWith?: string }
    | { ok: false; status: 404 | 409 | 400; reason: string; message: string }
  > {
    const account = await getAccount(id)
    const dir = (await listDirs()).find(d => d.pendingId === id
      || (account?.root ? resolve(d.root) === resolve(account.root) : false))
    const root = account?.root ?? dir?.root
    if (!root) return { ok: false, status: 404, reason: 'not_found', message: say('No such account root.') }
    if (body.confirm !== undefined && body.confirm !== root) {
      return { ok: false, status: 400, reason: 'confirm_mismatch', message: say('The confirmation must be the exact folder path of this root.') }
    }
    const watched = [id, ...(dir ? [dir.pendingId] : [])]
    const sessions = new Set<string>()
    for (const w of watched) {
      if (logins.has(w)) sessions.add(logins.get(w)!)
      for (const s of await sessionsOfAccount(w)) sessions.add(s)
    }
    for (const s of sessions) {
      if (await sessionLive(s).catch(() => true)) {
        return { ok: false, status: 409, reason: 'root_in_use', message: say('A session is still running in this account. End it first.') }
      }
    }
    let retired = false
    if (account) { await retire(account.id); retired = true; await audit({ action: 'account.update', ip: 'local', targetId: account.id, meta: { op: 'root_retire', harness: account.harness } }) }
    let removedDir = false
    if (body.confirm === root) {
      if (!isRootPath(root)) return { ok: false, status: 400, reason: 'not_a_root', message: say('That folder is not an account root.') }
      if ((await lstat(root).catch(() => null))?.isSymbolicLink()) return { ok: false, status: 400, reason: 'not_a_root', message: say('That folder is not an account root.') }
      await rm(root, { recursive: true, force: true })
      removedDir = true
      if (dir) logins.delete(dir.pendingId)
      await audit({ action: 'account.delete', ip: 'local', targetId: account?.id ?? dir?.pendingId ?? id, meta: { op: 'root_delete', harness: account?.harness ?? dir?.harness } })
    }
    return { ok: true, retired, removedDir, root, ...(removedDir ? {} : { confirmWith: root }) }
  }

  return { createRoot, startLogin, addRoot, list, pollPending, ensurePoller, stopPoller, removeRoot, flagOn }
}

/** Register the agentistics MCP inside one root, through the harness's own `mcp add`. Best effort. */
async function defaultRegisterMcp(harness: HarnessId, root: string): Promise<void> {
  const port = process.env.AGENTISTICS_PORT ?? '47291'
  const reg = rootMcpRegistration(harness, root, agentisticsMcpLaunch(), `http://localhost:${port}`)
  if (!reg) return
  const proc = Bun.spawn(reg.argv, { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...reg.env } })
  await proc.exited
}

let instance: ReturnType<typeof createAccountRoots> | undefined
export function accountRoots(deps?: AccountRootsDeps): ReturnType<typeof createAccountRoots> {
  if (deps) return createAccountRoots(deps)
  return (instance ??= createAccountRoots({ spawn: defaultLoginSpawn, sessionLive: defaultSessionLive, sessionsOfAccount: defaultSessionsOfAccount }))
}

/** The login session goes through the control host, with the env decided HERE, never from a request body. */
async function defaultLoginSpawn(req: LoginSpawn) {
  const { hostForFleet } = await import('./sessions/fleet-web')
  const host = await hostForFleet('en')
  if (!host.spawnSession) return { ok: false, message: 'The session manager is not available.' }
  const out = await host.spawnSession({ harness: req.harness, cwd: req.cwd, label: req.label, attach: false, account: req.account })
  return { ok: out.ok, message: out.message, ...(out.id ? { id: out.id } : {}) }
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
