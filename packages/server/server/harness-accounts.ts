/** Non-secret identities only. Credential objects never cross the probe boundary. */
import { opencodePaths } from './opencode-paths'
import { createHash, randomBytes } from 'node:crypto'
import { readFile, mkdir, writeFile, rename, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import { AGENTISTICS_DATA_DIR } from './config'
import { withFileLock } from './sessions/file-lock'
import { ISOLATION_ENV } from './account-isolation'
import { runClaudeInLoginContext } from './account-login'

export interface HarnessAccount {
  id: string
  nickname?: string
  root: string | null
  retired?: boolean
  key: string
  harness: HarnessId
  label: string
  plan?: string
  /**
   * Never stored. Set on a row whose harness answered that it has NO login in that root (claude's
   * `auth status` says `loggedIn: false`), so the screen says "not connected" instead of drawing a
   * placeholder account that does not exist.
   */
  signedOut?: true
  available: boolean
  firstSeen: number
  lastSeen: number
}
export interface AccountsFile {
  version: 2
  accounts: HarnessAccount[]
  bindings: Record<string, string>
  segments: Record<string, number>
  /**
   * Ids merged into another because they were the SAME login (a probe whose key format changed, or a
   * pre-root-hash `default` record): old id -> survivor. Readers keyed by an account id (meters,
   * managed sessions, billing) resolve through it, so nothing recorded under the old id is orphaned.
   */
  aliases?: Record<string, string>
}
export type AccountIdentity = Pick<HarnessAccount, 'key' | 'label' | 'plan'>
const fallback = (): AccountIdentity => ({ key: 'default', label: 'Conta padrão' })
/** A probe that RAN and found no login, as opposed to one that failed or timed out. */
export class SignedOutError extends Error { constructor() { super('Not signed in') } }
/**
 * How long one claude identity probe may take. A cold `claude auth status` measured 1.1 s on a fast
 * Linux box; the first run of a freshly installed binary on macOS also pays Gatekeeper's scan, and
 * the old 2 s cap killed it every time, so a pending root never bound (CONTAS.LOGIN).
 */
export const CLAUDE_PROBE_TIMEOUT_MS = 15_000
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined

/**
 * Whitelist identity metadata; never inspect token VALUES or decode credentials. A ChatGPT login
 * writes its account id INSIDE `tokens` (`{auth_mode, tokens: {id_token, access_token,
 * refresh_token, account_id}, last_refresh}`, measured on codex 0.161) — reading only the top
 * level found nothing, every probe answered `default`, and the login was never bound. Only
 * `tokens.account_id` is read; the three token fields beside it are never touched.
 */
export function codexIdentity(raw: unknown): AccountIdentity {
  const doc = raw as { account_id?: unknown; auth_mode?: unknown; tokens?: unknown } | null
  const tokens = doc?.tokens && typeof doc.tokens === 'object' ? doc.tokens as { account_id?: unknown } : null
  const nested = text(tokens?.account_id)
  if (nested) return { key: nested, label: `ChatGPT ${nested.slice(0, 8)}` }
  const key = text(doc?.account_id) ?? (doc?.auth_mode === 'apikey' ? 'apikey' : undefined)
  return key ? { key, label: key } : fallback()
}

/** Parsing stays inside this boundary; only whitelisted strings leave it, never the document. */
async function readCodexIdentity(file: string): Promise<AccountIdentity> {
  return codexIdentity(JSON.parse(await readFile(file, 'utf8')))
}

/**
 * Antigravity keeps its login in `antigravity-oauth-token` (JSON, 0600) beside live OAuth tokens.
 * Only `id_token_email` and `auth_method` are read; the `token` object is never touched, kept or
 * logged, and a failure never echoes the file. `consumer` is a personal Google account, `gcp` Google Cloud.
 */
export function antigravityIdentity(raw: unknown): AccountIdentity {
  const doc = raw as { id_token_email?: unknown; auth_method?: unknown } | null
  const email = text(doc?.id_token_email)
  if (!email) return fallback()
  const method = doc?.auth_method === 'gcp' ? 'Google Cloud' : doc?.auth_method === 'consumer' ? 'Google' : undefined
  return { key: email, label: method ? `${email} · ${method}` : email }
}

async function readAntigravityIdentity(file: string): Promise<AccountIdentity> {
  return antigravityIdentity(JSON.parse(await readFile(file, 'utf8')))
}

async function readCopilotIdentity(file: string): Promise<AccountIdentity> {
  // Copilot writes full-line JSONC comments. Anchoring at line start preserves // inside strings.
  const raw = JSON.parse((await readFile(file, 'utf8')).replace(/^[\t ]*\/\/[^\r\n]*/gm, '')) as {
    lastLoggedInUser?: { login?: unknown; host?: unknown }
  }
  const login = text(raw.lastLoggedInUser?.login)
  const host = text(raw.lastLoggedInUser?.host) ?? process.env.GH_HOST ?? 'github.com'
  return login ? { key: `${host}:${login}`, label: login } : fallback()
}

export { ISOLATION_ENV }
const DEFAULT_ROOTS: Record<HarnessId, () => string> = {
  claude: () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
  codex: () => process.env.CODEX_HOME ?? join(homedir(), '.codex'),
  copilot: () => process.env.COPILOT_HOME ?? join(homedir(), '.copilot'),
  gemini: () => process.env.GEMINI_CLI_HOME ?? join(homedir(), '.gemini'),
  kimi: () => process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code'),
  antigravity: () => join(homedir(), '.gemini', 'antigravity-cli'),
  opencode: () => opencodePaths(process.env, homedir()).dir,
}
/** The login root a harness uses when no account root is set (its own env override, else its home dir). */
export const defaultHarnessRoot = (harness: HarnessId): string => DEFAULT_ROOTS[harness]()
/** PURE. Does `claude auth status --json` output say there is no login? Only `loggedIn` is read. */
export function claudeSignedOut(stdout: string): boolean {
  try { return (JSON.parse(stdout) as { loggedIn?: unknown } | null)?.loggedIn === false } catch { return false }
}
/**
 * The env `claude auth status` runs under for a root. The macOS keychain item is named after
 * sha256(CLAUDE_CONFIG_DIR) unless CLAUDE_SECURESTORAGE_CONFIG_DIR is set; the login runs without
 * it (`env -i`), so an inherited one would make the probe read a different item than the login wrote.
 */
export function claudeProbeEnv(root: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { CLAUDE_SECURESTORAGE_CONFIG_DIR: _, ...rest } = env
  return { ...rest, CLAUDE_CONFIG_DIR: root }
}
const CLAUDE_PROBE_CONCURRENCY = 3
let activeClaudeProbes = 0
const claudeProbeWaiters: Array<() => void> = []
async function withClaudeProbeSlot<T>(run: () => Promise<T>): Promise<T> {
  if (activeClaudeProbes >= CLAUDE_PROBE_CONCURRENCY) await new Promise<void>(resolve => claudeProbeWaiters.push(resolve))
  activeClaudeProbes++
  try { return await run() } finally {
    activeClaudeProbes--
    claudeProbeWaiters.shift()?.()
  }
}
export const IDENTITY_PROBES: Record<HarnessId, ((root: string | null) => Promise<AccountIdentity>) | null> = {
  claude: root => withClaudeProbeSlot(async () => {
    const result = await runClaudeInLoginContext(root, ['claude', 'auth', 'status', '--json'])
    const stdout = result.stdout
    const jsonStart = stdout.indexOf('{')
    const jsonEnd = stdout.lastIndexOf('}') + 1
    const payload = jsonStart >= 0 && jsonEnd > jsonStart ? stdout.slice(jsonStart, jsonEnd) : ''
    // Logged out, claude prints `{"loggedIn": false, …}` AND exits 1: read the answer first.
    if (claudeSignedOut(payload)) throw new SignedOutError()
    if (result.code !== 0) throw new Error('Account probe failed')
    if (!payload) throw new Error('Account probe returned no JSON')
    const raw = JSON.parse(payload) as { orgId?: unknown; email?: unknown; subscriptionType?: unknown; loggedIn?: unknown }
    if (raw.loggedIn === false) throw new SignedOutError()
    const email = text(raw.email)
    const org = text(raw.orgId)
    const key = org && email ? `${org}:${email}` : email ?? org
    const plan = text(raw.subscriptionType)
    return key ? { key, label: email ?? key, ...(plan ? { plan } : {}) } : fallback()
  }),
  codex: root => readCodexIdentity(join(root ?? DEFAULT_ROOTS.codex(), 'auth.json')),
  copilot: root => readCopilotIdentity(join(root ?? DEFAULT_ROOTS.copilot(), 'config.json')),
  gemini: null,
  kimi: null,
  antigravity: root => readAntigravityIdentity(join(root ?? DEFAULT_ROOTS.antigravity(), 'antigravity-oauth-token')),
  opencode: null,
}

export function hasIdentityProbe(harness: HarnessId): boolean {
  return IDENTITY_PROBES[harness] !== null
}

/** The directories object is retained for callers of the slice-1 probes. */
export async function probeAccountIdentity(harness: HarnessId, root: string | null | {
  codexHome?: string
  copilotHome?: string
} = null): Promise<AccountIdentity> {
  const directories: Partial<Record<HarnessId, string>> = typeof root === 'object' && root !== null
    ? { codex: root.codexHome, copilot: root.copilotHome } : {}
  const selectedRoot = ISOLATION_ENV[harness] === null ? null
    : typeof root === 'string' ? root : directories[harness] ?? null
  const probe = IDENTITY_PROBES[harness]
  if (probe) return probe(selectedRoot)
  const path = await realpath(selectedRoot ?? DEFAULT_ROOTS[harness]())
  return { key: `root:${createHash('sha256').update(path).digest('hex').slice(0, 12)}`, label: 'Default account' }
}

const bindingKey = (harness: HarnessId, root: string | null) => `${harness}:${root ?? ''}`
const mintId = () => `acc_${randomBytes(6).toString('hex')}`
const emptyFile = (): AccountsFile => ({ version: 2, accounts: [], bindings: {}, segments: {} })
/** One spelling per directory: absolute, no trailing slash. Applied at the store's boundary. */
const normRoot = (root: string | null | undefined): string | null => root == null ? null : resolve(root)
/** Two roots of one harness are the same folder: `null` IS the default root (a v1 record wrote the path out). */
const sameRoot = (harness: HarnessId, a: string | null | undefined, b: string | null | undefined): boolean =>
  resolve(a ?? DEFAULT_ROOTS[harness]()) === resolve(b ?? DEFAULT_ROOTS[harness]())
/**
 * Two records of one harness that are the SAME login. Keys used to be spelled differently: claude's
 * probe keyed by `orgId` (or the e-mail) alone before it keyed by `orgId:email`, and a harness with no
 * identity probe recorded `default` before the default root got its `root:<hash>` key. A changed
 * spelling minted a second account for one login, whose last meter then showed as a second plan.
 * Equal keys are NOT proof on their own: claude's legacy org-only key is shared by every member of a
 * team, so it also needs the same meaningful e-mail label, and the probe-less `default` key names no
 * login at all, so it also needs the same root. Claude's other spellings need the same e-mail too.
 */
export function sameLogin(
  a: Pick<HarnessAccount, 'harness' | 'key' | 'label' | 'root'>,
  b: Pick<HarnessAccount, 'harness' | 'key' | 'label' | 'root'>,
): boolean {
  if (a.harness !== b.harness) return false
  if (a.key === 'default' || b.key === 'default') {
    // The unknown identity: only the same directory can say it is the same login.
    if (a.key === b.key) return normRoot(a.root) === normRoot(b.root)
    // Antigravity's legacy default/root pair still names one unknown login after gaining a probe.
    if (a.harness === 'claude' || (a.harness !== 'antigravity' && IDENTITY_PROBES[a.harness] !== null)) return false
    const [legacy, rooted] = a.key === 'default' ? [a, b] : [b, a]
    return legacy.root === null && rooted.root === null && rooted.key.startsWith('root:')
  }
  if (a.harness === 'claude') {
    const email = (label: string) => { const l = label.trim().toLowerCase(); return l.includes('@') ? l : null }
    // A key carrying the e-mail (`org:email` or the e-mail alone) names the person by itself.
    if (a.key === b.key && a.key.includes('@')) return true
    const ea = email(a.label)
    if (!ea || ea !== email(b.label)) return false
    if (a.key === b.key) return true
    const parts = (k: string) => { const i = k.indexOf(':'); return i < 0 ? [k] : [k.slice(0, i), k.slice(i + 1)] }
    return parts(a.key).includes(b.key) || parts(b.key).includes(a.key)
  }
  return a.key === b.key
}

/**
 * The account a detected identity belongs to, or none. Equal keys are not identity on their own (see
 * `sameLogin`): the record this root is already bound to is kept when its key is unchanged and the
 * probe brings no conflicting person evidence (another e-mail) — the binding is the evidence for THIS
 * root, and claims nothing about another root holding the same key —
 * and otherwise only a same-login record matches (the same login under an older key spelling). With
 * no evidence the caller mints: a second row is acceptable, two people in one row is not.
 */
export function matchIdentity(
  data: AccountsFile, harness: HarnessId, root: string | null, detected: AccountIdentity,
): HarnessAccount | undefined {
  const probe = { harness, key: detected.key, label: detected.label, root }
  const bound = data.accounts.find(a => a.id === data.bindings[bindingKey(harness, root)])
  if (bound && bound.harness === harness
    && (sameLogin(bound, probe) || (bound.key === detected.key && !conflictingPerson(bound, probe)))) return bound
  return data.accounts.find(a => sameLogin(a, probe))
}

/**
 * Per-person evidence that two records name DIFFERENT people: two distinct claude e-mails. An equal
 * org-only key says nothing about the person, so a probe naming another e-mail is another login even
 * on a root already bound — rebinding it, never relabelling the old account into the new person.
 */
function conflictingPerson(
  a: Pick<HarnessAccount, 'harness' | 'label'>, b: Pick<HarnessAccount, 'harness' | 'label'>,
): boolean {
  if (a.harness !== 'claude' || b.harness !== 'claude') return false
  const email = (label: string) => { const l = label.trim().toLowerCase(); return l.includes('@') ? l : null }
  const ea = email(a.label), eb = email(b.label)
  return !!ea && !!eb && ea !== eb
}

/** An id as the registry knows it now: an alias resolves to the account it was merged into. */
export function canonicalAccountId(data: Pick<AccountsFile, 'aliases'>, id: string): string {
  let at = id
  for (let i = 0; i < 8 && data.aliases?.[at]; i++) at = data.aliases[at]!
  return at
}

/**
 * Fold every same-login pair into one record (spec: one row per account). The survivor is the one a
 * binding points at, else the one seen last; it keeps its id and key, takes the oldest `firstSeen`,
 * a nickname/plan it lacks, and stays visible to agents only if both were. Returns whether it changed.
 */
export function mergeDuplicateAccounts(data: AccountsFile): boolean {
  const bound = new Set(Object.values(data.bindings))
  let changed = false
  for (let i = 0; i < data.accounts.length; i++) {
    for (let j = i + 1; j < data.accounts.length; j++) {
      const a = data.accounts[i]!, b = data.accounts[j]!
      if (!sameLogin(a, b)) continue
      const aWins = bound.has(a.id) !== bound.has(b.id) ? bound.has(a.id)
        : a.lastSeen !== b.lastSeen ? a.lastSeen > b.lastSeen : a.key.length >= b.key.length
      const [keep, drop] = aWins ? [a, b] : [b, a]
      foldAccount(data, keep, drop)
      changed = true
      i = -1
      break
    }
  }
  return changed
}

/** `drop` becomes an alias of `keep`: bindings, segments and older aliases follow the survivor. */
function foldAccount(data: AccountsFile, keep: HarnessAccount, drop: HarnessAccount): void {
  keep.firstSeen = Math.min(keep.firstSeen, drop.firstSeen)
  keep.lastSeen = Math.max(keep.lastSeen, drop.lastSeen)
  if (!keep.nickname && drop.nickname) keep.nickname = drop.nickname
  if (!keep.plan && drop.plan) keep.plan = drop.plan
  keep.available = keep.available && drop.available
  if (keep.retired && !drop.retired) keep.retired = undefined
  for (const [k, v] of Object.entries(data.bindings)) if (v === drop.id) data.bindings[k] = keep.id
  if (drop.id in data.segments) {
    data.segments[keep.id] = Math.max(data.segments[keep.id] ?? 0, data.segments[drop.id]!)
    delete data.segments[drop.id]
  }
  data.aliases = { ...(data.aliases ?? {}), [drop.id]: keep.id }
  for (const [k, v] of Object.entries(data.aliases)) if (v === drop.id) data.aliases[k] = keep.id
  data.accounts.splice(data.accounts.indexOf(drop), 1)
}

/**
 * A `default` record of a harness WITH an identity probe is the login on a root that could not be
 * identified yet (a v1 list, or a probe that read nothing). Antigravity also treats `root:<hash>` as
 * a placeholder because it minted those keys while it had no probe. Other harnesses keep those
 * records separate. The first CONFIRMED identity bound to
 * that same root is that login, so the placeholder folds into it — exactly one placeholder, never
 * one another root is bound to. Without this the placeholder outlives the fix that identifies the
 * login and shows as a second, never-read plan beside the real one.
 */
function foldPlaceholder(data: AccountsFile, account: HarnessAccount, displaced?: HarnessAccount): boolean {
  if (account.key === 'default' || IDENTITY_PROBES[account.harness] === null) return false
  const bound = new Set(Object.values(data.bindings))
  // `displaced` was bound to this root a moment ago; `adopt` has already cleared its root.
  const placeholders = data.accounts.filter(a => a !== account && a.harness === account.harness
    && (a.key === 'default' || (a.harness === 'antigravity' && a.key.startsWith('root:')))
    && !bound.has(a.id) && (a === displaced || sameRoot(account.harness, a.root, account.root)))
  if (placeholders.length !== 1) return false
  // The identified login takes the placeholder's id: Billing profiles, session rows and nicknames the
  // owner already keyed by it keep resolving with no alias lookup; the fresh id becomes the alias.
  const placeholder = placeholders[0]!
  const freshId = account.id
  account.id = placeholder.id
  placeholder.id = freshId
  foldAccount(data, account, placeholder)
  return true
}

/** Display names only: no control characters or newlines, at most 40 characters. */
export function sanitizeNickname(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim().slice(0, 40).trim()
}
class LockContended extends Error { constructor() { super('Account registry lock unavailable') } }
const isAccount = (a: unknown): a is HarnessAccount => {
  const x = a as Partial<HarnessAccount> | null
  return !!x && typeof x === 'object' && typeof x.id === 'string' && HARNESS_ORDER.includes(x.harness as HarnessId)
    && !!text(x.key) && !!text(x.label)
}
const plainRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}

