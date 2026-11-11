import { join } from 'path'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { accountHome } from './account-home'
import { resolveDataDir } from './data-dir'
import { loadEnvConfig } from './env-config'
import { opencodePaths } from './opencode-paths'
import { featureOn, type HarnessId } from '@agentistics/core'
import { journalLiveEnabled } from './journal/live-flag'

loadEnvConfig()

export const HOME_DIR = process.env.HOME ?? process.env.USERPROFILE ?? ''
export const CLAUDE_DIR = process.env.CLAUDE_DIR ?? join(HOME_DIR, '.claude')
export const PROJECTS_DIR = join(CLAUDE_DIR, 'projects')
export const SESSION_META_DIR = join(CLAUDE_DIR, 'usage-data', 'session-meta')
export const STATS_CACHE_FILE = join(CLAUDE_DIR, 'stats-cache.json')
// Billing-signal sources, read by `billing-detect.ts` to PROPOSE how this machine is billed.
// That module extracts a fixed whitelist of non-secret fields and never touches the tokens,
// email address or account uuids these same files also hold — see its header.
//
// Note these are NOT shared with `mcp-list.ts`, which reads the literal `HOME_DIR` copies of
// `settings.json` / `.claude.json` rather than the (overridable, possibly container-mounted)
// CLAUDE_DIR ones. That difference is real, not an oversight: MCP administration acts on the
// user's own home config, while billing detection describes whichever Claude install this server
// is actually reporting on. Collapsing the two would silently retarget one of them.
export const CLAUDE_SETTINGS_FILE = process.env.CLAUDE_SETTINGS_FILE ?? join(CLAUDE_DIR, 'settings.json')
export const CLAUDE_SETTINGS_LOCAL_FILE = process.env.CLAUDE_SETTINGS_LOCAL_FILE ?? join(CLAUDE_DIR, 'settings.local.json')
export const CLAUDE_CREDENTIALS_FILE = process.env.CLAUDE_CREDENTIALS_FILE ?? join(CLAUDE_DIR, '.credentials.json')
// `~/.claude.json` is a SIBLING of the .claude directory, not a child, so it cannot be derived
// from CLAUDE_DIR — a container mounting the host dir at /host-claude would resolve it to
// `/.claude.json`. Defaults to the home copy and takes an explicit override instead.
export const CLAUDE_JSON_FILE =process.env.CLAUDE_JSON_FILE ?? join(HOME_DIR, '.claude.json')
export const PORT = parseInt(process.env.PORT ?? '47291', 10)
// The web dashboard is served on WEB_PORT (PORT + 1 by default → 47292). In binary mode the
// server binds BOTH: PORT (47291) is always the api + mcp endpoint, WEB_PORT (47292) is what you
// open. They share one request handler, so the SPA's same-origin `/api/*` calls just work.
export const WEB_PORT = parseInt(process.env.WEB_PORT ?? String(PORT + 1), 10)

