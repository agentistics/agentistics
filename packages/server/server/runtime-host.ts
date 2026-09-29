/**
 * runtime-host.ts — THE HOST SEAM for native sessions (B4). `@agentistics/runtime` may know no path,
 * no credential and no environment of this machine (D23), so everything it needs is decided here and
 * handed in: where the session store lives, the content store, the journal, the credential resolver,
 * the environment a tool's process sees, the workspace root, and the policy's floor.
 *
 * Nothing else in `packages/server` builds a session runtime. `agentop code` (cli-code.ts) and the
 * `/api/runtime/*` routes (runtime-sessions-web.ts) both come through `createRuntimeHost`, so the
 * CLI and the web cannot drift into two policies for one session.
 *
 * ## The floor depends on this module (B3-SEC F1)
 *
 * The runtime's policy floors `~/.agentistics/**` by itself, but it may not SPELL any harness's
 * credential file (`provider-secrets.lint`). Those are this machine's to pass as `protectedPaths`,
 * and the list is DERIVED from the backup plan's `secret` rows — the one table in this repo that
 * already had to decide, per harness, which files are live credentials. A harness added there is
 * floored here without anybody remembering a second list. `agentisticsDir` is passed whenever
 * `AGENTISTICS_DIR` relocates the data dir, or the floor would guard the default location while the
 * real key store sat unguarded somewhere else.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  createAnthropicClient,
  createFileContentStore,
  createHubAsker,
  createNativeTools,
  createPolicy,
  createRunScheduler,
  createSessionHub,
  createSessionRuntime,
  openSqliteSessionStore,
  textDeltaFromProviderEvent,
  type LeaseAcquireResult,
  type LeaseHolder,
  type NativeTools,
  type PersonAsker,
  type ProviderClient,
  type ProviderJournalSink,
  type SessionHub,
  type SessionPolicy,
  type SessionRuntime,
  type SessionStore,
  type ToolEnv,
} from '@agentistics/runtime'
import type { ProviderId } from '@agentistics/core'
import { omittedSecrets, type ExcludeRule } from './backup/backup-plan'
import { AGENTISTICS_DATA_DIR, CONTENT_DIR, DEFAULT_AGENTISTICS_DATA_DIR, HOME_DIR } from './config'
import { hostAnthropicClientDeps } from './cli-provider'

/** The native session store. Excluded from backups with a reason (`backup-plan.ts`). */
export const RUNTIME_DIR = join(AGENTISTICS_DATA_DIR, 'runtime')
export const RUNTIME_SESSIONS_DB = join(RUNTIME_DIR, 'sessions.db')

/** The directory a `contains` rule's pattern is searched under: every harness home the table names. */
function harnessHomes(rules: readonly ExcludeRule[]): string[] {
  const homes = new Set<string>()
  for (const r of rules) {
    if (r.match !== 'prefix') continue
    const first = r.pattern.split('/')[0]
    if (first && first.startsWith('.') && first !== '.agentistics' && r.pattern.includes('/')) homes.add(first)
  }
  return [...homes].sort()
}

/**
 * The policy globs for a list of backup exclusion rules (`$HOME`-relative, no leading slash).
 *
 * - `prefix` is a STRING prefix in the backup table (it matches a filename stem: `cache.db` catches
 *   `cache.db-wal`), so it becomes `~/<p>` + `~/<p>*` + `~/<p>*\/**` — the file, its stem siblings and
 *   anything below a directory of that name.
 * - `contains` with a `/` (`.copilot/token`) becomes `~/**\/<p>*` and its subtree.
 * - `contains` with no `/` (`.key`) is anchored under every harness home the table names — as a
 *   bare `**\/*.key*` it would floor any workspace file that merely has `.key` in its name.
 * - A `#field` suffix names a FIELD inside a file (`preferences.json#team.token`); the whole file is
 *   floored, which is the over-protective direction.
 *
 * `.agentistics/...` rows are skipped: the runtime floors that whole directory itself (F1).
 */
export function protectedPathsFromSecrets(rules: readonly ExcludeRule[]): string[] {
  const out = new Set<string>()
  const homes = harnessHomes(rules)
  for (const r of rules) {
    if (r.reason !== 'secret') continue
    const p = r.pattern.split('#')[0]!.replace(/\/+$/, '')
    if (!p || p.startsWith('.agentistics/') || p === '.agentistics') continue
    if (r.match === 'prefix') {
      out.add(`~/${p}`); out.add(`~/${p}*`); out.add(`~/${p}*/**`)
    } else if (p.includes('/')) {
      out.add(`~/**/${p}*`); out.add(`~/**/${p}*/**`)
    } else {
      for (const h of homes) out.add(`~/${h}/**/*${p}*`)
    }
  }
  return [...out].sort()
}

