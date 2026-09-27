/**
 * anthropic-models.ts — Anthropic's own model list, for the web settings screen's "test connection"
 * and model picker (UI.1).
 *
 * The runtime's `createModelLister` speaks the OpenAI-compatible `GET <baseUrl>/models` with a
 * bearer header, which is not how Anthropic authenticates an API key; nothing in
 * `@agentistics/runtime` lists Anthropic's models, and that package is not this item's to change.
 * So this one request lives here, beside the key store.
 *
 * It is NOT BILLED: `GET https://api.anthropic.com/v1/models` lists the models the key can use and
 * spends no tokens — which is exactly why "test connection" uses it instead of a one-word
 * completion (`agentop provider try anthropic` is the billed smoke test, and says so).
 *
 * HOLDER (`provider-secrets.lint.test.ts`): the opaque handle is revealed INLINE, in the one
 * expression that builds the request header, and the value is never assigned, cached, logged or
 * returned. The answer is `ModelListResult`, which has no field that could carry it, and a failure
 * reports a code and an HTTP status — never the response body.
 *
 * The host is the runtime's own constant (`ANTHROPIC_BASE_URL_CONSTANT`), never read from the
 * environment: redirecting the host a key is sent to is as good as reading the key.
 */
import {
  ANTHROPIC_BASE_URL_CONSTANT,
  parseModelList,
  type CredentialHandle,
  type ModelListResult,
} from '@agentistics/runtime'

/** The API version header every Anthropic request carries. */
export const ANTHROPIC_VERSION = '2023-06-01'
/** Anthropic pages this list (default 20); 1000 is its documented ceiling, one page for any key. */
const PAGE_LIMIT = 1000
const REQUEST_TIMEOUT_MS = 10_000

export async function listAnthropicModels(args: {
  credential: CredentialHandle
  fetch: typeof fetch
  now?: () => number
}): Promise<ModelListResult> {
  const now = args.now ?? (() => Date.now())
  try {
    const response = await args.fetch(`${ANTHROPIC_BASE_URL_CONSTANT}/models?limit=${PAGE_LIMIT}`, {
      headers: {
        Accept: 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
        'x-api-key': args.credential.reveal(),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // Bun forwards `x-api-key` across a cross-origin redirect (it strips only `Authorization`),
      // so a redirect here would hand the key to whoever the response points at (UI.4 N-1).
      redirect: 'error',
    })
    if (!response.ok) {
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
    return {
      ok: true,
      models: parsed.models,
      fetchedAt: new Date(now()).toISOString(),
      fromCache: false,
      dropped: parsed.dropped,
    }
  } catch {
    return { ok: false, reason: 'network' }
  }
}