// ---------------------------------------------------------------------------
// Archive mirror — Claude Code silently deletes session transcripts older than
// `cleanupPeriodDays` (default 30) on every startup. We mirror the raw source
// files into AGENTISTICS_ARCHIVE_DIR so the full lifecycle is never lost.
// Reads union live + archive (live always wins); set AGENTISTICS_ARCHIVE=0 to disable.
// ---------------------------------------------------------------------------
export const ARCHIVE_ENABLED = process.env.AGENTISTICS_ARCHIVE !== '0'
// The app's own writable data dir. In Docker this is
// the read-WRITE ~/.agentistics mount, whereas CLAUDE_DIR is the host ~/.claude mounted
// read-only — so anything the app must persist (preferences, consolidate store, sync state)
// belongs here, never under CLAUDE_DIR.
// The location an install with no `AGENTISTICS_DIR` uses. Exported because it is the ONLY
// directory a pre-`~/.agentistics` legacy file may seed: see `legacyPreferencesSource` in
// preferences.ts.
export const DEFAULT_AGENTISTICS_DATA_DIR = join(HOME_DIR, '.agentistics')
// Under `bun test` this is a fresh temporary directory, never the owner's store — see data-dir.ts.
// It is exported back into the environment so modules reading `AGENTISTICS_DIR` themselves, and
// any child process a test spawns, land in the same isolated directory.
const _dataDir = resolveDataDir({
  env: process.env,
  home: HOME_DIR,
  // The ACCOUNT's home: under Bun `os.userInfo().homedir` follows `$HOME` (`account-home.ts`).
  ownerHome: (() => { try { return accountHome() || HOME_DIR } catch { return HOME_DIR } })(),
  makeTemp: () => mkdtempSync(join(tmpdir(), 'agentistics-test-data-')),
})
if (_dataDir.isolated) process.env.AGENTISTICS_DIR = _dataDir.dir
export const AGENTISTICS_DATA_DIR = _dataDir.dir
// EVERY path below is derived from AGENTISTICS_DATA_DIR, never from HOME_DIR directly. They used
// to be built from the home directory, so `AGENTISTICS_DIR` relocated preferences and the
// connection state while the consolidate store, the archive and the workflow runs silently stayed
// in the default location. An instance pointed at its own data dir — a second instance on one
// host, a container with its own volume, a test rig — then READ AND PUSHED the sessions of
// whatever profile it happened to run under, attributed to itself. Found by an end-to-end run in
// which three isolated machines each pushed the same 108 sessions belonging to none of them.
// Defaults are unchanged: with AGENTISTICS_DIR unset this is still ~/.agentistics/<...>.
export const ARCHIVE_DIR = process.env.AGENTISTICS_ARCHIVE_DIR ?? join(AGENTISTICS_DATA_DIR, 'archive')
export const ARCHIVE_PROJECTS_DIR = join(ARCHIVE_DIR, 'projects')
export const ARCHIVE_SESSION_META_DIR = join(ARCHIVE_DIR, 'usage-data', 'session-meta')
export const ARCHIVE_STATS_DIR = join(ARCHIVE_DIR, 'stats-cache')
// The durable event journal (decision D2: SQLite WAL, one per machine): <data dir>/journal.db.
// `AGENTISTICS_JOURNAL_DIR` MOVES it — the escape hatch for a data dir that sits on a network
// filesystem, where the journal refuses to open (WAL is not safe there). It never disables that
// check: the override directory is classified exactly like the default one. Written as two literal
// `join`s rather than one over a computed dir so `backup-coverage.lint.test.ts` can see the name.
export const JOURNAL_PATH = process.env.AGENTISTICS_JOURNAL_DIR
  ? join(process.env.AGENTISTICS_JOURNAL_DIR, 'journal.db')
  : join(AGENTISTICS_DATA_DIR, 'journal.db')
// The shadow writer's flag (P1 §1 item 5, §11): while `AGENTISTICS_JOURNAL` is on, a build ALSO feeds
// the journal. **ON by default** since the journal-backfill item (the projections read it on every
// surface): only an explicit negative (`0`, `false`, `off`, `no`) turns it off. `featureOn` is the one
// reading, shared with the experimental table.
export const JOURNAL_ENABLED = featureOn('journal', process.env)
// The live path (LIVE.3, P4 A5.3): an engine's file-tail and attention producer feed the journal
// between builds. Effective ONLY with `AGENTISTICS_JOURNAL` — it feeds that journal and nothing else.
// ON by default; only 0/false/off/no disables it. Read by the host and handed to an engine as
// `flag('live')` (engine-api 1.4); the engine reads no environment.
export const JOURNAL_LIVE_ENABLED = journalLiveEnabled(JOURNAL_ENABLED, process.env.AGENTISTICS_JOURNAL_LIVE)
// What the WRITING process reports about itself (counters since boot), for `agentop journal status`
// to read from a different process. It sits beside the journal, whichever directory that is.
// Both side-files below are written as literal `join`s, like `JOURNAL_PATH`, so
// `backup-coverage.lint.test.ts` can SEE the names and hold each to a decision in `backup-plan.ts`.
export const JOURNAL_STATUS_PATH = process.env.AGENTISTICS_JOURNAL_DIR
  ? join(process.env.AGENTISTICS_JOURNAL_DIR, 'journal.db.status.json')
  : join(AGENTISTICS_DATA_DIR, 'journal.db.status.json')
