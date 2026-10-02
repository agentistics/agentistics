/**
 * runtime-host.ts — THE HOST SEAM for native sessions (B4, moved into the engine by ES.6a). The
 * runtime may know no path, no credential and no environment of this machine (D23), and neither may
 * the engine (spec §3): where the session store lives, the content store, the journal, the policy's
 * floor and the data dir all come from the installed `EngineHostServices` (`host.ts`). The credential
 * resolver is the engine's own (`cli-provider.ts`, which reads the key store the host locates).
 *
 * Nothing else in the engine builds a session runtime. `agentop code` (cli-code.ts) and the
 * `/api/runtime/sessions` routes (runtime-sessions-web.ts) both come through `createRuntimeHost`, so
 * the CLI and the web cannot drift into two policies for one session.
 *
 * ## The floor depends on the host (B3-SEC F1)
 *
 * The runtime's policy floors `~/.agentistics/**` by itself, but it may not SPELL any harness's
 * credential file (`provider-secrets.lint`). Those are this machine's: the host hands them over as
 * `protectedPaths`, DERIVED from the backup plan's `secret` rows (spec §3). `policyFloor` turns that
 * list into the policy's globs. `agentisticsDir` is passed whenever the data dir is relocated, or the
 * floor would guard the default location while the real key store sat unguarded somewhere else.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, relative, isAbsolute } from 'node:path'
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
import { hostAnthropicClientDeps } from './cli-provider'
import { host } from './host'

/** The native session store, under the HOST's data dir. (The public backup plan must exclude it.) */
export const runtimeDir = (): string => join(host().paths.dataDir, 'runtime')
export const runtimeSessionsDb = (): string => join(runtimeDir(), 'sessions.db')

/**
 * PURE. The policy globs for the host's `protectedPaths` — absolute paths, one per backup-plan
 * `secret` row (spec §3). A row is a STRING prefix in the backup table (`cache.db` catches
 * `cache.db-wal`), so each path becomes `<p>`, `<p>*` and `<p>*\/**` — the file, its stem siblings and
 * anything below a directory of that name. A `#field` suffix names a field inside a file; the whole
 * file is floored, which is the over-protective direction. Paths under `home` are written `~/…`, the
 * form the policy's globs are matched in. Paths under the data dir — the one in use or the default
 * one — are skipped: the runtime floors that whole directory itself (F1).
 */
export function policyFloor(protectedPaths: readonly string[], home: string, dataDirs: readonly string[]): string[] {
  const out = new Set<string>()
  const under = (root: string, p: string) => {
    const r = relative(root, p)
    return r === '' || (!r.startsWith('..') && !isAbsolute(r))
  }
  for (const raw of protectedPaths) {
    const abs = raw.split('#')[0]!.replace(/\/+$/, '')
    if (!abs || !isAbsolute(abs)) continue
    if (dataDirs.some(d => under(d, abs))) continue
    const inHome = relative(home, abs)
    const p = inHome !== '' && !inHome.startsWith('..') && !isAbsolute(inHome) ? `~/${inHome}` : abs
    out.add(p); out.add(`${p}*`); out.add(`${p}*/**`)
  }
  return [...out].sort()
}

/** This machine's harness credential globs — the policy's `protectedPaths`, from the host. */
export function hostProtectedPaths(): string[] {
  const h = host()
  return policyFloor(h.protectedPaths, h.paths.home, [h.paths.dataDir, h.paths.defaultDataDir])
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
  const paths = host().paths
  const dataDir = opts.dataDir ?? paths.dataDir
  const relocated = dataDir !== (opts.defaultDataDir ?? paths.defaultDataDir)
  return createPolicy({
    layers: [],
    home: opts.home ?? paths.home,
    protectedPaths: opts.protectedPaths ?? hostProtectedPaths(),
    ...(relocated ? { agentisticsDir: dataDir } : {}),
  })
}

/**
 * The workspace a session acts on: the nearest directory at or above `cwd` holding a `.git` (a
 * directory, or the FILE a worktree or submodule has) — what `git rev-parse --show-toplevel` answers
 * — or `cwd` itself outside a repository. Read off the filesystem rather than asked of `git`: a
 * spawned git would inherit the caller's `GIT_DIR` and could name a different repository, and the
 * engine reads no environment to scrub it with.
 */
export function workspaceRootFor(cwd: string): string {
  let dir = cwd
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const up = dirname(dir)
    if (up === dir) return cwd
    dir = up
  }
}

// ── The host ────────────────────────────────────────────────────────────────────────────────────

/** How many native runs one process drives at once. A CEILING, not a timer (§24.4). */
export const NATIVE_RUN_CEILING = 4
/** How long a lease lives without a refresh. A crashed holder frees it after this at the latest. */
export const LEASE_TTL_MS = 60_000

export interface RuntimeHostOptions {
  /** Default `runtimeSessionsDb()`. */
  dbPath?: string
  /** Default the host's content dir. */
  contentDir?: string
  /** The journal. `undefined` = the host's (`host().journal.sink()`); `null` = none. */
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
  const dbPath = opts.dbPath ?? runtimeSessionsDb()
  mkdirSync(join(dbPath, '..'), { recursive: true, mode: 0o700 })
  // The store's own default treats every holder as alive, which would leave a session whose driver
  // was killed un-resumable until its lease expired. Here the host can ask the OS.
  const store = openSqliteSessionStore(dbPath, { isAlive: opts.isAlive ?? pidAlive })
  const content = createFileContentStore(opts.contentDir ?? host().paths.contentDir)
  // The HOST owns the journal and its lifetime: the engine appends and never closes it.
  let journal: ProviderJournalSink | null
  if (opts.journal === undefined) {
    try {
      journal = (await host().journal.sink()) as ProviderJournalSink | null
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
