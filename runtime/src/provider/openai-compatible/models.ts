/**
 * provider/openai-compatible/models.ts — listing models from an OpenAI-compatible endpoint (B5a.3,
 * D5 of the shared B5a contract).
 *
 * No SDK, no hardcoded model list anywhere: `createModelLister` issues ONE `GET <baseUrl>/models`
 * over the injected `fetch` (D3's own rule — the same shape the chat-completions call follows) and
 * `parseModelList` turns whatever comes back into `ListedModel[]`, defensively. Every id this
 * module ever reports came from the endpoint's own answer, not from a table in this file.
 *
 * Documented top-level shapes, verified 2026-09-27 — every one of them is `{ data: [...] }`, never
 * a bare array:
 * - **OpenAI** `GET /v1/models`: `{object:'list', data:[{id, object:'model', created, owned_by}]}`
 *   (https://platform.openai.com/docs/api-reference/models/list — a live fetch of that page 403'd
 *   here on 2026-09-27, Cloudflare bot-blocking the request; the shape is nonetheless confirmed
 *   below, byte for byte, since Ollama's own OpenAI-compatibility layer emits the identical struct).
 * - **OpenRouter** `GET /api/v1/models`: `{data:[{id, canonical_slug, name, created,
 *   context_length, pricing:{…}, top_provider:{…}, …}], total_count, links}`
 *   (https://openrouter.ai/docs/overview/models, fetched 2026-09-27).
 * - **Ollama** `/v1/models`: the OpenAI shape exactly. Verified against
 *   github.com/ollama/ollama, file `openai/openai.go` (`main`, fetched 2026-09-27):
 *   `type Model struct { Id string \`json:"id"\`; Object string \`json:"object"\`; Created int64
 *   \`json:"created"\`; OwnedBy string \`json:"owned_by"\` }` wrapped in
 *   `type ListCompletion struct { Object string \`json:"object"\`; Data []Model \`json:"data"\` }`.
 *
 * No provider was found documenting a bare array for this endpoint (DeepSeek and the router
 * endpoints — 9router, litellm — were not independently checked; D2 only grades their CERTAINTY,
 * it does not claim their model-list shape, and this reader treats all six endpoints the same
 * OpenAI-compatible way). A bare array is therefore refused (`bad-shape`) rather than guessed at —
 * accepting an unverified shape here would be exactly the kind of guess `docs/harness-contract.md`
 * refuses elsewhere in this repo.
 */
import type { CredentialHandle } from '../credential.ts'

/** One entry of an endpoint's model list. Every field but `id` is reported only when the source
 *  body states it in a form this reader trusts (see `parseModelList`) — never inferred. */
export interface ListedModel {
  id: string
  ownedBy?: string
  contextLength?: number
  created?: number
}

export type ModelListResult =
  | { ok: true; models: ListedModel[]; fetchedAt: string; fromCache: boolean; dropped: number }
  | {
      ok: false
      reason: 'http-error' | 'network' | 'not-json' | 'bad-shape' | 'unauthorized'
      status?: number
    }

/**
 * PURE. `body` is the whole parsed JSON response. Returns `null` when the top-level shape is not
 * `{ data: [...] }` — "anything else in the top-level shape → null" (D5) covers a bare array, a
 * scalar, `undefined`/`null`, or an object with no `data` array.
 *
 * Per-entry rules, applied to every item of `data`:
 * - A non-object entry, or one with no non-empty string `id`, is DROPPED and counted in `dropped`.
 *   This is the only thing `dropped` counts — a de-duplicated repeat below is not itself an invalid
 *   entry, so it is removed silently and does not inflate the count.
 * - Ids are DE-DUPLICATED: the first occurrence of a given `id` wins; every later repeat of that
 *   id is discarded (its fields are never merged into the kept entry — half-updating a model from
 *   a duplicate row is the same "half-read is worse than none" rule this repo applies to a parsed
 *   dialog option).
 * - `contextLength` is read from `context_length` ONLY when it is a finite, positive number —
 *   D5's own words. Anything else (a string, `0`, negative, `NaN`, missing) leaves the field unset.
 * - `created` is read from `created` only when it is a finite number (no positivity requirement is
 *   documented for it, unlike `context_length`).
 * - `ownedBy` is read from `owned_by` only when it is a non-empty string.
 * - The result is sorted by `id` (plain string ordering), so the same set of models always renders
 *   in the same order regardless of the endpoint's own ordering or a cache hit/miss.
 */
