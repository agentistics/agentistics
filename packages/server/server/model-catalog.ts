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
import {
  parseAgyModels,
  parseClaudeModelCatalog,
  parseCodexModelsCache,
  parseKimiModelAliases,
  parseOpencodeModels,
  type CatalogProvenance,
} from './model-catalog-parse'

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

/** Run a CLI with the user's usual bin dirs on PATH (a sidecar's PATH is often stripped). */
async function runCli(argv: string[]): Promise<string | null> {
  try {
    const env = { ...process.env }
    env.PATH = [process.env.PATH ?? '', join(HOME_DIR, '.local', 'bin'), join(HOME_DIR, '.bun', 'bin'), join(HOME_DIR, '.npm-global', 'bin')]
      .filter(Boolean).join(delimiter)
    const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', env })
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
const READERS: Partial<Record<HarnessId, { ttl: number; read: Reader }>> = {
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
    ttl: COMMAND_TTL_MS,
    read: async p => {
      const out = await runCli(['agy', 'models'])
      return out === null ? null : parseAgyModels(out, { ...p, source: 'agy models' })
    },
  },
  opencode: {
    ttl: COMMAND_TTL_MS,
    read: async p => {
      const out = await runCli(['opencode', 'models'])
      return out === null ? null : parseOpencodeModels(out, { ...p, source: 'opencode models' })
    },
  },
}

interface Entry { at: number; models: ModelOption[] | null }
const cache = new Map<HarnessId, Entry>()
const inflight = new Map<HarnessId, Promise<void>>()

function tableAnswer(harness: HarnessId): ModelCatalog {
  return { models: modelsFor(harness), source: 'table', freeText: true }
}

function answerFrom(harness: HarnessId, entry: Entry | undefined): ModelCatalog {
  return entry?.models ? { models: entry.models, source: 'cli', freeText: false } : tableAnswer(harness)
}

function refresh(harness: HarnessId): Promise<void> {
  const reader = READERS[harness]
  if (!reader) return Promise.resolve()
  const running = inflight.get(harness)
  if (running) return running
  const job = reader.read({ verifiedAt: today(), source: '' })
    .catch(() => null)
    .then(models => {
      // A failed read keeps the last good list rather than dropping back to the table — a CLI that
      // is offline for a minute has not stopped offering its models.
      const prev = cache.get(harness)
      cache.set(harness, { at: Date.now(), models: models ?? prev?.models ?? null })
    })
    .finally(() => inflight.delete(harness))
  inflight.set(harness, job)
  return job
}

function stale(harness: HarnessId, entry: Entry | undefined): boolean {
  const reader = READERS[harness]
  return !!reader && (!entry || Date.now() - entry.at > reader.ttl)
}

/** The catalog NOW, never waiting. A stale or cold entry starts a background refresh. */
export function peekModelCatalog(harness: HarnessId): ModelCatalog {
  const entry = cache.get(harness)
  if (stale(harness, entry)) void refresh(harness)
  return answerFrom(harness, entry)
}

/**
 * The catalog, waiting for a read that is cheap (a FILE) and never for a command: a cold command
 * source answers with the table this once and fills in behind it.
 */
export async function modelCatalog(harness: HarnessId): Promise<ModelCatalog> {
  const entry = cache.get(harness)
  if (stale(harness, entry)) {
    const job = refresh(harness)
    if (READERS[harness]!.ttl === FILE_TTL_MS) await job
  }
  return answerFrom(harness, cache.get(harness))
}

/** Warm every command-backed source once, so the first wizard open already has the CLI's list. */
export function warmModelCatalogs(): void {
  for (const h of HARNESS_ORDER) if (READERS[h]) void refresh(h)
}

/** Test seam: forget everything. */
export function resetModelCatalogForTests(): void {
  cache.clear()
  inflight.clear()
}
