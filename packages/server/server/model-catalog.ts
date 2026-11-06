/**
 * model-catalog.ts — the models each harness offers HERE, asked of the CLI wherever it publishes a
 * list, and the verified table (`HARNESS_MODELS`) wherever it does not.
 *
 * It is the ONE source every model picker reads — the new-session wizard, a session's model switch,
 * Nay's harness picker and Settings → Chat — because three hand-written lists had drifted until
 * none of them offered the model the CLI itself runs by default. See
 * docs/superpowers/specs/2026-09-29-harness-model-catalog-design.md.
 *
 * A COMMAND IS NEVER ON A HOT PATH. `agy models` goes to the network, and `/api/fleet/new` is asked
 * on every wizard step, so this is stale-while-revalidate: `peekModelCatalog` answers at once with
 * the last good list (or the table, cold) and starts a refresh when the entry is stale; a refresh in
 * flight is shared. `modelCatalog` is the awaiting form, for a caller that can afford to wait.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, delimiter } from 'node:path'
import { HARNESS_ORDER, modelsFor, type HarnessId, type ModelOption } from '@agentistics/core'
import { CODEX_DIR, HOME_DIR, KIMI_DIR } from './config'
import { userSearchPath } from './sessions/user-path'
import {
  parseAgyModels,
  parseClaudeModelCatalog,
  parseCodexModelsCache,
  parseKimiModelAliases,
  parseOpencodeConfigModels,
  parseOpencodeModels,
  type CatalogProvenance,
} from './model-catalog-parse'
import { catalogStale, type PlanEntry } from './model-catalog-plan'

export interface ModelCatalog {
  models: ModelOption[]
  /** `cli`: the harness's own list. `table`: the verified fallback, which is incomplete by nature. */
  source: 'cli' | 'table'
  /**
   * The picker must also accept a typed id. True exactly when the list is the TABLE — the CLI
   * accepts ids the table cannot name, so a closed picker there forbids models that work.
   */
  freeText: boolean
}

type Reader = (p: CatalogProvenance) => Promise<ModelOption[] | null>

const FILE_TTL_MS = 60_000
const COMMAND_TTL_MS = 6 * 60 * 60_000
const COMMAND_TIMEOUT_MS = 15_000

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

async function readText(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8') } catch { return null }
}

/** System directories a CLI may live in that a LaunchAgent's bare PATH lacks; APPENDED, never first. */
const SYSTEM_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']

/**
 * The PATH a model-listing CLI runs with: EXACTLY the one availability, version and spawn use
 * (`userSearchPath`, `~/.local/bin` first), plus the system dirs it may lack APPENDED. A macOS
 * LaunchAgent starts with `/usr/bin:/bin:/usr/sbin:/sbin`, and opencode installed by Homebrew
 * lives in neither. Precedence matters: the list must come from the SAME binary the session will
 * spawn, or a second installation's incompatible list is cached as authoritative.
 */
export function catalogCliPath(path: string | undefined = process.env.PATH, home: string = HOME_DIR): string {
  const base = userSearchPath(path, home)
  const have = new Set(base.split(delimiter))
  const extra = [...SYSTEM_BIN_DIRS, join(home, '.npm-global', 'bin')].filter(d => !have.has(d))
  return [base, ...extra].filter(Boolean).join(delimiter)
}

/** Resolves a CLI name to the absolute binary the catalog would run (null: not installed). */
let resolveCli: (name: string) => string | null = name => Bun.which(name, { PATH: catalogCliPath() })