export function parseModelList(body: unknown): { models: ListedModel[]; dropped: number } | null {
  if (typeof body !== 'object' || body === null) return null
  const data = (body as Record<string, unknown>)['data']
  if (!Array.isArray(data)) return null

  const seen = new Map<string, ListedModel>()
  let dropped = 0

  for (const raw of data) {
    if (typeof raw !== 'object' || raw === null) {
      dropped += 1
      continue
    }
    const rec = raw as Record<string, unknown>
    const id = rec['id']
    if (typeof id !== 'string' || id.length === 0) {
      dropped += 1
      continue
    }
    if (seen.has(id)) continue // first occurrence wins; a repeat is not an invalid entry

    const model: ListedModel = { id }

    const ownedBy = rec['owned_by']
    if (typeof ownedBy === 'string' && ownedBy.length > 0) model.ownedBy = ownedBy

    const contextLength = rec['context_length']
    if (typeof contextLength === 'number' && Number.isFinite(contextLength) && contextLength > 0) {
      model.contextLength = contextLength
    }

    const created = rec['created']
    if (typeof created === 'number' && Number.isFinite(created)) model.created = created

    seen.set(id, model)
  }

  const models = [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { models, dropped }
}

export interface ModelListerDeps {
  fetch: typeof fetch
  now?: () => number
  ttlMs?: number
}

export interface ModelListArgs {
  endpointId: string
  baseUrl: string
  /** The opaque handle over the endpoint's key, or `null` for a keyless endpoint (Ollama stored
   *  with `--no-key`). Never the key itself: the key is revealed ONLY inside `list()`, at the one
   *  expression that builds the request header, and is never assigned, cached, logged or returned. */
  credential: CredentialHandle | null
  signal?: AbortSignal
}

export interface ModelLister {
  list(args: ModelListArgs): Promise<ModelListResult>
}

interface CacheEntry {
  models: ListedModel[]
  dropped: number
  fetchedAt: string
  storedAt: number
}

/** D5's own default — a short TTL, because a stale model list is a wrong choice in a picker, not
 *  a wrong number in a report. */
const DEFAULT_TTL_MS = 60_000

/** Not part of D5 — a request timeout has to exist somewhere, and "never throws" (D5) means this
 *  reader cannot leave a hung socket to answer the caller's own timeout instead. Bounded well under
 *  any interactive use of `agentop provider models`. */
const REQUEST_TIMEOUT_MS = 10_000

/**
 * Builds a lister over `deps.fetch`. Cache key is `endpointId + '\0' + baseUrl` — NEVER the key,
 * and NEVER a raw response body: only a previously successful `{models, dropped, fetchedAt}` is
 * ever stored, so a cache hit can echo back exactly what a fresh call would have said. A failure
 * (any `ok: false` branch) is never cached — the next call always tries again.
 */
export function createModelLister(deps: ModelListerDeps): ModelLister {
  const fetchImpl = deps.fetch
  const now = deps.now ?? (() => Date.now())
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS
  const cache = new Map<string, CacheEntry>()

  async function list(args: ModelListArgs): Promise<ModelListResult> {
    const key = `${args.endpointId}\0${args.baseUrl}`
    const cached = cache.get(key)
    if (cached !== undefined && now() - cached.storedAt < ttlMs) {
      return {
        ok: true,
        models: cached.models,
        fetchedAt: cached.fetchedAt,
        fromCache: true,
        dropped: cached.dropped,
      }
    }

    try {
      const headers: Record<string, string> = { Accept: 'application/json' }
      // A Bearer header is added only with a key — D6: ollama may be stored keyless, and a header
      // reading `Bearer ` with nothing after it is worse than no header at all.
      // The key is revealed HERE and nowhere else — inline, into the header this request sends.
      if (args.credential !== null) {
        headers['Authorization'] = `Bearer ${args.credential.reveal()}`
      }

      const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      const signal = args.signal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, args.signal])

      const response = await fetchImpl(`${args.baseUrl}/models`, { headers, signal })

      if (!response.ok) {
        // Never echo the body on a failure (D5) — only the status code, which is never a secret.
        if (response.status === 401 || response.status === 403) {
          return { ok: false, reason: 'unauthorized', status: response.status }
        }
        return { ok: false, reason: 'http-error', status: response.status }
      }

      let body: unknown
      try {
        body = await response.json()
      } catch {
        return { ok: false, reason: 'not-json' }
      }

      const parsed = parseModelList(body)
      if (parsed === null) return { ok: false, reason: 'bad-shape' }

      const fetchedAt = new Date(now()).toISOString()
      cache.set(key, { models: parsed.models, dropped: parsed.dropped, fetchedAt, storedAt: now() })
      return { ok: true, models: parsed.models, fetchedAt, fromCache: false, dropped: parsed.dropped }
    } catch {
      // Any throw — a network failure, a timeout abort, a malformed URL — is 'network' (D5's own
      // word). Never throws out of this function.
      return { ok: false, reason: 'network' }
    }
  }

  return { list }
}