// The shadow writer's accepted-stamps memory (`journal/shadow.ts`, default `<journal path>.stamps.json`),
// which lets a run skip sources it has already folded in. Same directory rule as the journal itself.
export const JOURNAL_STAMPS_PATH = process.env.AGENTISTICS_JOURNAL_DIR
  ? join(process.env.AGENTISTICS_JOURNAL_DIR, 'journal.db.stamps.json')
  : join(AGENTISTICS_DATA_DIR, 'journal.db.stamps.json')
// `agentop journal import`'s resume state (`journal/import.ts`: a cursor per replayed source + the
// store entries already imported), bound to the journal file's identity. Same directory rule.
export const JOURNAL_IMPORT_STATE_PATH = process.env.AGENTISTICS_JOURNAL_DIR
  ? join(process.env.AGENTISTICS_JOURNAL_DIR, 'journal.db.import.json')
  : join(AGENTISTICS_DATA_DIR, 'journal.db.import.json')
// The automatic first import's progress (`journal/backfill.ts`): its state, its counts, and when it
// COMPLETED, bound to the journal file's identity. Until it says complete, the projections answer
// `projections_backfilling` and every surface reads /api/data.
export const JOURNAL_BACKFILL_PATH = process.env.AGENTISTICS_JOURNAL_DIR
  ? join(process.env.AGENTISTICS_JOURNAL_DIR, 'journal.db.backfill.json')
  : join(AGENTISTICS_DATA_DIR, 'journal.db.backfill.json')
// Consolidated per-session metrics (mode 'consolidate'): <data dir>/sessions/<id>.json
export const CONSOLIDATED_DIR = join(AGENTISTICS_DATA_DIR, 'sessions')
// Persisted workflow runs (survive Claude's transcript cleanup): <data dir>/workflows/<runId>.json
export const WORKFLOWS_STORE_DIR = join(AGENTISTICS_DATA_DIR, 'workflows')
// Session-manager registry: the sessions `agentop session` started, with their labels and notes.
// Deliberately NOT inside CONSOLIDATED_DIR — `loadConsolidated` reads every flat *.json at that
// root as a legacy Claude session, so a registry file there would be parsed as session metrics.
export const MANAGED_SESSIONS_FILE = join(AGENTISTICS_DATA_DIR, 'managed-sessions.json')

// The task book: the deliveries sessions are filed under, and the attempts (configurations) each
// one was tried with. Lives beside the registry, and for the same reason it is not inside
// CONSOLIDATED_DIR — `loadConsolidated` would read a flat *.json at that root as session metrics.
export const TASKS_FILE = process.env.AGENTISTICS_TASKS_FILE
  ?? join(AGENTISTICS_DATA_DIR, 'tasks.json')

// Derived-value cache for JSONL parses: <data dir>/cache.db (SQLite).
// DERIVED STATE ONLY — every row is recomputable from the file it names, so deleting
// this file may only ever cost one slow build. Never store anything here that is not
// also on disk somewhere else.
export const PARSE_CACHE_FILE = process.env.AGENTISTICS_PARSE_CACHE_FILE ?? join(AGENTISTICS_DATA_DIR, 'cache.db')
/** Repository statistics, keyed on the commit they were derived from. Its own file rather than a
 *  table in `cache.db`: the two are gc'd on different clocks, and a corrupt parse cache must not
 *  cost the git walks as well — each degrades to a no-op independently. */