/** Run a CLI with the user's usual bin dirs on PATH (a sidecar's PATH is often stripped). */
async function runCli(argv: string[]): Promise<string | null> {
  try {
    const env = { ...process.env }
    env.PATH = catalogCliPath(process.env.PATH)
    // Resolve the binary ourselves: a bare name is otherwise looked up on the parent's PATH on some
    // platforms, which is exactly the one that lacks it.
    const bin = resolveCli(argv[0]!) ?? argv[0]!
    const proc = Bun.spawn([bin, ...argv.slice(1)], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', env })
    const timer = setTimeout(() => proc.kill(), COMMAND_TIMEOUT_MS)
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    clearTimeout(timer)
    return code === 0 ? out : null
  } catch {
    return null
  }
}

const CLAUDE_CATALOG_DIR = join(HOME_DIR, '.claude', 'cache', 'model-catalog')

/** Where each harness publishes its list, if it does. ABSENT = no such list: table + free text. */
interface Source {
  /** The CLI this list is asked of: when the binary it resolves to changes, the cached list is void. */
  cli?: string
  ttl: number
  read: Reader
  /** A PARTIAL list for when `read` says nothing (the CLI cannot run): offered with the typed-id box still open. */
  fallback?: Reader
}

const READERS: Partial<Record<HarnessId, Source>> = {
  claude: {
    ttl: FILE_TTL_MS,
    read: async p => {
      let names: string[]
      try { names = (await readdir(CLAUDE_CATALOG_DIR)).filter(n => n.endsWith('.json')) } catch { return null }
      const texts = (await Promise.all(names.map(n => readText(join(CLAUDE_CATALOG_DIR, n))))).filter((t): t is string => t !== null)
      return parseClaudeModelCatalog(texts, { ...p, source: '~/.claude/cache/model-catalog (Claude Code\'s own catalog)' })
    },
  },
  codex: {
    ttl: FILE_TTL_MS,
    read: async p => {
      const text = await readText(join(CODEX_DIR, 'models_cache.json'))
      return text === null ? null : parseCodexModelsCache(text, { ...p, source: '~/.codex/models_cache.json' })
    },
  },
  kimi: {
    ttl: FILE_TTL_MS,
    read: async p => {
      const text = await readText(join(KIMI_DIR, 'config.toml'))
      return text === null ? null : parseKimiModelAliases(text, { ...p, source: '~/.kimi-code/config.toml [models.*]' })
    },
  },
  antigravity: {
    cli: 'agy',
    ttl: COMMAND_TTL_MS,
    read: async p => {
      const out = await runCli(['agy', 'models'])
      return out === null ? null : parseAgyModels(out, { ...p, source: 'agy models' })
    },
  },
  opencode: {
    cli: 'opencode',
    ttl: COMMAND_TTL_MS,
    read: async p => {
      const out = await runCli(['opencode', 'models'])
      return out === null ? null : parseOpencodeModels(out, { ...p, source: 'opencode models' })
    },
    // The user's own opencode.json: the default `model` and every custom provider's models. A custom
    // provider (`upx`) is declared ONLY here, so it is what the picker can still offer when the CLI fails.
    fallback: async p => {
      const dir = join(process.env.XDG_CONFIG_HOME || join(HOME_DIR, '.config'), 'opencode')
      for (const name of ['opencode.json', 'opencode.jsonc']) {
        const text = await readText(join(dir, name))
        const list = text === null ? null : parseOpencodeConfigModels(text, { ...p, source: `~/.config/opencode/${name}` })
        if (list) return list
      }
      return null
    },
  },
}

interface Entry extends PlanEntry { models: ModelOption[] | null; partial: ModelOption[] | null; bin: string | null }
const cache = new Map<HarnessId, Entry>()
const inflight = new Map<HarnessId, Promise<void>>()
let clock: () => number = Date.now

function tableAnswer(harness: HarnessId, partial: ModelOption[] | null = null): ModelCatalog {
  const table = modelsFor(harness)
  const extra = (partial ?? []).filter(m => !table.some(t => t.id === m.id))
  return { models: [...table, ...extra], source: 'table', freeText: true }
}

function answerFrom(harness: HarnessId, entry: Entry | undefined): ModelCatalog {
  return entry?.models ? { models: entry.models, source: 'cli', freeText: false } : tableAnswer(harness, entry?.partial ?? null)
}

/**
 * The cached entry, unless the CLI now resolves to a DIFFERENT binary than the one that produced
 * it (a second installation appeared, or `~/.local/bin` joined PATH): a list is a fact about one
 * binary, and keeping it for the TTL would answer for an installation that is no longer the one run.
 */
function currentEntry(harness: HarnessId): Entry | undefined {
  const entry = cache.get(harness)
  const cli = READERS[harness]?.cli
  if (entry && cli && entry.bin !== resolveCli(cli)) {
    cache.delete(harness)
    return undefined
  }
  return entry
}

function refresh(harness: HarnessId): Promise<void> {
  const reader = READERS[harness]
  if (!reader) return Promise.resolve()
  const running = inflight.get(harness)
  if (running) return running
  const p = { verifiedAt: today(), source: '' }
  const bin = reader.cli ? resolveCli(reader.cli) : null
  const job = reader.read(p)
    .catch(() => null)
    .then(async models => {
      const prev = cache.get(harness)?.bin === bin ? cache.get(harness) : undefined
      // The fallback is read only when the source said nothing, and never allowed to fail the refresh.
      const partial = models || !reader.fallback ? (prev?.partial ?? null) : await reader.fallback(p).catch(() => null)
      // A failed read keeps the last good list rather than dropping back to the table — a CLI that
      // is offline for a minute has not stopped offering its models. It is also asked again SOON
      // (`catalogStale`): a failure is a fact about the moment, never worth six hours.
      cache.set(harness, {
        at: clock(),
        ok: models !== null,
        failures: models !== null ? 0 : (prev?.failures ?? 0) + 1,
        models: models ?? prev?.models ?? null,
        partial: partial ?? prev?.partial ?? null,
        bin,
      })
    })
    .finally(() => inflight.delete(harness))
  inflight.set(harness, job)
  return job
}

function stale(harness: HarnessId, entry: Entry | undefined): boolean {
  const reader = READERS[harness]
  return !!reader && catalogStale(entry, reader.ttl, clock())
}

/** The catalog NOW, never waiting. A stale or cold entry starts a background refresh. */
export function peekModelCatalog(harness: HarnessId): ModelCatalog {
  const entry = currentEntry(harness)
  if (stale(harness, entry)) void refresh(harness)
  return answerFrom(harness, entry)
}

/**
 * The catalog, waiting for a read that is cheap (a FILE) and never for a command: a cold command
 * source answers with the table this once and fills in behind it.
 */
export async function modelCatalog(harness: HarnessId): Promise<ModelCatalog> {
  const entry = currentEntry(harness)
  if (stale(harness, entry)) {
    const job = refresh(harness)
    if (READERS[harness]!.ttl === FILE_TTL_MS) await job
  }
  return answerFrom(harness, currentEntry(harness))
}

/** Warm every command-backed source once, so the first wizard open already has the CLI's list. */
export function warmModelCatalogs(): void {
  for (const h of HARNESS_ORDER) if (READERS[h]) void refresh(h)
}

/** Test seam: forget everything. */
export function resetModelCatalogForTests(): void {
  cache.clear()
  inflight.clear()
  clock = Date.now
  resolveCli = name => Bun.which(name, { PATH: catalogCliPath() })
  for (const [h, src] of Object.entries(ORIGINAL_READERS) as [HarnessId, Source][]) READERS[h] = src
}

const ORIGINAL_READERS: Partial<Record<HarnessId, Source>> = { ...READERS }

/** Test seam: replace one harness's source (and the clock the TTLs are measured on). */
export function setModelReaderForTests(harness: HarnessId, read: Reader, now?: () => number, fallback?: Reader): void {
  const cli = ORIGINAL_READERS[harness]?.cli
  READERS[harness] = { ttl: COMMAND_TTL_MS, read, ...(cli ? { cli } : {}), ...(fallback ? { fallback } : {}) }
  if (now) clock = now
}

/** Test seam: how a CLI name resolves to a binary (the cache is keyed on the answer). */
export function setCliResolverForTests(resolve: (name: string) => string | null): void {
  resolveCli = resolve
}
