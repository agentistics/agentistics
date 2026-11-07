/**
 * opencode-models.ts — where an OpenCode route's CONTEXT WINDOW comes from.
 *
 * The ring and the leader's counter both need a window. OpenCode states one in two places and the
 * adapter used to read only the first:
 *  1. its models.dev cache (`<cache>/opencode/models.json`): `{provider: {models: {id: {limit: {context}}}}}`;
 *  2. the user's OWN config (`opencode.json[c]`): `provider.<id>.models.<id>.limit.context` — the only
 *     place a custom or local route (an Ollama container, an OpenAI-compatible gateway) can be given
 *     one, and exactly the routes the cache has no row for (measured: `ollama/qwen-coder`).
 * A route stated nowhere stays WITHOUT a window — a guessed one is a wrong percentage.
 *
 * Pure: the IO (finding and reading the files) lives in `opencode.ts`.
 */
import type { OpencodeModels } from './opencode-parse'

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Strip `//` and block comments and trailing commas from a JSONC document, leaving strings alone. */
export function parseJsonc(text: string): unknown {
  let out = '', i = 0
  while (i < text.length) {
    const c = text[i]!, n = text[i + 1]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1); i = j + 1
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2
    } else { out += c; i++ }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

/** The `limit.context` the user's own config gives each `provider/model`, as the catalog's shape. */
export function configModels(config: unknown): OpencodeModels {
  const out: OpencodeModels = {}
  const providers = isObj(config) && isObj(config.provider) ? config.provider : {}
  for (const [pid, p] of Object.entries(providers)) {
    const models = isObj(p) && isObj(p.models) ? p.models : {}
    for (const [mid, m] of Object.entries(models)) {
      const limit = isObj(m) && isObj(m.limit) ? m.limit : {}
      const context = typeof limit.context === 'number' && limit.context > 0 ? limit.context : undefined
      if (context === undefined) continue
      const entry = (out[pid] ??= { models: {} })
      entry.models![mid] = { limit: { context } }
    }
  }
  return out
}

/** The user's config OUTRANKS the cache: it is the deployment they actually run. */
export function mergeModels(catalog: OpencodeModels, config: OpencodeModels): OpencodeModels {
  const out: OpencodeModels = { ...catalog }
  for (const [pid, p] of Object.entries(config)) {
    out[pid] = { ...(out[pid] ?? {}), models: { ...(out[pid]?.models ?? {}), ...(p.models ?? {}) } }
  }
  return out
}