export const GIT_STATS_CACHE_FILE = process.env.AGENTISTICS_GIT_STATS_CACHE_FILE ?? join(AGENTISTICS_DATA_DIR, 'git-stats.db')

/** One server per PORT. Keyed on the port rather than the machine because two servers with
 *  different ports are two legitimate processes on one host — what must never happen twice is two servers
 *  answering for the same address while both scan every repository on disk. */
/**
 * The instance claim, keyed on the DATA DIRECTORY — never on the port.
 *
 * It was `server-${port}.lock`, which is a claim on a port, and the port already has a claim: the
 * bind. What two servers actually contend over is this directory — the session registry, the
 * consolidate store, the backup history — and the repositories they each walk to fill it.
 *
 * Measured on one machine with the port-keyed lock installed: `agentop server` on 47291 and a
 * second one on 48801, both with no `AGENTISTICS_DIR`, both writing `~/.agentistics` and both
 * spawning `git log --numstat` across every worktree. Two different lock names, so both passed the
 * guard that exists to stop exactly that.
 *
 * Keyed on the directory, a preview on another port still runs — it just has to say WHERE its data
 * goes (`AGENTISTICS_DIR=…`), which is the thing that made it harmless in the first place.
 */
export const serverLockFile = (): string => join(AGENTISTICS_DATA_DIR, 'server.lock')
export const PARSE_CACHE_ENABLED = process.env.AGENTISTICS_PARSE_CACHE !== '0'