/** This machine's harness credential globs — the policy's `protectedPaths`. */
export function hostProtectedPaths(): string[] {
  return protectedPathsFromSecrets(omittedSecrets())
}

export interface HostPolicyOptions {
  home?: string
  /** The data dir in use; passed to the policy only when it is NOT the default location. */
  dataDir?: string
  defaultDataDir?: string
  protectedPaths?: readonly string[]
}

/**
 * A fresh policy for ONE session. Session approvals live inside a policy object, so a policy is never
 * shared between sessions, and a resumed session gets a new one — its "allow for this session"
 * answers do not survive a restart (B4 contract §4, the safer direction).
 */
export function hostPolicy(opts: HostPolicyOptions = {}): SessionPolicy {
  const dataDir = opts.dataDir ?? AGENTISTICS_DATA_DIR
  const relocated = dataDir !== (opts.defaultDataDir ?? DEFAULT_AGENTISTICS_DATA_DIR)
  return createPolicy({
    layers: [],
    home: opts.home ?? HOME_DIR,
    protectedPaths: opts.protectedPaths ?? hostProtectedPaths(),
    ...(relocated ? { agentisticsDir: dataDir } : {}),
  })
}

/**
 * The workspace a session acts on: the git toplevel of `cwd`, or `cwd` itself outside a repository.
 * Asked with a scrubbed git environment so a caller's `GIT_DIR` cannot name a different repository.
 */
export function workspaceRootFor(cwd: string): string {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('GIT_')) env[k] = v
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf-8', env, timeout: 5000 })
  const top = r.status === 0 ? r.stdout.trim() : ''
  return top || cwd
}

// ── The host ────────────────────────────────────────────────────────────────────────────────────

/** How many native runs one process drives at once. A CEILING, not a timer (§24.4). */
export const NATIVE_RUN_CEILING = 4
/** How long a lease lives without a refresh. A crashed holder frees it after this at the latest. */
export const LEASE_TTL_MS = 60_000

export interface RuntimeHostOptions {
  /** Default `RUNTIME_SESSIONS_DB`. */
  dbPath?: string
  /** Default `CONTENT_DIR`. */
  contentDir?: string
  /** The journal. `undefined` = the machine's (`openJournal()`); `null` = none. */
  journal?: ProviderJournalSink | null
  /** A test's scripted model. Default: the Anthropic client over the key store. */
  clientFor?: (provider: ProviderId) => ProviderClient
  /**
   * The person for a session. Default: the HUB's asker for that session — every surface watching it
   * is asked, the first answer wins, and nobody watching is a DENIAL.
   */
  askerFor?: (sessionId: string) => PersonAsker | undefined
  /** What a tool's process sees. Default `MINIMAL_TOOL_ENV` (the runtime's own default). */
  env?: ToolEnv
  ceiling?: number
  home?: string
  dataDir?: string
  protectedPaths?: readonly string[]
  runtimeVersion?: string
  now?: () => Date
  pid?: number
  /** Default: a real `kill(pid, 0)` probe — a lease held by a process that died is free at once. */
  isAlive?: (pid: number) => boolean
  /** A hub to publish on; default a fresh one. Lets a caller watch a session before driving it. */
  hub?: SessionHub
  retry?: Parameters<typeof createSessionRuntime>[0]['retry']
}

export interface RuntimeHost {
  runtime: SessionRuntime
  store: SessionStore
  hub: SessionHub
  /** The same content store and version the runtime writes through — for resume/repair. */
  content: ReturnType<typeof createFileContentStore>
  /**
   * The journal as a caller outside the runtime must write it (a repair, B4.2): every event it takes
   * is ALSO published on the hub, so a watcher sees a repair exactly as it sees a run. `null` = no
   * journal, and then nothing is published through it either.
   */
  journal: ProviderJournalSink | null
  runtimeVersion: string
  /** This process, as a lease holder. */
  holder: LeaseHolder
  /** Take (or refresh) the right to DRIVE a session. Watching needs none. */
  acquire(sessionId: string): Promise<LeaseAcquireResult>
  release(sessionId: string): Promise<void>
  dispose(): Promise<void>
}

/**
 * The ONE place a native session runtime is built. Every event the runtime journals is also published
 * on the hub for that session, and every live text delta with it — one fan-out per session, whatever
 * number of surfaces watch (§24.2).
 */
