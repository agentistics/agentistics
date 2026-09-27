/**
 * openai-compatible/client.ts — IO. The `ProviderClient` for the OpenAI Chat Completions PROTOCOL
 * (B5a.1), spoken by one host-configured ENDPOINT per client: OpenAI, OpenRouter, DeepSeek, LiteLLM,
 * 9router or Ollama (contract D1/D2). Mirrors `../anthropic/client.ts` and forks none of its rules:
 * spec docs/superpowers/specs/2026-09-25-runtime-b1-provider.md §4.1, §4.4, §4.5, §6, §7.
 *
 * **A HOLDER of the key** (`provider-secrets.lint.test.ts`): it calls `CredentialHandle.reveal()`
 * exactly once, inside the one expression that builds the request's bearer header, and the string
 * never lands in a variable that outlives that call, a log, a result or a capture (request headers
 * are never captured — the capturing fetch only ever sees the RESPONSE).
 *
 * **Nothing ambient.** The key comes from the injected `CredentialResolver`, the base URL and the
 * endpoint kind from `deps.endpoint` — all EXPLICIT on every construction. This module never reads
 * the process environment, so the variables the OpenAI SDK family falls back to cannot redirect a
 * request carrying our key to another host or swap another key in (the C-1 test proves it with
 * sentinels set in the environment).
 *
 * **No SDK, so no hidden retry.** There is no npm dependency here (contract D3): one `fetch` = one
 * `POST <baseUrl>/chat/completions` with `stream: false` = one `invokeOnce`. The `maxRetries: 0` rule
 * the Anthropic client has to STATE holds here by construction — nothing below can send a second
 * request — and the retry lives outside the client, in `../retry.ts` (§4.5).
 *
 * **Every fact is read from the RAW body** (`./raw.ts`): identity, served model, stop reason,
 * content, and the usage via `./usage.ts` — graded by who stated it (`usageCertainty`) and priced
 * only by what the endpoint itself said (`cost`). No table price, and never the fallback rate.
 */
import { classifyProviderError, type ClassifierInput, type EditPolicy, type ProviderError } from '@agentistics/core'
import { createCapturingFetch, writeCapture as defaultWriteCapture } from '../capture.ts'
import { allowlistOpenAICompatibleHeaders, readOpenAICompatibleExchange } from './raw.ts'
import type { OpenAICompatibleEndpointKind } from './usage.ts'
import type {
  CaptureRef,
  CredentialHandle,
  CredentialResolver,
  InvocationResult,
  ProviderClient,
  ProviderMessagePart,
  ProviderRequest,
  ProviderToolDecl,
  RawExchange,
} from '../client.ts'

/** Bumped on any mapping change (M §14 rule 1). */
const ADAPTER_VERSION = '1'

/**
 * Declared, UNVERIFIED — nobody has sent any of these endpoints an edited history and measured the
 * result, so every kind is `unverified` (read as NOT editable by `mayReplace`), except
 * `assistant-text`, which is `immutable` as a PRODUCT rule (CM §7), the same as Anthropic's.
 */
export const OPENAI_COMPATIBLE_EDIT_POLICY: EditPolicy = Object.freeze({
  provider: 'openai-compatible',
  kinds: Object.freeze({
    'tool-result': 'unverified',
    'tool-input': 'unverified',
    reasoning: 'unverified',
    'assistant-text': 'immutable',
  }),
  status: 'declared-unverified',
  source: 'B5a.1 — no measurement of history editing on any Chat Completions endpoint; '
    + 'assistant-text immutability is a product rule (CM §7).',
})

/** One host-configured endpoint of the protocol (contract D1/D2). Every field is EXPLICIT. */
export interface OpenAICompatibleEndpoint {
  /** The closed endpoint id (`openai`, `openrouter`, …) — also the `CredentialRef.id` it answers to. */
  id: string
  /** Validated and normalised by the HOST (https, or http to loopback only; no trailing slash). */
  baseUrl: string
  /** Drives the usage certainty grade; never inferred from the URL here. */
  kind: OpenAICompatibleEndpointKind
}

