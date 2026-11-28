/**
 * hermesModel.ts — PURE: the model id Hermes writes, in the spelling the price table knows.
 *
 * Hermes names a model `provider:model` (its ACP picker, `acp_adapter/model_catalog.py`
 * `encode_model_choice`) and its `state.db` may hold that form, a route (`anthropic/claude-…`,
 * `openrouter/…`) or a bare id. The provider prefix is only stripped when the left side is a
 * provider id or alias Hermes itself knows (`hermes_cli/models.py` `parse_model_input`: "the colon is
 * a provider delimiter only when the left side is a known provider/alias"), so a `model:tag` such as
 * `llama3:8b` stays whole.
 *
 * **Whether a model is LOCAL (free) is decided by who billed it, never by its name.** Hermes writes
 * `sessions.model` without the provider (`agent/turn_usage.py`) and records it apart, in
 * `billing_provider`; paid Ollama Cloud uses the same `name:tag` ids a local runtime does. A
 * local-looking model with any other billing provider, or none, is UNPRICED.
 *
 * **`custom` is ALWAYS unpriced, on localhost or not.** It names an endpoint and not who is behind
 * it — a localhost proxy to a paid service is common — and Hermes itself bills it as "unknown"
 * (`agent/usage_pricing.py`). Hermes also records a local Ollama / vLLM / llama.cpp as `custom`
 * (`hermes_cli/providers.py`), so those read as unpriced too: accepted, rather than guessing.
 *
 * Provider ids: `plugins/model-providers/*` and `_PROVIDER_ALIASES` of hermes-agent @1e0c7730
 * (2026-10-08).
 */
import { isLocalModelId } from './local-models'
import { MODEL_PRICING, canonicalModelId, hasModelPrice } from './types'

const HERMES_PROVIDERS: ReadonlySet<string> = new Set((
  'actual ai-gateway alibaba alibaba-coding-plan anthropic arcee azure-foundry bedrock commandcode copilot copilot-acp ' +
  'custom deepinfra deepseek fireworks gemini gmi huggingface kilocode kimi-coding kimi-coding-cn lmstudio meta-ai ' +
  'minimax minimax-cn minimax-oauth nebius-token-factory nous novita nvidia ollama-cloud openai openai-codex ' +
  'opencode-go opencode-zen openrouter qwen-oauth router solstice stepfun tencent-tokenhub tencent-tokenplan upstage ' +
  'vertex xai xai-oauth xiaomi zai ' +
  // aliases (`_PROVIDER_ALIASES`)
  'glm z-ai z.ai zhipu github github-copilot github-models github-model google google-gemini google-ai-studio ' +
  'google-vertex vertex-ai gcp-vertex vertexai kimi moonshot kimi-cn moonshot-cn step arcee-ai arceeai gmi-cloud ' +
  'gmicloud fireworks-ai fw nebius claude claude-code deep-seek opencode zen go aigateway vercel kilo kilo-code ' +
  'dashscope aliyun qwen alibaba-cloud qwen-portal hf hugging-face novita-ai mimo tencent tokenhub aws aws-bedrock ' +
  'amazon-bedrock amazon grok x-ai x.ai nim nvidia-nim lm-studio chatgpt chatgpt-codex ollama local vllm'
).split(' '))

/** A local-runtime model tag (`qwen:7b`, `llama3:latest`): the left side is a model name, not a provider. */
const MODEL_TAG = /^(latest|\d+(\.\d+)?[bm]([-_].*)?)$/i

/** A local runtime's name (as a model prefix or a billing provider) → the route `isLocalModelId` reads. */
const LOCAL_RUNTIMES: Readonly<Record<string, string>> = {
  ollama: 'ollama', lmstudio: 'lmstudio', 'lm-studio': 'lmstudio', lm_studio: 'lmstudio',
  llamacpp: 'llamacpp', 'llama.cpp': 'llamacpp', 'llama-cpp': 'llamacpp', local: 'local', vllm: 'local',
}

/** Who billed the session: `sessions.billing_provider`. */
export interface HermesBilling {
  provider?: string | null
}

/** `provider:model` → `model`; anything else unchanged. */
function withoutProvider(id: string): string {
  const m = /^([^:/]+):(.+)$/.exec(id)
  if (!m || !HERMES_PROVIDERS.has(m[1]!.toLowerCase()) || MODEL_TAG.test(m[2]!)) return id
  return m[2]!
}

/** A bare `name:tag`, a local runtime's spelling (`…-v1:0`, a Bedrock version, is not one). */
function isTagged(id: string): boolean {
  const rest = withoutProvider(id)
  const m = /^[^/]+:([^:/]+)$/.exec(rest)
  return !!m && !/^\d+$/.test(m[1]!)
}

/**
 * The id of a model that runs locally or only looks like it does; `null` = an ordinary hosted model.
 * A local id keeps its route (`ollama/llama3:8b`), the only thing saying the call was free. Paid
 * Ollama Cloud (also reached through a local daemon, as a `…cloud` tag) is `ollama-cloud/…`, and
 * anything else local-looking, and everything billed by `custom`, is `unpriced/…`: neither is ever
 * 0 nor a community-table price.
 */
function localLookingModel(id: string, billing: HermesBilling): string | null {
  const m = /^([^:/]+)[:/](.+)$/.exec(id)
  const prefix = m?.[1]!.toLowerCase()
  const named = prefix === 'ollama-cloud' ? undefined : prefix ? LOCAL_RUNTIMES[prefix] : undefined
  const name = named || prefix === 'ollama-cloud' ? m![2]! : id
  const provider = String(billing.provider ?? '').trim().toLowerCase()
  if (provider === 'ollama-cloud' || prefix === 'ollama-cloud' || /:([^/]*-)?cloud$/i.test(name)) return `ollama-cloud/${name}`
  if (provider === 'custom' || provider.startsWith('custom:')) return `unpriced/${withoutProvider(name)}`
  const local = LOCAL_RUNTIMES[provider]
  if (local) return `${named ?? local}/${name}`
  return named || isLocalModelId(id) || isTagged(id) ? `unpriced/${name}` : null
}

/**
 * The id a Hermes model is reported (and priced) under. A model the table knows comes out in the
 * table's spelling, so it merges with the same model from other harnesses; an unknown one keeps
 * what Hermes wrote (minus the provider prefix) and is shown as unpriced — never guessed.
 */
export function hermesModelId(raw: string | null | undefined, billing: HermesBilling = {}): string {
  // `custom:` is only Hermes' name for "my own endpoint": what follows it decides.
  const text = String(raw ?? '').trim().replace(/^custom:/i, '')
  if (!text) return ''
  const local = localLookingModel(text, billing)
  if (local) return local
  const id = withoutProvider(text)
  const segment = id.slice(id.lastIndexOf('/') + 1)
  if (MODEL_PRICING[segment]) return segment
  // Claude names come with dots from routers (`claude-sonnet-4.5`) and dashes in the table. Only for
  // Claude: the same rewrite would turn `gpt-5.1` into a different id.
  if (/(^|\.)(claude-|fable-|opus-|sonnet-|haiku-|mythos-)/i.test(segment)) {
    const canonical = canonicalModelId(id)
    if (canonical && hasModelPrice(canonical)) return canonical
  }
  return id
}