/** A store owns its cache and serializes registry read/modify/write operations. */
export function createHarnessAccounts(options: {
  file: string
  probe?: (harness: HarnessId, root: string | null) => Promise<AccountIdentity>
  now?: () => number
  timeoutMs?: number
  /** Test seam: how a backup file is written (exclusive create). Default writes the file. */
  writeBackup?: (path: string, raw: string) => Promise<void>
}) {
  const probe = options.probe ?? probeAccountIdentity
  const now = options.now ?? Date.now
  type Detection = { identity: AccountIdentity; confirmed: boolean; signedOut?: true }
  const unknown = (): Detection => ({ identity: fallback(), confirmed: false })
  const cache = new Map<string, { at: number; identity: Promise<Detection> }>()
  let queue: Promise<unknown> = Promise.resolve()
  /** Writers only: a read/modify/write without the cross-process lock is refused. */
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(() => withFileLock(options.file, async ({ contended }) => {
      if (contended) throw new LockContended()
      return work()
    }))
    queue = result.catch(() => {})
    return result
  }
  async function identity(harness: HarnessId, root: string | null, force = false): Promise<Detection> {
    const key = bindingKey(harness, root)
    const held = cache.get(key)
    if (!force && held && now() - held.at < 60_000) return held.identity
    const pending = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined, timedOut = false
      const probing: Promise<Detection> = Promise.resolve().then(() => probe(harness, root)).then(identity => ({
        identity,
        confirmed: identity.key !== 'default' || !hasIdentityProbe(harness),
      }))
      // A probe that outlives the race still answers: its result replaces the "unknown" the race
      // cached, so a cold CLI (first run on macOS) names the account on the next read, not a minute later.
      void probing.then(d => { if (timedOut) cache.set(key, { at: now(), identity: Promise.resolve(d) }) },
        e => { if (timedOut && e instanceof SignedOutError) cache.set(key, { at: now(), identity: Promise.resolve({ ...unknown(), signedOut: true as const }) }) })
      try {
        return await Promise.race([
          probing,
          // A forced probe (a pending login root) must wait for a cold CLI; the list keeps its 2 s.
          new Promise<Detection>(resolve => { timer = setTimeout(() => { timedOut = true; resolve(unknown()) }, options.timeoutMs ?? (force ? CLAUDE_PROBE_TIMEOUT_MS : 2000)) }),
        ])
      } catch (error) { return error instanceof SignedOutError ? { ...unknown(), signedOut: true as const } : unknown() }
      finally { if (timer) clearTimeout(timer) }
    })()
    cache.set(key, { at: now(), identity: pending })
    return pending
  }
  async function write(data: AccountsFile): Promise<void> {
    await mkdir(dirname(options.file), { recursive: true })
    const tmp = `${options.file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(tmp, JSON.stringify(data), { mode: 0o600 })
    await rename(tmp, options.file)
  }
  const writeBackup = options.writeBackup ?? ((path: string, raw: string) => writeFile(path, raw, { mode: 0o600, flag: 'wx' }))
  const backedUp = new Set<string>()
  async function backup(raw: string): Promise<void> {
    if (backedUp.has(raw)) return
    let last: unknown
    for (const suffix of ['', `.${randomBytes(3).toString('hex')}`, `.${randomBytes(3).toString('hex')}`]) {
      try {
        await writeBackup(`${options.file}.bak.${now()}${suffix}`, raw)
        backedUp.add(raw)
        return
      } catch (error) {
        // Only a name collision is retried; anything else (ENOSPC, EACCES...) must stop the caller
        // before the original file is replaced.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        last = error
      }
    }
    throw last
  }
  /**
   * Parse the registry. `dirty` means the on-disk bytes need rewriting (v1 migration, unreadable or
   * unknown-version content). With `persist` (under the lock) that rewrite happens, after a backup
   * of anything that is not a v1 list; without it nothing is touched, so readers never need the lock.
   */
  async function load(persist: boolean): Promise<{ data: AccountsFile; dirty: boolean; minted?: boolean }> {
    let text_: string
    try { text_ = await readFile(options.file, 'utf8') } catch { return { data: emptyFile(), dirty: false } }
    let raw: unknown
    try { raw = JSON.parse(text_) } catch {
      if (persist) await backup(text_)
      return { data: emptyFile(), dirty: false }
    }
    if (Array.isArray(raw)) {
      const data = emptyFile()
      for (const a of raw) {
        if (!a || !HARNESS_ORDER.includes(a.harness) || !text(a.key) || !text(a.label)) continue
        const firstSeen = typeof a.firstSeen === 'number' ? a.firstSeen : now()
        const lastSeen = typeof a.lastSeen === 'number' ? a.lastSeen : now()
        // Two entries are one account only on per-person evidence (`sameLogin`): an equal org-only
        // key is shared by a whole team, so it never merges two people on its own.
        const same = data.accounts.find(x => sameLogin(x, { harness: a.harness, key: a.key, label: a.label, root: null }))
        let account: HarnessAccount
        if (same) {
          // Duplicate (harness,key) entries are one account: keep the oldest start, newest sighting.
          account = same
          account.firstSeen = Math.min(same.firstSeen, firstSeen)
          account.available = same.available && a.available !== false
          if (lastSeen >= same.lastSeen) {
            account.label = a.label
            if (text(a.plan)) account.plan = a.plan
          }
          account.lastSeen = Math.max(same.lastSeen, lastSeen)
        } else {
          account = {
            id: mintId(), root: null, key: a.key, harness: a.harness, label: a.label,
            ...(text(a.plan) ? { plan: a.plan } : {}), available: a.available !== false, firstSeen, lastSeen,
          }
          data.accounts.push(account)
        }
        const key = bindingKey(account.harness, null)
        const previous = data.accounts.find(x => x.id === data.bindings[key])
        if (account.key !== 'default' && (!previous || account.lastSeen >= previous.lastSeen)) data.bindings[key] = account.id
      }
      mergeDuplicateAccounts(data)
      if (persist) await write(data)
      return { data, dirty: !persist, minted: true }
    }
    const doc = raw as { version?: unknown; accounts?: unknown; bindings?: unknown; segments?: unknown; aliases?: unknown } | null
    if (!doc || typeof doc !== 'object' || doc.version !== 2) {
      if (persist) await backup(text_)
      return { data: emptyFile(), dirty: !persist }
    }
    const accounts = (Array.isArray(doc.accounts) ? doc.accounts : []).filter(isAccount)
    const ids = new Set(accounts.map(a => a.id))
    const bindings: Record<string, string> = {}
    for (const [k, v] of Object.entries(plainRecord(doc.bindings))) if (typeof v === 'string' && ids.has(v)) bindings[k] = v
    const segments: Record<string, number> = {}
    for (const [k, v] of Object.entries(plainRecord(doc.segments))) if (typeof v === 'number' && Number.isFinite(v)) segments[k] = v
    const aliases: Record<string, string> = {}
    for (const [k, v] of Object.entries(plainRecord(doc.aliases))) if (typeof v === 'string' && k !== v) aliases[k] = v
    const data: AccountsFile = { version: 2, accounts, bindings, segments, ...(Object.keys(aliases).length ? { aliases } : {}) }
    // A registry holding one login twice (see `sameLogin`) is folded on read; a writer persists it.
    if (!mergeDuplicateAccounts(data)) return { data, dirty: false }
    if (persist) await write(data)
    return { data, dirty: !persist }
  }
  /** Called only under the file lock: migration mints and persists ids exactly once. */
  const read = async (): Promise<AccountsFile> => (await load(true)).data
  /** Lock-free read. Writers publish by atomic rename, so a reader sees a whole file. */
  async function snapshot(): Promise<AccountsFile> {
    const first = await load(false)
    if (!first.dirty) return first.data
    try { return await serial(read) } catch (error) {
      // Never expose ids minted from an unpersisted v1 list: they would differ from the real ones.
      // A folded v2 registry is deterministic: the unpersisted fold is safe to show.
      if (error instanceof LockContended) return first.minted ? emptyFile() : first.data
      throw error
    }
  }
  function adopt(data: AccountsFile, harness: HarnessId, root: string | null, detected: AccountIdentity) {
    const key = bindingKey(harness, root)
    const previous = data.accounts.find(a => a.id === data.bindings[key])
    let account = matchIdentity(data, harness, root, detected)
    if (account) account.key = detected.key
    if (!account) {
      account = { key: detected.key, label: detected.label, ...(detected.plan ? { plan: detected.plan } : {}),
        id: mintId(), harness, root, available: true, firstSeen: now(), lastSeen: now() }
      data.accounts.push(account)
    }
    if (previous && previous.id !== account.id && previous.root === root) previous.root = null
    account.root = root
    // An e-mail label is the evidence `sameLogin` needs later; a probe that named only the org keeps it.
    if (!(harness === 'claude' && account.label.includes('@') && !detected.label.includes('@'))) account.label = detected.label
    if (detected.plan) account.plan = detected.plan
    account.lastSeen = now()
    account.retired = undefined
    data.bindings[key] = account.id
    const folded = previous && previous.id !== account.id && foldPlaceholder(data, account, previous)
    if (!folded) foldPlaceholder(data, account)
    return { account, ...(previous && previous.id !== account.id && !folded ? { previous } : {}) }
  }
  function current(harness: HarnessId, root?: string | null): Promise<HarnessAccount>
  function current(harnesses: readonly HarnessId[]): Promise<HarnessAccount[]>
  async function current(harnesses: HarnessId | readonly HarnessId[], rootArg: string | null = null): Promise<HarnessAccount | HarnessAccount[]> {
    const root = normRoot(rootArg)
    const legacy = typeof harnesses !== 'string'
    const requested = legacy ? [...new Set(harnesses)] : [harnesses]
    const detected = await Promise.all(requested.map(async harness => ({ harness, ...await identity(harness, root) })))
    const resolveAll = (data: AccountsFile, mutate: boolean) => {
      let changed = false
      const accounts = detected.map(({ harness, identity: found, confirmed, signedOut }) => {
        const bound = data.accounts.find(a => a.id === data.bindings[bindingKey(harness, root)])
        const out = signedOut ? { signedOut } : {}
        if (!confirmed) {
          // Legacy callers use default as the unknown identity, retaining its availability.
          if (bound) return legacy ? { ...bound, ...fallback(), plan: undefined, ...out } : { ...bound, ...out }
          return { ...fallback(), id: '', harness, root, available: true, firstSeen: now(), lastSeen: now(), ...out }
        }
        if (!mutate) return matchIdentity(data, harness, root, found) ?? bound
          ?? { ...fallback(), id: '', harness, root, available: true, firstSeen: now(), lastSeen: now() }
        changed = true
        return adopt(data, harness, root, found).account
      })
      return { accounts, changed }
    }
    const done = (accounts: HarnessAccount[]) => legacy ? accounts : accounts[0]!
    const seen = await snapshot()
    if (!detected.some(d => d.confirmed)) return done(resolveAll(seen, false).accounts)
    try {
      return done(await serial(async () => {
        const data = await read()
        const { accounts, changed } = resolveAll(data, true)
        if (changed) await write(data)
        return accounts
      }))
    } catch (error) {
      // Contention refuses the WRITE only; the caller still gets the last-known answer.
      if (error instanceof LockContended) return done(resolveAll(seen, false).accounts)
      throw error
    }
  }
  async function update(id: string, patch: { available?: boolean; nickname?: string }): Promise<HarnessAccount | null> {
    return serial(async () => {
      const data = await read()
      const at = canonicalAccountId(data, id)
      const account = data.accounts.find(a => a.id === at)
      if (!account) return null
      if (patch.available !== undefined) account.available = patch.available
      if (patch.nickname !== undefined) {
        const nickname = sanitizeNickname(patch.nickname)
        if (nickname) account.nickname = nickname
        else delete account.nickname
      }
      await write(data)
      return account
    })
  }
  return {
    current,
    readAccounts: () => snapshot(),
    byId: async (id: string) => { const data = await snapshot(); const at = canonicalAccountId(data, id); return data.accounts.find(a => a.id === at) ?? null },
    async bind(root: string | null, detected: AccountIdentity & { harness: HarnessId }) {
      return serial(async () => {
        const data = await read()
        const result = adopt(data, detected.harness, normRoot(root), detected)
        await write(data)
        return result
      })
    },
    async forceProbe(harness: HarnessId, root: string | null = null): Promise<AccountIdentity> {
      return (await identity(harness, normRoot(root), true)).identity
    },
    async startSegment(id: string, ms: number): Promise<void> {
      return serial(async () => {
        const data = await read()
        const at = canonicalAccountId(data, id)
        if (!data.accounts.some(a => a.id === at)) return
        data.segments[at] = Math.max(data.segments[at] ?? 0, ms)
        await write(data)
      })
    },
    update,
    /** Retire: invisible to agents, history and billing kept. Re-binding the same login un-retires it. */
    async retire(id: string): Promise<HarnessAccount | null> {
      return serial(async () => {
        const data = await read()
        const at = canonicalAccountId(data, id)
        const account = data.accounts.find(a => a.id === at)
        if (!account) return null
        account.retired = true
        account.available = false
        await write(data)
        return account
      })
    },
    setNickname: (id: string, nickname: string) => update(id, { nickname }),
    async list(harnesses: readonly HarnessId[] = HARNESS_ORDER): Promise<HarnessAccount[]> {
      const currentAccounts = await current(harnesses)
      const accounts = (await snapshot()).accounts
      // Preserve slice-1's unknown rows ONLY before any identity of that harness was recorded: an
      // id-less row beside a recorded account is the same login a second time (an id nobody can
      // PATCH, shown as another account with no meter).
      return [...accounts, ...currentAccounts.filter(a => !a.id && !accounts.some(x => x.harness === a.harness))]
    },
    async setAvailable(harness: HarnessId, key: string, available: boolean): Promise<HarnessAccount | null> {
      return serial(async () => {
        const data = await read()
        const account = data.accounts.find(a => a.harness === harness && a.key === key)
        if (!account) return null
        account.available = available
        await write(data)
        return account
      })
    },
  }
}

let store = createHarnessAccounts({ file: join(AGENTISTICS_DATA_DIR, 'accounts.json') })
export const readAccounts = () => store.readAccounts()
export const current = (harness: HarnessId, root?: string | null) => store.current(harness, root)
export const byId = (id: string) => store.byId(id)
export const bind = (root: string | null, identity: AccountIdentity & { harness: HarnessId }) => store.bind(root, identity)
export const setNickname = (id: string, nickname: string) => store.setNickname(id, nickname)
export const startSegment = (id: string, ms: number) => store.startSegment(id, ms)
export const forceProbe = (harness: HarnessId, root: string | null = null) => store.forceProbe(harness, root)
export const currentHarnessAccounts = (harnesses: readonly HarnessId[]) => store.current(harnesses)
export const listHarnessAccounts = (harnesses?: readonly HarnessId[]) => store.list(harnesses)
export const setAccountAvailable = (harness: HarnessId, key: string, available: boolean) => store.setAvailable(harness, key, available)
export const retireAccount = (id: string) => store.retire(id)
export const updateAccount = (id: string, patch: { available?: boolean; nickname?: string }) => store.update(id, patch)

/** Tests install an isolated registry and probes; never read the owner's login. */
export function __setHarnessAccountsForTest(next: ReturnType<typeof createHarnessAccounts>): void { store = next }