export interface OpenAICompatibleClientDeps {
  /** REQUIRED — injected by the host; the runtime has no key store to fall back on (D23). */
  resolver: CredentialResolver
  /** REQUIRED — where raw captures go (`writeCapture`'s `opts.dir`); the runtime has no default. */
  captureDir: string
  endpoint: OpenAICompatibleEndpoint
  fetch?: typeof fetch
  writeCapture?: typeof defaultWriteCapture
  now?: () => Date
  monotonicNow?: () => number
}

interface ResolvedDeps {
  resolver: CredentialResolver
  captureDir: string
  endpoint: OpenAICompatibleEndpoint
  fetchImpl: typeof fetch
  writeCapture: typeof defaultWriteCapture
  now: () => Date
  monotonicNow: () => number
}

function resolveDeps(deps: OpenAICompatibleClientDeps): ResolvedDeps {
  return {
    resolver: deps.resolver,
    captureDir: deps.captureDir,
    endpoint: deps.endpoint,
    fetchImpl: deps.fetch ?? fetch,
    writeCapture: deps.writeCapture ?? defaultWriteCapture,
    now: deps.now ?? (() => new Date()),
    monotonicNow: deps.monotonicNow ?? (() => performance.now()),
  }
}

// ---------------------------------------------------------------------------
// ProviderRequest -> the Chat Completions body. A WIRE-FORMAT translation only (spec §4.6: B1
// rewrites no history). Chat Completions puts a tool call on the ASSISTANT message's `tool_calls` and
// each result in its own `role: 'tool'` message, so a user turn carrying `tool_result` parts splits
// into those tool messages (first — they must directly follow the call) and a user message for any
// text beside them. Text parts are never joined: one part is sent as a string, several as an array
// of text parts, so no separator is ever invented. Cache marks are NOT sent: this wire has no
// `cache_control` (OpenAI caches automatically, research 12 §2.6), and a field a server does not
// know is one it may reject.
// ---------------------------------------------------------------------------

type TextPart = Extract<ProviderMessagePart, { type: 'text' }>
type ToolUsePart = Extract<ProviderMessagePart, { type: 'tool_use' }>
type ToolResultPart = Extract<ProviderMessagePart, { type: 'tool_result' }>

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | Array<{ type: 'text'; text: string }> }
  | {
      role: 'assistant'
      content: string | Array<{ type: 'text'; text: string }> | null
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
    }
  | { role: 'tool'; tool_call_id: string; content: string }

function textContent(parts: TextPart[]): string | Array<{ type: 'text'; text: string }> {
  return parts.length === 1 ? parts[0]!.text : parts.map(p => ({ type: 'text' as const, text: p.text }))
}

/** `JSON.stringify` of a tool input — the wire wants a JSON STRING (research 12 trap 10). A value that
 *  cannot be serialised (never produced by this product) is sent as `{}` rather than throwing. */
function argumentsOf(input: unknown): string {
  try {
    return JSON.stringify(input ?? {}) ?? '{}'
  } catch {
    return '{}'
  }
}

/** Tool results as `role: 'tool'` messages. Chat Completions has no error flag on a tool result, so
 *  `isError` is not representable; the content is sent verbatim, never prefixed with invented text. */
function toolMessages(parts: ToolResultPart[]): ChatMessage[] {
  return parts.map(p => ({ role: 'tool' as const, tool_call_id: p.toolUseId, content: p.content }))
}

/** `system` + `ProviderMessage[]` -> Chat Completions `messages`. Pure. */
export function mapChatMessages(req: Pick<ProviderRequest, 'system' | 'messages'>): ChatMessage[] {
  const out: ChatMessage[] = []
  if (req.system !== undefined) out.push({ role: 'system', content: req.system })

  for (const message of req.messages) {
    if (typeof message.content === 'string') {
      out.push(message.role === 'assistant'
        ? { role: 'assistant', content: message.content }
        : { role: 'user', content: message.content })
      continue
    }
    const texts = message.content.filter((p): p is TextPart => p.type === 'text')
    const results = message.content.filter((p): p is ToolResultPart => p.type === 'tool_result')

    if (message.role === 'assistant') {
      const calls = message.content.filter((p): p is ToolUsePart => p.type === 'tool_use')
      const assistant: Extract<ChatMessage, { role: 'assistant' }> = {
        role: 'assistant',
        content: texts.length > 0 ? textContent(texts) : null,
      }
      if (calls.length > 0) {
        assistant.tool_calls = calls.map(c => ({
          id: c.id, type: 'function' as const, function: { name: c.name, arguments: argumentsOf(c.input) },
        }))
      }
      out.push(assistant)
      // A tool_result under the assistant role is not a shape B1 emits; carried rather than dropped.
      out.push(...toolMessages(results))
      continue
    }

    out.push(...toolMessages(results))
    if (texts.length > 0) out.push({ role: 'user', content: textContent(texts) })
  }
  return out
}

