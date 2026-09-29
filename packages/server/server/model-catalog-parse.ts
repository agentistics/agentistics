/**
 * model-catalog-parse.ts — PURE: what each harness's OWN model list says, read off the file or the
 * command output the CLI itself writes. See docs/superpowers/specs/2026-09-29-harness-model-catalog-design.md.
 *
 * Every reader answers `null` for "this source said nothing usable" — a missing file, junk, an
 * unexpected shape or an empty list. `null` is never an error here: the caller falls back to the
 * verified table (`HARNESS_MODELS`), because a catalog is only ever a BETTER list, never a
 * precondition. Several of these are undocumented caches, so an unexpected shape is the expected
 * failure and must never throw.
 */

import type { ModelOption } from '@agentistics/core'

/** Provenance stamped onto every discovered model — the day it was read and where from. */
export interface CatalogProvenance {
  verifiedAt: string
  source: string
}

function option(id: string, label: string, p: CatalogProvenance): ModelOption {
  return { id, label: label || id, verifiedAt: p.verifiedAt, source: p.source }
}

function nonEmpty(list: ModelOption[]): ModelOption[] | null {
  return list.length > 0 ? list : null
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Dedupe by id, first occurrence wins. */
function uniq(list: ModelOption[]): ModelOption[] {
  const seen = new Set<string>()
  return list.filter(m => (seen.has(m.id) ? false : (seen.add(m.id), true)))
}

/**
 * Claude Code's `~/.claude/cache/model-catalog/*.json` — its own cache of what the signed-in
 * account may run. Several files can exist (one per account/org); the one fetched most recently
 * describes the account in use now. A corrupt file is skipped, never allowed to hide a good one.
 * `main` rows (what `/model` shows first) are listed before `overflow`.
 */
export function parseClaudeModelCatalog(texts: string[], p: CatalogProvenance): ModelOption[] | null {
  let best: { at: number; models: unknown[] } | null = null
  for (const text of texts) {
    const doc = parseJson(text)
    if (!isRecord(doc) || !isRecord(doc.catalog) || !isRecord(doc.catalog.config)) continue
    const models = doc.catalog.config.models
    if (!Array.isArray(models)) continue
    const at = typeof doc.fetchedAt === 'number' ? doc.fetchedAt : 0
    if (!best || at > best.at) best = { at, models }
  }
  if (!best) return null
  const rows = best.models.filter(isRecord).flatMap(m => {
    const id = typeof m.id === 'string' ? m.id.trim() : ''
    if (!id) return []
    return [{ id, label: typeof m.name === 'string' ? m.name.trim() : '', main: m.section !== 'overflow' }]
  })
  const ordered = [...rows.filter(r => r.main), ...rows.filter(r => !r.main)]
  return nonEmpty(uniq(ordered.map(r => option(r.id, r.label, p))))
}

/**
 * Codex's `~/.codex/models_cache.json`. Only `visibility: 'list'` is offered: `hide` rows are
 * internal models (`codex-auto-review`, `gpt-reserve`) the CLI's own picker does not show either.
 */
export function parseCodexModelsCache(text: string, p: CatalogProvenance): ModelOption[] | null {
  const doc = parseJson(text)
  if (!isRecord(doc) || !Array.isArray(doc.models)) return null
  const list = doc.models.filter(isRecord).flatMap(m => {
    const id = typeof m.slug === 'string' ? m.slug.trim() : ''
    if (!id || m.visibility !== 'list') return []
    return [option(id, typeof m.display_name === 'string' ? m.display_name.trim() : '', p)]
  })
  return nonEmpty(uniq(list))
}

/** `agy models`: `<id>\t<display name>` per line, after a `Fetching available models...` banner. */
export function parseAgyModels(stdout: string, p: CatalogProvenance): ModelOption[] | null {
  const list = stdout.split('\n').flatMap(line => {
    const tab = line.indexOf('\t')
    if (tab <= 0) return []
    const id = line.slice(0, tab).trim()
    if (!id || /\s/.test(id)) return []
    return [option(id, line.slice(tab + 1).trim(), p)]
  })
  return nonEmpty(uniq(list))
}

/** An id is one token with no spaces — an error sentence is not a model. */
const MODEL_ID = /^[\w.:@-]+(?:\/[\w.:@[\]-]+)+$/

/**
 * `opencode models`: one `provider/model` id per line, no display name. ANY line that is not an id
 * makes the whole answer void — a list half made of an error message is worse than the table.
 */
export function parseOpencodeModels(stdout: string, p: CatalogProvenance): ModelOption[] | null {
  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.some(l => !MODEL_ID.test(l))) return null
  return nonEmpty(uniq(lines.map(id => option(id, id, p))))
}

/**
 * Kimi's `~/.kimi-code/config.toml`. `kimi -m` takes a model ALIAS the user configured, so the
 * `[models."<alias>"]` table headers ARE the list. Read by pattern rather than a TOML parser: only
 * the header lines are needed, and all three key spellings TOML allows are accepted.
 */
export function parseKimiModelAliases(toml: string, p: CatalogProvenance): ModelOption[] | null {
  const list = toml.split('\n').flatMap(line => {
    const m = /^\s*\[models\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\]\s*$/.exec(line)
    const id = m ? (m[1] ?? m[2] ?? m[3] ?? '').trim() : ''
    return id ? [option(id, id, p)] : []
  })
  return nonEmpty(uniq(list))
}

/**
 * A model id that may be handed to a CLI as an argv VALUE. One token, no spaces, and never
 * beginning with `-` — a value that looks like a flag is how `--model --something` turns a picker
 * into a way of passing an option nobody chose.
 */
export function isSafeModelId(id: string): boolean {
  return id.length > 0 && id.length <= 200 && /^[\w.:@/[\]-]+$/.test(id) && !id.startsWith('-')
}

/**
 * The model a chat request actually runs. A listed id is taken as asked; an UNLISTED id is taken
 * only where the list is the incomplete fallback table (`freeText`) and it is a safe argv value;
 * anything else falls back to the caller's default, and `''` means "pass no --model at all" —
 * the CLI's own default, never an invented one.
 */
export function resolveChatModel(
  requested: string | undefined,
  catalog: { models: { id: string }[]; freeText: boolean },
  fallback: string,
): string {
  const want = requested?.trim() ?? ''
  if (want && catalog.models.some(m => m.id === want)) return want
  if (want && catalog.freeText && isSafeModelId(want)) return want
  return isSafeModelId(fallback) ? fallback : ''
}
