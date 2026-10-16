/** Non-secret identities only. Credential objects never cross the probe boundary. */
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile, mkdir, writeFile, rename, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
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

/** A store owns its cache and serializes registry read/modify/write operations. */
export function createHarnessAccounts(options: {
  file: string
  probe?: (harness: HarnessId, root: string | null) => Promise<AccountIdentity>
  now?: () => number
  timeoutMs?: number
}) {
  const probe = options.probe ?? probeAccountIdentity
  const now = options.now ?? Date.now
  type Detection = { identity: AccountIdentity; confirmed: boolean }
  const unknown = (): Detection => ({ identity: fallback(), confirmed: false })
  const cache = new Map<string, { at: number; identity: Promise<Detection> }>()
  let queue: Promise<unknown> = Promise.resolve()
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(() => withFileLock(options.file, async ({ contended }) => {
      // Never perform a read/modify/write without the cross-process lock.
      if (contended) throw new Error('Account registry lock unavailable')
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
  /** Called only under the file lock: migration mints and persists ids exactly once. */
  async function read(): Promise<AccountsFile> {
    let raw: unknown
    try { raw = JSON.parse(await readFile(options.file, 'utf8')) } catch { return emptyFile() }
    if (!Array.isArray(raw)) {
      const data = raw as AccountsFile | null
      return data?.version === 2 && Array.isArray(data.accounts) && data.bindings && data.segments ? data : emptyFile()
    }
    const data = emptyFile()
    for (const a of raw) {
      if (!a || !HARNESS_ORDER.includes(a.harness) || !text(a.key) || !text(a.label)) continue
      const account: HarnessAccount = {
        id: mintId(), root: null, key: a.key, harness: a.harness, label: a.label,
        ...(text(a.plan) ? { plan: a.plan } : {}), available: a.available !== false,
        firstSeen: typeof a.firstSeen === 'number' ? a.firstSeen : now(),
        lastSeen: typeof a.lastSeen === 'number' ? a.lastSeen : now(),
      }
      data.accounts.push(account)
      const key = bindingKey(account.harness, null)
      const previous = data.accounts.find(a => a.id === data.bindings[key])
      if (account.key !== 'default' && (!previous || account.lastSeen >= previous.lastSeen)) data.bindings[key] = account.id
    }
    await write(data)
    return data
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
  async function current(harnesses: HarnessId | readonly HarnessId[], root: string | null = null): Promise<HarnessAccount | HarnessAccount[]> {
    const legacy = typeof harnesses !== 'string'
    const requested = legacy ? [...new Set(harnesses)] : [harnesses]
    const detected = await Promise.all(requested.map(async harness => ({ harness, ...await identity(harness, root) })))
    return serial(async () => {
      const data = await read()
      let changed = false
      const accounts = detected.map(({ harness, identity: detected, confirmed }) => {
        if (!confirmed) {
          const lastKnown = data.accounts.find(a => a.id === data.bindings[bindingKey(harness, root)])
          // Legacy callers use default as the unknown identity, retaining its availability.
          if (lastKnown) return legacy ? { ...lastKnown, ...fallback(), plan: undefined } : lastKnown
          return { ...fallback(), id: '', harness, root, available: true, firstSeen: now(), lastSeen: now() }
        }
        changed = true
        return adopt(data, harness, root, detected).account
      })
      if (changed) await write(data)
      return legacy ? accounts : accounts[0]!
    })
  }
  async function update(id: string, patch: { available?: boolean; nickname?: string }): Promise<HarnessAccount | null> {
    return serial(async () => {
      const data = await read()
      const account = data.accounts.find(a => a.id === id)
      if (!account) return null
      if (patch.available !== undefined) account.available = patch.available
      if (patch.nickname !== undefined) account.nickname = patch.nickname
      await write(data)
      return account
    })
  }
  return {
    current,
    readAccounts: () => serial(read),
    byId: (id: string) => serial(async () => (await read()).accounts.find(a => a.id === id) ?? null),
    async bind(root: string | null, detected: AccountIdentity & { harness: HarnessId }) {
      return serial(async () => {
        const data = await read()
        const result = adopt(data, detected.harness, root, detected)
        await write(data)
        return result
      })
    },
    async forceProbe(harness: HarnessId, root: string | null = null): Promise<AccountIdentity> {
      return (await identity(harness, root, true)).identity
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
    setNickname: (id: string, nickname: string) => update(id, { nickname }),
    async list(harnesses: readonly HarnessId[] = HARNESS_ORDER): Promise<HarnessAccount[]> {
      const currentAccounts = await current(harnesses)
      return serial(async () => {
        const accounts = (await read()).accounts
        // Preserve slice-1's unknown rows before any identity has been confirmed.
        return [...accounts, ...currentAccounts.filter(a => !a.id)]
      })
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
export const updateAccount = (id: string, patch: { available?: boolean; nickname?: string }) => store.update(id, patch)

/** Tests install an isolated registry and probes; never read the owner's login. */
export function __setHarnessAccountsForTest(next: ReturnType<typeof createHarnessAccounts>): void { store = next }
