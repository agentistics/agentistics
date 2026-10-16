/** Non-secret identities only. Credential objects never cross the probe boundary. */
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile, mkdir, writeFile, rename, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import { AGENTISTICS_DATA_DIR } from './config'
import { withFileLock } from './sessions/file-lock'

export interface HarnessAccount {
  id: string
  nickname?: string
  root: string | null
  retired?: boolean
  key: string
  harness: HarnessId
  label: string
  plan?: string
  available: boolean
  firstSeen: number
  lastSeen: number
}
export interface AccountsFile {
  version: 2
  accounts: HarnessAccount[]
  bindings: Record<string, string>
  segments: Record<string, number>
}
export type AccountIdentity = Pick<HarnessAccount, 'key' | 'label' | 'plan'>
const fallback = (): AccountIdentity => ({ key: 'default', label: 'Conta padrão' })
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined

/** Whitelist identity metadata; never inspect token fields or decode credentials. */
export function codexIdentity(raw: unknown): AccountIdentity {
  const key = text((raw as { account_id?: unknown } | null)?.account_id)
    ?? ((raw as { auth_mode?: unknown } | null)?.auth_mode === 'apikey' ? 'apikey' : undefined)
  return key ? { key, label: key } : fallback()
}

/** Parsing stays inside this boundary; only whitelisted strings leave it, never the document. */
async function readCodexIdentity(file: string): Promise<AccountIdentity> {
  return codexIdentity(JSON.parse(await readFile(file, 'utf8')))
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

export const ISOLATION_ENV: Record<HarnessId, string | null> = {
  claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME', copilot: 'COPILOT_HOME',
  gemini: 'GEMINI_CLI_HOME', kimi: 'KIMI_CODE_HOME', antigravity: null,
  opencode: null,
}
const DEFAULT_ROOTS: Record<HarnessId, () => string> = {
  claude: () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
  codex: () => process.env.CODEX_HOME ?? join(homedir(), '.codex'),
  copilot: () => process.env.COPILOT_HOME ?? join(homedir(), '.copilot'),
  gemini: () => process.env.GEMINI_CLI_HOME ?? join(homedir(), '.gemini'),
  kimi: () => process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code'),
  antigravity: () => join(homedir(), '.gemini', 'antigravity-cli'),
  opencode: () => process.env.OPENCODE_DIR ?? join(homedir(), '.local', 'share', 'opencode'),
}
export const IDENTITY_PROBES: Record<HarnessId, ((root: string | null) => Promise<AccountIdentity>) | null> = {
  claude: async root => {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile('claude', ['auth', 'status', '--json'], {
        timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
        ...(root === null ? {} : { env: { ...process.env, CLAUDE_CONFIG_DIR: root } }),
      }, (error, stdout) => {
        if (error) reject(new Error('Account probe failed'))
        else resolve(stdout)
      })
    })
    const raw = JSON.parse(stdout) as { orgId?: unknown; email?: unknown; subscriptionType?: unknown }
    const email = text(raw.email)
    const org = text(raw.orgId)
    const key = org && email ? `${org}:${email}` : email ?? org
    const plan = text(raw.subscriptionType)
    return key ? { key, label: email ?? key, ...(plan ? { plan } : {}) } : fallback()
  },
  codex: root => readCodexIdentity(join(root ?? DEFAULT_ROOTS.codex(), 'auth.json')),
  copilot: root => readCopilotIdentity(join(root ?? DEFAULT_ROOTS.copilot(), 'config.json')),
  gemini: null,
  kimi: null,
  antigravity: null,
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
  type Detection = { identity: AccountIdentity; confirmed: boolean }
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
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          Promise.resolve().then(() => probe(harness, root)).then(identity => ({
            identity,
            confirmed: identity.key !== 'default' || !hasIdentityProbe(harness),
          })),
          new Promise<Detection>(resolve => { timer = setTimeout(() => resolve(unknown()), options.timeoutMs ?? 2000) }),
        ])
      } catch { return unknown() }
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
  async function load(persist: boolean): Promise<{ data: AccountsFile; dirty: boolean }> {
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
        const same = data.accounts.find(x => x.harness === a.harness && x.key === a.key)
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
      if (persist) await write(data)
      return { data, dirty: !persist }
    }
    const doc = raw as { version?: unknown; accounts?: unknown; bindings?: unknown; segments?: unknown } | null
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
    return { data: { version: 2, accounts, bindings, segments }, dirty: false }
  }
  /** Called only under the file lock: migration mints and persists ids exactly once. */
  const read = async (): Promise<AccountsFile> => (await load(true)).data
  /** Lock-free read. Writers publish by atomic rename, so a reader sees a whole file. */
  async function snapshot(): Promise<AccountsFile> {
    const first = await load(false)
    if (!first.dirty) return first.data
    try { return await serial(read) } catch (error) {
      // Never expose ids minted from an unpersisted v1 list: they would differ from the real ones.
      if (error instanceof LockContended) return emptyFile()
      throw error
    }
  }
  function adopt(data: AccountsFile, harness: HarnessId, root: string | null, detected: AccountIdentity) {
    const key = bindingKey(harness, root)
    const previous = data.accounts.find(a => a.id === data.bindings[key])
    let account = data.accounts.find(a => a.harness === harness && a.key === detected.key)
    if (!account) {
      account = { key: detected.key, label: detected.label, ...(detected.plan ? { plan: detected.plan } : {}),
        id: mintId(), harness, root, available: true, firstSeen: now(), lastSeen: now() }
      data.accounts.push(account)
    }
    if (previous && previous.id !== account.id && previous.root === root) previous.root = null
    account.root = root
    account.label = detected.label
    if (detected.plan) account.plan = detected.plan
    account.lastSeen = now()
    account.retired = undefined
    data.bindings[key] = account.id
    return { account, ...(previous && previous.id !== account.id ? { previous } : {}) }
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
      const accounts = detected.map(({ harness, identity: found, confirmed }) => {
        const bound = data.accounts.find(a => a.id === data.bindings[bindingKey(harness, root)])
        if (!confirmed) {
          // Legacy callers use default as the unknown identity, retaining its availability.
          if (bound) return legacy ? { ...bound, ...fallback(), plan: undefined } : bound
          return { ...fallback(), id: '', harness, root, available: true, firstSeen: now(), lastSeen: now() }
        }
        if (!mutate) return data.accounts.find(a => a.harness === harness && a.key === found.key) ?? bound
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
      const account = data.accounts.find(a => a.id === id)
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
    byId: async (id: string) => (await snapshot()).accounts.find(a => a.id === id) ?? null,
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
        if (!data.accounts.some(a => a.id === id)) return
        data.segments[id] = ms
        await write(data)
      })
    },
    update,
    /** Retire: invisible to agents, history and billing kept. Re-binding the same login un-retires it. */
    async retire(id: string): Promise<HarnessAccount | null> {
      return serial(async () => {
        const data = await read()
        const account = data.accounts.find(a => a.id === id)
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
      // Preserve slice-1's unknown rows before any identity has been confirmed.
      return [...accounts, ...currentAccounts.filter(a => !a.id)]
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
