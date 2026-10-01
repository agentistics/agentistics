/**
 * host.ts — the ONE place this engine learns anything about the machine it runs on.
 *
 * Spec §3 (D23 lifted one level): an engine reads no path, no credential and no environment of this
 * machine on its own. Everything machine-specific arrives in the `EngineHostServices` the host hands
 * to `createEngine`, which installs it here once. Every default in the engine that used to read
 * `config.ts` (a harness root, the content store, the provider flag, "is this a central") now reads
 * THIS object.
 *
 * Asking before a host is installed THROWS, in a sentence naming the fix. A silent fallback to
 * `$HOME` would be the engine inventing a path the host never gave it — the exact thing D23 forbids —
 * and a test that forgot to install one would then read the developer's real `~/.claude`.
 */
import { join } from 'node:path'
import type { EngineHostServices } from '@agentistics/engine-api'
import type { AgentisticsEvent, HarnessId } from '@agentistics/core'
import { installedReaders, type ReuseSurface } from './reuse'

export type HostServices = EngineHostServices<AgentisticsEvent>

let current: HostServices | null = null

/** `createEngine` calls this first. A second install replaces the first (tests; a re-created engine). */
export function installHost(h: HostServices): void {
  current = h
}

/** The installed host. Throws when none is — see the header. */
export function host(): HostServices {
  if (!current) {
    throw new Error('the engine has no host installed — createEngine(host) installs it (tests: installHost(testHost(...)))')
  }
  return current
}

export function hostInstalled(): boolean {
  return current !== null
}

/** Tests only. */
export function uninstallHostForTests(): void {
  current = null
}

/**
 * A harness's root as the HOST resolved it (env overrides included — `config.ts` owns that rule, not
 * the engine). A harness the host names no root for is refused in a sentence rather than guessed.
 */
export function harnessRoot(id: HarnessId): string {
  const root = host().paths.harnessRoots[id]
  if (!root) throw new Error(`the host gave the engine no root for ${id}`)
  return root
}

/** `<claude root>/projects` — what `config.ts` calls `PROJECTS_DIR`. */
export const claudeProjectsDir = (): string => join(harnessRoot('claude'), 'projects')
/** `<codex root>/sessions` — `CODEX_SESSIONS_DIR`. */
export const codexSessionsDir = (): string => join(harnessRoot('codex'), 'sessions')
/** `<copilot root>/session-state` — `COPILOT_SESSION_STATE_DIR`. */
export const copilotSessionStateDir = (): string => join(harnessRoot('copilot'), 'session-state')
/** OpenCode's database file as the HOST resolved it — `OPENCODE_DB_PATH` included (contract 1.2). */
export const opencodeDbPath = (): string => host().paths.opencodeDbPath

/** The content store — raw provider captures land here (`CONTENT_DIR`). */
export const contentDir = (): string => host().paths.contentDir
/** `<data dir>/provider-keys` — `PROVIDER_KEYS_DIR`. */
export const providerKeysDir = (): string => join(host().paths.dataDir, 'provider-keys')

/**
 * A host for tests and scripts: every path under `root`, every capability off, the provider flag as
 * given, nothing audited or notified. The journal is absent unless `journal` is passed. Its
 * `readers` are the surface already installed (`test/preload.ts` installs the public host's own);
 * with none installed they are EMPTY, and `createEngine` refuses them in a sentence.
 */
export function testHost(root: string, over: Partial<HostServices> = {}): HostServices {
  const roots: Record<HarnessId, string> = {
    claude: join(root, '.claude'),
    codex: join(root, '.codex'),
    gemini: join(root, '.gemini'),
    copilot: join(root, '.copilot'),
    antigravity: join(root, '.gemini', 'antigravity-cli'),
    kimi: join(root, '.kimi-code'),
    opencode: join(root, '.local', 'share', 'opencode'),
  }
  const base: HostServices = {
    paths: {
      dataDir: join(root, '.agentistics'),
      defaultDataDir: join(root, '.agentistics'),
      contentDir: join(root, '.agentistics', 'content'),
      home: root,
      harnessRoots: roots,
      opencodeDbPath: join(roots.opencode, 'opencode.db'),
    },
    journal: { sink: async () => null, status: () => ({ state: 'disabled', reason: 'test-host' }) },
    protectedPaths: [],
    caps: {
      localShell: false, localChat: false, localTranscripts: false, localProcesses: false,
      mcpAdmin: false, requireMfaForOwner: false, requireSecureCookies: false,
    },
    isCentral: () => false,
    flag: () => false,
    audit: () => {},
    readJsonLimited: async <T>(req: Request, maxBytes: number) => {
      const text = await req.text()
      if (text.length > maxBytes) return { ok: false as const, error: 'too_large' as const }
      try { return { ok: true as const, value: JSON.parse(text) as T } } catch { return { ok: false as const, error: 'invalid_json' as const } }
    },
    safeError: (err: unknown) => ({ body: { error: 'internal', ref: 'test' }, logLine: String(err) }),
    spawnBudget: async () => ({ budget: { max: 0, used: 0, left: 0, percent: 0 } }),
    notify: () => {},
    lang: () => 'en',
    tasks: {
      fileNative: async () => ({ ok: false as const, reason: 'test host' }),
      unfileNative: async () => {},
    },
    readers: installedReaders() ?? ({} as ReuseSurface),
    originPolicy: () => ({ allowedOrigins: [], dev: false }),
    now: () => new Date(),
  }
  return { ...base, ...over }
}