/** `ProviderToolDecl[]` -> Chat Completions `tools`. Declarations only — B1 executes nothing. */
export function mapChatTools(tools: ProviderToolDecl[] | undefined) {
  if (!tools || tools.length === 0) return undefined
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      parameters: t.inputSchema,
    },
  }))
}

/** The request body. `stream: false` is stated, never left to a server default. */
export function buildChatBody(req: ProviderRequest): Record<string, unknown> {
  const tools = mapChatTools(req.tools)
  return {
    model: req.model,
    messages: mapChatMessages(req),
    max_tokens: req.maxTokens,
    stream: false,
    ...(tools !== undefined ? { tools } : {}),
  }
}

/** `<baseUrl>/chat/completions`. The host already normalised the base URL; trailing slashes are
 *  stripped once more so a hand-built deps object cannot produce `//chat/completions`. */
export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
}

async function tryWriteCapture(ex: RawExchange, d: ResolvedDeps): Promise<CaptureRef | undefined> {
  try {
    return await d.writeCapture(ex, { dir: d.captureDir })
  } catch {
    return undefined
  }
}

function invalidMaxTokensError(): ProviderError {
  return { kind: 'invalid-request', retryable: false, usageOutcome: 'none-reported', userCode: 'provider.request_invalid' }
}

/** No usable credential, or a ref naming a DIFFERENT endpoint than this client talks to — no request
 *  left, so `none-reported` (the Anthropic client's own mapping of the same refusal). */
function credentialRefusalError(): ProviderError {
  return { kind: 'authentication', retryable: false, usageOutcome: 'none-reported', userCode: 'provider.no_credential' }
}

/**
 * Decide the credential for this call, or refuse. Never throws.
 *
 * - The ref must name THIS protocol and THIS endpoint. A key stored for `openai` handed to a client
 *   pointed at `openrouter` would be sent to the wrong host, so the pair is checked here, before the
 *   resolver is even asked.
 * - A `local` endpoint (Ollama) may be KEYLESS: an `absent` resolution there means "send no bearer".
 *   Every other refusal (unreadable, too-open, wrong-provider) is a refusal even locally — a key file
 *   that exists but cannot be trusted never silently downgrades to a keyless call.
 */
async function decideCredential(
  req: ProviderRequest,
  d: ResolvedDeps,
): Promise<{ ok: true; handle: CredentialHandle | null } | { ok: false }> {
  if (req.credential.provider !== 'openai-compatible' || req.credential.id !== d.endpoint.id) return { ok: false }
  let resolution
  try {
    resolution = await d.resolver.resolve(req.credential)
  } catch {
    return { ok: false }
  }
  if (resolution.ok) return { ok: true, handle: resolution.handle }
  if (resolution.reason === 'absent' && d.endpoint.kind === 'local') return { ok: true, handle: null }
  return { ok: false }
}

/** Sends the one request. The key is unwrapped INSIDE the headers expression and nowhere else. */
async function send(
  req: ProviderRequest,
  handle: CredentialHandle | null,
  d: ResolvedDeps,
  capturingFetch: typeof fetch,
): Promise<{ ok: true } | { ok: false; err: unknown }> {
  try {
    const response = await capturingFetch(chatCompletionsUrl(d.endpoint.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(handle !== null ? { authorization: `Bearer ${handle.reveal()}` } : {}),
      },
      body: JSON.stringify(buildChatBody(req)),
      signal: req.signal,
    })
    // The capturing fetch already read the body through a clone; release this copy.
    await response.body?.cancel().catch(() => {})
    return { ok: true }
  } catch (err) {
    return { ok: false, err }
  }
}