export async function createRuntimeHost(opts: RuntimeHostOptions = {}): Promise<RuntimeHost> {
  const dbPath = opts.dbPath ?? RUNTIME_SESSIONS_DB
  mkdirSync(join(dbPath, '..'), { recursive: true, mode: 0o700 })
  // The store's own default treats every holder as alive, which would leave a session whose driver
  // was killed un-resumable until its lease expired. Here the host can ask the OS.
  const store = openSqliteSessionStore(dbPath, { isAlive: opts.isAlive ?? pidAlive })
  const content = createFileContentStore(opts.contentDir ?? CONTENT_DIR)
  let journal: ProviderJournalSink | null
  let closeJournal: (() => void) | null = null
  if (opts.journal === undefined) {
    try {
      const { openJournal } = await import('./journal/journal')
      const j = await openJournal()
      journal = j
      closeJournal = () => j.close()
    } catch {
      journal = null
    }
  } else {
    journal = opts.journal
  }

  const runtimeVersion = opts.runtimeVersion ?? 'agentistics-runtime@b4'
  const hub = opts.hub ?? createSessionHub()
  const tools: NativeTools = createNativeTools(opts.env ? { env: opts.env } : {})
  const clients = new Map<ProviderId, ProviderClient>()
  const clientFor = opts.clientFor ?? ((provider: ProviderId): ProviderClient => {
    if (provider !== 'anthropic') {
      throw new Error(`agentop drives native sessions through anthropic only for now (asked: ${provider})`)
    }
    let c = clients.get(provider)
    if (!c) { c = createAnthropicClient(hostAnthropicClientDeps()); clients.set(provider, c) }
    return c
  })
  const askers = new Map<string, PersonAsker>()
  const askerFor = opts.askerFor ?? ((sessionId: string) => {
    const known = askers.get(sessionId)
    if (known) return known
    // Bounded by the sessions this process has driven; dropped on release.
    const made = createHubAsker(hub, sessionId)
    askers.set(sessionId, made)
    return made
  })

  const runtime = createSessionRuntime({
    store,
    content,
    journal,
    clientFor,
    tools: tools.tools,
    policyFactory: () => hostPolicy({
      home: opts.home, dataDir: opts.dataDir,
      ...(opts.protectedPaths ? { protectedPaths: opts.protectedPaths } : {}),
    }),
    askerFor,
    runtimeVersion,
    scheduler: createRunScheduler({ ceiling: opts.ceiling ?? NATIVE_RUN_CEILING }),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.retry ? { retry: opts.retry } : {}),
    onEvent: (e) => { if (e.sessionId) hub.publish(e.sessionId, { kind: 'event', event: e }) },
    onStreamEvent: (e, scope) => {
      const text = textDeltaFromProviderEvent(e)
      if (text !== null) hub.publish(scope.sessionId, { kind: 'delta', runId: scope.runId, text })
    },
  })

  const publishing: ProviderJournalSink | null = journal === null ? null : {
    async append(events) {
      const r = await journal!.append(events)
      for (const e of events) if (e.sessionId) hub.publish(e.sessionId, { kind: 'event', event: e })
      return r
    },
  }

  const holder: LeaseHolder = { pid: opts.pid ?? process.pid, token: crypto.randomUUID() }
  // A held lease is REFRESHED while this process holds it, or a run longer than the TTL would hand
  // the session to the next process that asked. One timer per held session, cleared on release.
  const refreshers = new Map<string, ReturnType<typeof setInterval>>()
  const stopRefresh = (sessionId: string) => {
    const t = refreshers.get(sessionId)
    if (t) { clearInterval(t); refreshers.delete(sessionId) }
  }
  return {
    runtime, store, hub, holder, content, journal: publishing, runtimeVersion,
    async acquire(sessionId) {
      const r = await store.acquireLease(sessionId, holder, LEASE_TTL_MS)
      if (r.ok && !refreshers.has(sessionId)) {
        const t = setInterval(() => {
          store.refreshLease(sessionId, holder, LEASE_TTL_MS).then(
            (again) => { if (!again.ok) stopRefresh(sessionId) },
            () => {},
          )
        }, Math.floor(LEASE_TTL_MS / 3))
        ;(t as { unref?: () => void }).unref?.()
        refreshers.set(sessionId, t)
      }
      return r
    },
    async release(sessionId) {
      stopRefresh(sessionId)
      askers.delete(sessionId)
      await store.releaseLease(sessionId, holder)
    },
    async dispose() {
      for (const id of [...refreshers.keys()]) stopRefresh(id)
      await tools.dispose()
      closeJournal?.()
      const closable = store as SessionStore & { close?: () => void }
      closable.close?.()
    },
  }
}

/** Is a process with this pid alive? `EPERM` means it exists under another user — alive. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) {
    return (e as { code?: string }).code === 'EPERM'
  }
}
