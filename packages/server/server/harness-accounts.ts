/** Non-secret identities only. Credential objects never cross the probe boundary. */
import { execFile } from 'node:child_process'
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import { AGENTISTICS_DATA_DIR } from './config'

export interface HarnessAccount {
  key: string
  harness: HarnessId
  label: string
  plan?: string
  available: boolean
  firstSeen: number
  lastSeen: number
}
export type AccountIdentity = Pick<HarnessAccount, 'key' | 'label' | 'plan'>
const fallback = (): AccountIdentity => ({ key: 'default', label: 'Conta padrão' })
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined

/** Whitelist exactly one top-level field; never inspect token fields or decode credentials. */
export function codexIdentity(raw: unknown): AccountIdentity {
  const key = text((raw as { account_id?: unknown } | null)?.account_id)
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

/** The harnesses `probeAccountIdentity` can read a login from; keep in step with its branches. */
export function hasIdentityProbe(harness: HarnessId): boolean {
  return harness === 'claude' || harness === 'codex' || harness === 'copilot'
}

export async function probeAccountIdentity(harness: HarnessId, directories: {
  codexHome?: string
  copilotHome?: string
} = {}): Promise<AccountIdentity> {
  if (harness === 'claude') {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile('claude', ['auth', 'status', '--json'], { timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 }, (error, stdout) => {
        if (error) reject(new Error('Account probe failed'))
        else resolve(stdout)
      })
    })
    const raw = JSON.parse(stdout) as { orgId?: unknown; email?: unknown; subscriptionType?: unknown }
    const email = text(raw.email)
    const key = text(raw.orgId) ?? email
    const plan = text(raw.subscriptionType)
    return key ? { key, label: email ?? key, ...(plan ? { plan } : {}) } : fallback()
  }
  if (harness === 'codex') {
    return readCodexIdentity(join(directories.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'))
  }
  if (harness === 'copilot') {
    return readCopilotIdentity(join(directories.copilotHome ?? process.env.COPILOT_HOME ?? join(homedir(), '.copilot'), 'config.json'))
  }
  return fallback()
}

/** A store owns its cache and serializes registry read/modify/write operations. */
export function createHarnessAccounts(options: {
  file: string
  probe?: (harness: HarnessId) => Promise<AccountIdentity>
  now?: () => number
  timeoutMs?: number
}) {
  const probe = options.probe ?? probeAccountIdentity
  const now = options.now ?? Date.now
  type Detection = { identity: AccountIdentity; confirmed: boolean }
  const unknown = (): Detection => ({ identity: fallback(), confirmed: false })
  const cache = new Map<HarnessId, { at: number; identity: Promise<Detection> }>()
  let queue: Promise<unknown> = Promise.resolve()
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work)
    queue = result.catch(() => {})
    return result
  }
  async function identity(harness: HarnessId): Promise<Detection> {
    const held = cache.get(harness)
    if (held && now() - held.at < 60_000) return held.identity
    const pending = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          Promise.resolve().then(() => probe(harness)).then(identity => ({
            identity,
            // Identity-capable harnesses with no identity fields are unknown, not a new login.
            confirmed: identity.key !== 'default' || !hasIdentityProbe(harness),
          })),
          new Promise<Detection>(resolve => { timer = setTimeout(() => resolve(unknown()), options.timeoutMs ?? 2000) }),
        ])
      } catch { return unknown() }
      finally { if (timer) clearTimeout(timer) }
    })()
    cache.set(harness, { at: now(), identity: pending })
    return pending
  }
  async function read(): Promise<HarnessAccount[]> {
    try {
      const raw: unknown = JSON.parse(await readFile(options.file, 'utf8'))
      if (!Array.isArray(raw)) return []
      return raw.filter(a => a && HARNESS_ORDER.includes(a.harness) && text(a.key) && text(a.label)).map(a => ({
        key: a.key, harness: a.harness, label: a.label, ...(text(a.plan) ? { plan: a.plan } : {}),
        available: a.available !== false, firstSeen: typeof a.firstSeen === 'number' ? a.firstSeen : now(),
        lastSeen: typeof a.lastSeen === 'number' ? a.lastSeen : now(),
      }))
    } catch { return [] }
  }
  async function write(accounts: HarnessAccount[]): Promise<void> {
    await mkdir(dirname(options.file), { recursive: true })
    const tmp = `${options.file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(accounts), { mode: 0o600 })
    await rename(tmp, options.file)
  }
  async function current(harnesses: readonly HarnessId[]): Promise<HarnessAccount[]> {
    const detected = await Promise.all([...new Set(harnesses)].map(async harness => ({ harness, ...await identity(harness) })))
    return serial(async () => {
      const accounts = await read()
      const current = detected.map(({ harness, identity: { key, label, plan }, confirmed }) => {
        if (!confirmed) {
          // Failed probes must not replace the persisted last-known identity or its restriction.
          // lastSeen advances only on confirmed detection, so this also works after restart.
          const lastKnown = accounts.filter(a => a.harness === harness)
            .reduce<HarnessAccount | undefined>((latest, a) => !latest || a.lastSeen >= latest.lastSeen ? a : latest, undefined)
          if (lastKnown) return { harness, key, label, available: lastKnown.available, firstSeen: lastKnown.firstSeen, lastSeen: lastKnown.lastSeen }
        }
        let account = accounts.find(a => a.harness === harness && a.key === key)
        if (!account) {
          account = { harness, key, label, available: true, firstSeen: now(), lastSeen: now() }
          accounts.push(account)
        }
        account.label = label
        account.plan = plan
        account.lastSeen = now()
        // Persist detection order too, so equal millisecond timestamps still identify the latest login.
        accounts.splice(accounts.indexOf(account), 1)
        accounts.push(account)
        return account
      })
      await write(accounts)
      return current
    })
  }
  return {
    current,
    async list(harnesses: readonly HarnessId[] = HARNESS_ORDER): Promise<HarnessAccount[]> {
      await current(harnesses)
      return serial(read)
    },
    async setAvailable(harness: HarnessId, key: string, available: boolean): Promise<HarnessAccount | null> {
      return serial(async () => {
        const accounts = await read()
        const account = accounts.find(a => a.harness === harness && a.key === key)
        if (!account) return null
        account.available = available
        await write(accounts)
        return account
      })
    },
  }
}

let store = createHarnessAccounts({ file: join(AGENTISTICS_DATA_DIR, 'accounts.json') })
export const currentHarnessAccounts = (harnesses: readonly HarnessId[]) => store.current(harnesses)
export const listHarnessAccounts = (harnesses?: readonly HarnessId[]) => store.list(harnesses)
export const setAccountAvailable = (harness: HarnessId, key: string, available: boolean) => store.setAvailable(harness, key, available)

/** Tests install an isolated registry and probes; never read the owner's login. */
export function __setHarnessAccountsForTest(next: ReturnType<typeof createHarnessAccounts>): void { store = next }