/** The client's core. Exported so tests (and `retry.ts`) can inject deps directly. Never throws. */
export async function invokeOpenAICompatibleOnce(
  req: ProviderRequest,
  attempt: number,
  deps: OpenAICompatibleClientDeps,
): Promise<InvocationResult> {
  const d = resolveDeps(deps)
  const startedAt = d.now().toISOString()
  const startMono = d.monotonicNow()
  const elapsed = () => d.monotonicNow() - startMono

  const common = {
    invocationId: req.correlation.invocationId,
    attempt,
    provider: 'openai-compatible' as const,
    requestedModel: req.model,
    startedAt,
  }
  const failed = (error: ProviderError, extra: { requestId?: string; capture?: CaptureRef } = {}): InvocationResult => ({
    ...common,
    latencyMs: elapsed(),
    status: 'failed',
    error,
    ...(extra.requestId !== undefined ? { requestId: extra.requestId } : {}),
    ...(extra.capture !== undefined ? { capture: extra.capture } : {}),
  })

  try {
    if (!Number.isInteger(req.maxTokens) || req.maxTokens <= 0) return failed(invalidMaxTokensError())

    const credential = await decideCredential(req, d)
    if (!credential.ok) return failed(credentialRefusalError())

    const capturing = createCapturingFetch(d.fetchImpl, allowlistOpenAICompatibleHeaders)
    const outcome = await send(req, credential.handle, d, capturing.fetch)
    const exchanges = capturing.exchanges()

    if (!outcome.ok && exchanges.length === 0) {
      const classifier: ClassifierInput = isAbort(outcome.err, req.signal)
        ? { transport: 'aborted' }
        : capturing.requestSent()
          ? { transport: 'network', requestSent: true }
          : { sdkRejected: true, requestSent: false }
      return failed(classifyProviderError(classifier))
    }

    // One `invokeOnce` = one HTTP request (spec §4.1). With no SDK this cannot be anything but one;
    // checked anyway, because a wrong count is exactly what this layer promises never to hide.
    if (exchanges.length !== 1) {
      const ex = exchanges[0]!
      const requestId = ex.headers['x-request-id']
      const capture = await tryWriteCapture(ex, d)
      const classifier: ClassifierInput = { responseUnreadable: true }
      if (requestId !== undefined) classifier.requestIdHeader = requestId
      return failed(classifyProviderError(classifier), { requestId, capture })
    }

    const ex = exchanges[0]!
    const capture = await tryWriteCapture(ex, d)
    const read = readOpenAICompatibleExchange(ex, d.endpoint.kind)
    if (!read.ok) return failed(classifyProviderError(read.classifier), { requestId: read.requestId, capture })

    return {
      ...common,
      latencyMs: elapsed(),
      status: 'completed',
      messageId: read.messageId,
      servedModel: read.servedModel,
      usage: read.usage,
      usageAnomalies: read.usageAnomalies,
      stopReason: read.stopReason,
      content: read.content,
      usageCertainty: read.usageCertainty,
      cost: read.cost,
      usageNotes: read.usageNotes,
      ...(read.requestId !== undefined ? { requestId: read.requestId } : {}),
      ...(capture !== undefined ? { capture } : {}),
    }
  } catch {
    // Unreachable by construction (every step above is total); a last net so the "never throws"
    // contract does not rest on that reasoning alone. No error text is read — it could quote anything.
    return failed(classifyProviderError({}))
  }
}

/** Builds a `ProviderClient` for ONE endpoint — the host binds resolver, capture dir and endpoint. */
export function createOpenAICompatibleClient(deps: OpenAICompatibleClientDeps): ProviderClient {
  return {
    provider: 'openai-compatible',
    adapterVersion: ADAPTER_VERSION,
    capabilities: { streaming: false, editPolicy: OPENAI_COMPATIBLE_EDIT_POLICY },
    invokeOnce: (req, attempt) => invokeOpenAICompatibleOnce(req, attempt, deps),
  }
}