// Set by the Dockerfile's runtime stage. Inside an image this process is replaced by pulling or
// rebuilding the image, never by swapping its own binary, and it cannot reach the host's tmux — see
// daemon-plan.ts and upgrade-gate.ts.
export const IN_CONTAINER = process.env.AGENTISTICS_CONTAINER === '1'
// ---------------------------------------------------------------------------
// Exposure profile (see exposure.ts). AGENTISTICS_EXPOSURE=local|lan|public.
// Unset → 'local'. An unknown value fails closed to 'public'.
// AGENTISTICS_ALLOW_LOCAL_SHELL=1 re-enables /api/exec, /api/chat-tty, the host transcript
// readers and /api/mcp-action on a 'lan' instance. It is IGNORED on 'public'.
// ---------------------------------------------------------------------------
export const EXPOSURE = process.env.AGENTISTICS_EXPOSURE
export const ALLOW_LOCAL_SHELL = process.env.AGENTISTICS_ALLOW_LOCAL_SHELL === '1'
// Trust CF-Connecting-IP / X-Forwarded-For for rate limiting and audit logging. Enable ONLY when
// the app is reachable exclusively through a proxy that rewrites them (cloudflared on the same
// host + BIND_IP=127.0.0.1) — otherwise a client can pick its own rate-limit bucket.
export const TRUST_PROXY = process.env.AGENTISTICS_TRUST_PROXY === '1'
// Comma-separated browser origins allowed to call this instance cross-origin. Normally EMPTY:
// the dashboard is served by this same process, so it is same-origin. Only set it for a split
// deployment (SPA hosted elsewhere).
export const ALLOWED_ORIGINS = (process.env.AGENTISTICS_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

/** The app is reached over HTTPS (a tunnel or reverse proxy terminates TLS): HSTS is sent and
 *  cookies are Secure. AGENTISTICS_TLS=1. */
export const TLS = process.env.AGENTISTICS_TLS === '1'

// ---------------------------------------------------------------------------
// Other harnesses (Phase 1: Codex). Each adapter checks its own root.
// Override with CODEX_DIR; disable with AGENTISTICS_HARNESS_CODEX=0.
// ---------------------------------------------------------------------------
export const CODEX_DIR = process.env.CODEX_DIR ?? join(HOME_DIR, '.codex')
export const CODEX_SESSIONS_DIR = join(CODEX_DIR, 'sessions')
// Codex's own billing signal. `auth.json` holds the OAuth tokens AND an optional API key; only
// the plan tier and the PRESENCE of a key are ever read — see `billing-detect.ts`.
export const CODEX_AUTH_FILE = process.env.CODEX_AUTH_FILE ?? join(CODEX_DIR, 'auth.json')

// ---------------------------------------------------------------------------
// Gemini CLI harness. Override with GEMINI_DIR; disable with AGENTISTICS_HARNESS_GEMINI=0.
// ---------------------------------------------------------------------------
export const GEMINI_DIR = process.env.GEMINI_DIR ?? join(HOME_DIR, '.gemini')

// ---------------------------------------------------------------------------
// GitHub Copilot CLI harness. Override with COPILOT_DIR; disable with
// AGENTISTICS_HARNESS_COPILOT=0.
// ---------------------------------------------------------------------------
export const COPILOT_DIR = process.env.COPILOT_DIR ?? join(HOME_DIR, '.copilot')

// ---------------------------------------------------------------------------
// Antigravity CLI (agy) harness. It lives INSIDE the Gemini home
// (~/.gemini/antigravity-cli) but is a distinct harness — the Gemini adapter only
// reads ~/.gemini/tmp, so the two never overlap.
// Override with ANTIGRAVITY_DIR; disable with AGENTISTICS_HARNESS_ANTIGRAVITY=0.
// ---------------------------------------------------------------------------
// Kimi Code CLI harness. Override with KIMI_DIR; disable with AGENTISTICS_HARNESS_KIMI=0.
export const KIMI_DIR = process.env.KIMI_DIR ?? join(HOME_DIR, '.kimi-code')

// ---------------------------------------------------------------------------
// opencode CLI harness. Its store is resolved the way opencode resolves it (`opencode-paths.ts`): OPENCODE_DB,
// else $XDG_DATA_HOME/opencode, else ~/.local/share/opencode; OPENCODE_DIR is our own override of the directory.
// (`OPENCODE_DB_PATH`, read here until V-OPENCODE.2, never moved opencode's database.) `opencode-local.db` (a
// SEPARATE, per-project database the replay does not read — see integrations/opencode/index.ts's header) is
// deliberately not named here.
// ---------------------------------------------------------------------------
const OPENCODE_PATHS = opencodePaths(process.env, HOME_DIR)
export const OPENCODE_DIR = OPENCODE_PATHS.dir
export const OPENCODE_DB_PATH = OPENCODE_PATHS.dbPath

// Hermes (Nous Research). DECLARED only: detection of its home, no adapter reads it yet. HERMES_HOME overrides.
export const HERMES_DIR = process.env.HERMES_HOME ?? join(HOME_DIR, '.hermes')

export const ANTIGRAVITY_DIR = process.env.ANTIGRAVITY_DIR ?? join(GEMINI_DIR, 'antigravity-cli')
export const ANTIGRAVITY_BRAIN_DIR = join(ANTIGRAVITY_DIR, 'brain')
export const ANTIGRAVITY_HISTORY_FILE = join(ANTIGRAVITY_DIR, 'history.jsonl')
/** One SQLite DB per conversation; its `gen_metadata` table holds the token/model protobufs. */
export const ANTIGRAVITY_CONVERSATIONS_DIR = join(ANTIGRAVITY_DIR, 'conversations')
/** Optional enrichment (title / parent link). Frequently exists but with zero rows. */
export const ANTIGRAVITY_SUMMARIES_DB = join(ANTIGRAVITY_DIR, 'conversation_summaries.db')

/** The native runtime's feature flag. ABSENT reads as OFF: with it off no provider module is
 *  loaded, no credential file is read, and every `agentop provider` verb but `status` refuses in a
 *  sentence. Kept in ONE exported constant so renaming the flag is one line. */
export const PROVIDER_FLAG_ENV = 'AGENTISTICS_PROVIDER'
/** Only `'1'` turns it on — the convention every other `AGENTISTICS_*` switch here follows. */
export function providerFlagOn(env: Record<string, string | undefined> = process.env): boolean {
  return env[PROVIDER_FLAG_ENV] === '1'
}

/** Provider API keys the USER entered for the native runtime (`agentop provider key set`). Its own
 *  directory, 0700, one 0600 file per provider — never preferences.json, which is served (redacted
 *  by a list that would have to know the field), written at the default mode and carried by every
 *  backup. Excluded from backups as a `secret` in backup-plan.ts. */
export const PROVIDER_KEYS_DIR = join(AGENTISTICS_DATA_DIR, 'provider-keys')

/** The content store (context-manager spec §8.1): `<sha[0:2]>/<sha256>`, content-addressed. The
 *  native runtime's raw provider captures land here — `@agentistics/runtime` has no path of its own
 *  (D23), so the host passes this as the client's `captureDir`. Excluded from backups as a `secret`
 *  in backup-plan.ts. */
export const CONTENT_DIR = join(AGENTISTICS_DATA_DIR, 'content')

/**
 * The OpenAI-compatible ENDPOINTS a machine may configure (B5a, contract D1). CLOSED: each one is a
 * named instance of the Chat Completions protocol with its own stored base URL and (usually) key, and
 * the id doubles as the key FILE name — so a new endpoint is a line here, never a free-form string
 * that reaches a path.
 */
export type OpenAICompatibleEndpointId = 'openai' | 'openrouter' | 'deepseek' | 'litellm' | '9router' | 'ollama'
export const OPENAI_COMPATIBLE_ENDPOINTS: readonly OpenAICompatibleEndpointId[] =
  ['openai', 'openrouter', 'deepseek', 'litellm', '9router', 'ollama']

export function isOpenAICompatibleEndpoint(id: unknown): id is OpenAICompatibleEndpointId {
  return typeof id === 'string' && (OPENAI_COMPATIBLE_ENDPOINTS as readonly string[]).includes(id)
}

/** Who stands behind an endpoint's usage figures (contract D2) — never inferred from a URL. */
export type EndpointKind = 'direct' | 'router' | 'local'

export interface EndpointPreset {
  kind: EndpointKind
  /** The documented default base URL, or `null` when there is none and `--base-url` is REQUIRED. */
  defaultBaseUrl: string | null
  /** May the endpoint be stored with NO key (`--no-key`)? Only a local server that takes none. */
  keyOptional: boolean
  /** Human name for a sentence ("the key is still valid at …"). */
  label: string
}

/** Contract D2 (kinds) + D6 (defaults). `Record<OpenAICompatibleEndpointId, …>`, so a new endpoint
 *  fails the build until its row is written. */
export const ENDPOINT_PRESETS: Readonly<Record<OpenAICompatibleEndpointId, EndpointPreset>> = {
  openai: { kind: 'direct', defaultBaseUrl: 'https://api.openai.com/v1', keyOptional: false, label: 'OpenAI' },
  openrouter: { kind: 'router', defaultBaseUrl: 'https://openrouter.ai/api/v1', keyOptional: false, label: 'OpenRouter' },
  deepseek: { kind: 'direct', defaultBaseUrl: 'https://api.deepseek.com/v1', keyOptional: false, label: 'DeepSeek' },
  // No default: a LiteLLM proxy lives wherever its operator put it.
  litellm: { kind: 'router', defaultBaseUrl: null, keyOptional: false, label: 'the LiteLLM proxy' },
  '9router': { kind: 'router', defaultBaseUrl: 'http://localhost:20128/v1', keyOptional: false, label: '9router' },
  ollama: { kind: 'local', defaultBaseUrl: 'http://localhost:11434/v1', keyOptional: true, label: 'Ollama' },
}

/** The providers a key may be STORED for. Closed, and deliberately narrower than core's
 *  `ProviderId`: Anthropic (B1, owner decision D3) plus the six OpenAI-compatible endpoints (B5a).
 *  An endpoint is keyed by its ENDPOINT id, never by `'openai-compatible'` — one protocol, six files. */
export type KeyedProviderId = 'anthropic' | OpenAICompatibleEndpointId
export const KEYED_PROVIDERS: readonly KeyedProviderId[] = ['anthropic', ...OPENAI_COMPATIBLE_ENDPOINTS]

export function isKeyedProvider(id: unknown): id is KeyedProviderId {
  return typeof id === 'string' && (KEYED_PROVIDERS as readonly string[]).includes(id)
}

/** A provider id is interpolated into a path only after this check, the `safeConnId` rule — and
 *  since the set is closed, every name it lets through is a plain `[a-z0-9]+` word (no separator, no
 *  dot, no traversal), asserted once more below so a future entry cannot widen it by accident. */
export function providerKeyFile(provider: KeyedProviderId, dir: string = PROVIDER_KEYS_DIR): string {
  if (!isKeyedProvider(provider) || !/^[a-z0-9]+$/.test(provider)) {
    throw new Error(`invalid provider id: ${JSON.stringify(provider)}`)
  }
  return join(dir, `${provider}.json`)
}

// ---------------------------------------------------------------------------
// Account roots (PLAN.ACCOUNTS D2): every directory a harness's sessions can live in.
// ---------------------------------------------------------------------------
export interface HarnessRoot {
  root: string
  /** Account id bound to this root; absent for a default root with no binding. */
  account?: string
  isDefault: boolean
}

/** Each harness's default root. `null` = the harness is not read through account roots at all:
 *  antigravity has no isolation variable and keeps its own single-directory reader, and opencode reads its explicitly resolved SQLite database directly. Keyed by `HarnessId`, so a new harness does not compile until it is decided here. */
export const DEFAULT_HARNESS_DIRS: Record<HarnessId, string | null> = {
  claude: CLAUDE_DIR, codex: CODEX_DIR, gemini: GEMINI_DIR, copilot: COPILOT_DIR, kimi: KIMI_DIR,
  antigravity: null, opencode: null, hermes: null,
}
const ROOTS_TTL_MS = 5_000
const rootsMemo = new Map<string, { at: number; value: Promise<HarnessRoot[]> }>()

/** Test seam: drop the 5 s memo so a changed registry is seen at once. */
export function resetHarnessRootsMemo(): void { rootsMemo.clear() }

/**
 * The default root plus every non-retired registry root of `harness`. Read from the registry file
 * only (`readAccounts`, never a probe). A harness whose `DEFAULT_HARNESS_DIRS` entry is `null`
 * (antigravity, opencode) returns `[]`: its own reader is untouched and never gets a second root.
 */
export function harnessRoots(harness: HarnessId, now: number = Date.now()): Promise<HarnessRoot[]> {
  const held = rootsMemo.get(harness)
  if (held && now - held.at < ROOTS_TTL_MS) return held.value
  const value = (async (): Promise<HarnessRoot[]> => {
    const def = DEFAULT_HARNESS_DIRS[harness]
    if (!def) return []
    const out: HarnessRoot[] = []
    let file: Awaited<ReturnType<typeof import('./harness-accounts').readAccounts>> | null = null
    try { file = await (await import('./harness-accounts')).readAccounts() } catch { /* registry unreadable: default only */ }
    const accounts = file?.accounts ?? []
    const bindings = file?.bindings ?? {}
    const bound = accounts.find(a => a.id === bindings[`${harness}:`])
    out.push({ root: def, isDefault: true, ...(bound ? { account: bound.id } : {}) })
    for (const a of accounts) {
      if (a.harness !== harness || a.retired || !a.root || a.root === def) continue
      if (bindings[`${harness}:${a.root}`] !== a.id) continue
      if (out.some(r => r.root === a.root)) continue
      out.push({ root: a.root, account: a.id, isDefault: false })
    }
    return out
  })()
  rootsMemo.set(harness, { at: now, value })
  return value
}
