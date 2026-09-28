/**
 * google/client.ts — IO. The `ProviderClient` for Google's Gemini API (B5b.1): `generateContent` and
 * `streamGenerateContent?alt=sse` over the user's OWN API key. Mirrors `../openai-compatible/client.ts`
 * and forks none of its rules: spec docs/superpowers/specs/2026-09-25-runtime-b1-provider.md §4.1,
 * §4.4, §4.5, §6, §7; master §22.1, §22.3, §22.4.
 *
 * **A HOLDER of the key** (`provider-secrets.lint.test.ts`): it calls `CredentialHandle.reveal()`
 * exactly once per request, inside the one expression that builds that request's key header, and the
 * string never lands in a variable that outlives that call, a log, a result or a capture (request
 * headers are never captured — the capturing fetch only ever sees the RESPONSE).
 *
 * **Nothing ambient, and one credential kind.** The key comes from the injected `CredentialResolver`
 * and the host is `GOOGLE_BASE_URL_CONSTANT` — EXPLICIT on every request. This module never reads the
 * process environment, so the variables Google's own SDKs fall back to (an API key, a base URL, a
 * Vertex switch, a service-account file) cannot redirect a request carrying our key or swap another
 * credential in (`client.test.ts` proves it with sentinels set in the environment). It has no
 * user-login, token-exchange or application-default path at all: a Google AI Pro/Ultra SUBSCRIPTION
 * inside our loop is prohibited, with account suspension (master §22.4, geminicli.com/docs/resources/
 * tos-privacy), so the only credential this client can present is a key the user entered.
 *
 * **No SDK, so no hidden retry.** There is no npm dependency (the same choice B5a made): one `fetch` =
 * one POST = one `invokeOnce` / one `stream`. The `maxRetries: 0` rule the AI SDK has to STATE holds
 * by construction — nothing below can send a second request — and the retry lives outside the client,
 * in `../retry.ts` (§4.5): `decideRetry` never retries a possibly-billed (`usageOutcome: 'unknown'`)
 * outcome, and a mid-stream failure here is always `unknown`.
 *
 * **Every fact is read from the RAW body** (`./raw.ts`, `./raw-stream.ts`, `./usage.ts`). No table
 * price and never the fallback rate. No request id and no message id exists to adopt (`raw.ts`), so
 * every result is marked `correlationBasis: 'inferred'`.
 */
import { classifyProviderError, type ClassifierInput, type EditPolicy, type ProviderError } from '@agentistics/core'
import {
  createCapturingFetch,
  createStreamingCapturingFetch,
  writeCapture as defaultWriteCapture,
} from '../capture.ts'
import { createSseDecoder, type StreamBodyEnd } from '../anthropic/raw-stream.ts'
import { createToolCallAssembler as defaultCreateToolCallAssembler, type ToolCallAssembler } from '../tool-call-stream.ts'
import { allowlistGoogleHeaders, isPlainObject, readGoogleExchange } from './raw.ts'
import { createGoogleStreamReader } from './raw-stream.ts'
import type {
  CaptureRef,
  CredentialHandle,
  CredentialResolver,
  InvocationResult,
  ProviderClient,
  ProviderMessagePart,
  ProviderRequest,
  ProviderStreamEvent,
  ProviderToolDecl,
  RawExchange,
} from '../client.ts'

/** Google's Gemini API base — OURS, never read from the environment (module doc). */
export const GOOGLE_BASE_URL_CONSTANT = 'https://generativelanguage.googleapis.com/v1beta'

/** Bumped on any mapping change (M §14 rule 1). */
const ADAPTER_VERSION = '1'

/**
 * Declared, UNVERIFIED — nobody has sent Gemini an edited history and measured the result (and Gemini
 * 3 documents signed thought parts, which is a reason for caution, not a measurement), so every kind
 * is `unverified` (read as NOT editable by `mayReplace`), except `assistant-text`, `immutable` as a
 * PRODUCT rule (CM §7), the same as Anthropic's.
 */
export const GOOGLE_EDIT_POLICY: EditPolicy = Object.freeze({
  provider: 'google',
  kinds: Object.freeze({
    'tool-result': 'unverified',
    'tool-input': 'unverified',
    reasoning: 'unverified',
    'assistant-text': 'immutable',
  }),
  status: 'declared-unverified',
  source: 'B5b.1 — no measurement of history editing against the Gemini API; '
    + 'assistant-text immutability is a product rule (CM §7).',
})

export interface GoogleClientDeps {
  /** REQUIRED — injected by the host; the runtime has no key store to fall back on (D23). */
  resolver: CredentialResolver
  /** REQUIRED — where raw captures go (`writeCapture`'s `opts.dir`); the runtime has no default. */
  captureDir: string
  fetch?: typeof fetch
  writeCapture?: typeof defaultWriteCapture
  now?: () => Date
  monotonicNow?: () => number
  /** the streamed path's tool-call assembler (`../tool-call-stream.ts`); injected by tests only */
  createToolCallAssembler?: (tools?: ProviderToolDecl[]) => ToolCallAssembler
}

interface ResolvedDeps {
  resolver: CredentialResolver
  captureDir: string
  fetchImpl: typeof fetch
  writeCapture: typeof defaultWriteCapture
  now: () => Date
  monotonicNow: () => number
  createToolCallAssembler: (tools?: ProviderToolDecl[]) => ToolCallAssembler
}

function resolveDeps(deps: GoogleClientDeps): ResolvedDeps {
  return {
    resolver: deps.resolver,
    captureDir: deps.captureDir,
    fetchImpl: deps.fetch ?? fetch,
    writeCapture: deps.writeCapture ?? defaultWriteCapture,
    now: deps.now ?? (() => new Date()),
    monotonicNow: deps.monotonicNow ?? (() => performance.now()),
    createToolCallAssembler: deps.createToolCallAssembler ?? defaultCreateToolCallAssembler,
  }
}

// ---------------------------------------------------------------------------
// ProviderRequest -> the generateContent body. A WIRE-FORMAT translation only (spec §4.6: B1
// rewrites no history). Roles are `user` / `model`; a tool call is a `functionCall` part on the model
// turn and its result a `functionResponse` part on the next user turn. A `functionResponse` names the
// FUNCTION, which a `ProviderMessagePart` `tool_result` does not carry (it has only `toolUseId`), so
// the name is read back off the `tool_use` in the history that the id belongs to — and a result whose
// call is nowhere in the history is REFUSED rather than sent under a guessed name.
// Cache marks are NOT sent: this wire has no `cache_control` (implicit caching is automatic, research
// 12 §3.5), and a field a server does not know is one it may reject.
// ---------------------------------------------------------------------------

type TextPart = Extract<ProviderMessagePart, { type: 'text' }>
type ToolUsePart = Extract<ProviderMessagePart, { type: 'tool_use' }>
type ToolResultPart = Extract<ProviderMessagePart, { type: 'tool_result' }>

/** The prefix of an id this client minted for a call Google gave none (`raw.ts` `localCallId`). Such an
 *  id never went over the wire, so it is never sent back either. */
const LOCAL_CALL_ID_PREFIX = 'google-call-'

export type GooglePart =
  | { text: string }
  | { functionCall: { id?: string; name: string; args: unknown } }
  | { functionResponse: { id?: string; name: string; response: Record<string, unknown> } }

export interface GoogleContent {
  role: 'user' | 'model'
  parts: GooglePart[]
}

export type GoogleContentsResult =
  | { ok: true; contents: GoogleContent[] }
  | { ok: false; reason: 'tool-result-without-call' }

function wireId(id: string): { id: string } | Record<string, never> {
  return id.startsWith(LOCAL_CALL_ID_PREFIX) ? {} : { id }
}

/** `ProviderMessage[]` -> Gemini `contents`. Pure. */
export function mapGoogleContents(messages: ProviderRequest['messages']): GoogleContentsResult {
  const names = new Map<string, string>()
  for (const m of messages) {
    if (typeof m.content === 'string') continue
    for (const p of m.content) if (p.type === 'tool_use') names.set(p.id, p.name)
  }

  const contents: GoogleContent[] = []
  for (const message of messages) {
    const role = message.role === 'assistant' ? 'model' : 'user'
    if (typeof message.content === 'string') {
      contents.push({ role, parts: [{ text: message.content }] })
      continue
    }
    const parts: GooglePart[] = []
    const results = message.content.filter((p): p is ToolResultPart => p.type === 'tool_result')
    // Results first: they answer the previous turn's calls and must directly follow it.
    for (const r of results) {
      const name = names.get(r.toolUseId)
      if (name === undefined) return { ok: false, reason: 'tool-result-without-call' }
      // The response is a free-form object; `output` / `error` are the keys the reference names for
      // a result and a failure ("the response can have an "error" key to return error details").
      parts.push({
        functionResponse: { ...wireId(r.toolUseId), name, response: r.isError === true ? { error: r.content } : { output: r.content } },
      })
    }
    for (const p of message.content) {
      if (p.type === 'text') parts.push({ text: (p as TextPart).text })
      else if (p.type === 'tool_use') {
        const c = p as ToolUsePart
        parts.push({ functionCall: { ...wireId(c.id), name: c.name, args: isPlainObject(c.input) ? c.input : {} } })
      }
    }
    if (parts.length > 0) contents.push({ role, parts })
  }
  return { ok: true, contents }
}

/** `ProviderToolDecl[]` -> Gemini `tools`. Declarations only — B1 executes nothing. `inputSchema` is
 *  JSON Schema, which is what `parametersJsonSchema` is documented to take (the `parameters` field is
 *  an OpenAPI subset and the two are mutually exclusive). */
export function mapGoogleTools(tools: ProviderToolDecl[] | undefined) {
  if (!tools || tools.length === 0) return undefined
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      parametersJsonSchema: t.inputSchema,
    })),
  }]
}

export type GoogleBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; reason: 'tool-result-without-call' }

/** The request body. Nothing about streaming lives in it — that is the URL's choice. */
export function buildGoogleBody(req: ProviderRequest): GoogleBodyResult {
  const mapped = mapGoogleContents(req.messages)
  if (!mapped.ok) return mapped
  const tools = mapGoogleTools(req.tools)
  return {
    ok: true,
    body: {
      contents: mapped.contents,
      ...(req.system !== undefined ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      ...(tools !== undefined ? { tools } : {}),
      generationConfig: { maxOutputTokens: req.maxTokens },
    },
  }
}

/** A model id that is safe to put in a URL path: `gemini-2.5-flash` or `models/gemini-2.5-flash`.
 *  Anything else (a path separator, a query, a colon) is refused — never escaped into another route. */
export function normalizeGoogleModel(model: string): string | null {
  const bare = model.startsWith('models/') ? model.slice('models/'.length) : model
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bare) ? bare : null
}

export function googleUrl(model: string, stream: boolean): string {
  return stream
    ? `${GOOGLE_BASE_URL_CONSTANT}/models/${model}:streamGenerateContent?alt=sse`
    : `${GOOGLE_BASE_URL_CONSTANT}/models/${model}:generateContent`
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

function invalidRequestError(): ProviderError {
  return { kind: 'invalid-request', retryable: false, usageOutcome: 'none-reported', userCode: 'provider.request_invalid' }
}

/** No usable credential — no request left, so `none-reported` (the other clients' own mapping). */
function credentialRefusalError(): ProviderError {
  return { kind: 'authentication', retryable: false, usageOutcome: 'none-reported', userCode: 'provider.no_credential' }
}

/**
 * Decide the credential for this call, or refuse. Never throws. The ref must name THIS provider, and
 * the handle the resolver hands back must too — a handle for another provider reaching this client
 * would put that provider's key on a request to Google's host. A keyless call is never allowed: there
 * is no local Gemini endpoint, so an `absent` resolution is a refusal.
 */
async function decideCredential(
  req: ProviderRequest,
  d: ResolvedDeps,
): Promise<{ ok: true; handle: CredentialHandle } | { ok: false }> {
  if (req.credential.provider !== 'google') return { ok: false }
  let resolution
  try {
    resolution = await d.resolver.resolve(req.credential)
  } catch {
    return { ok: false }
  }
  if (!resolution.ok || resolution.handle.provider !== 'google') return { ok: false }
  return { ok: true, handle: resolution.handle }
}

/** Sends the one request. The key is unwrapped INSIDE the headers expression and nowhere else. */
async function send(
  url: string,
  body: Record<string, unknown>,
  handle: CredentialHandle,
  signal: AbortSignal | undefined,
  capturingFetch: typeof fetch,
): Promise<{ ok: true } | { ok: false; err: unknown }> {
  try {
    const response = await capturingFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': handle.reveal(),
      },
      body: JSON.stringify(body),
      signal,
      // A redirect is never followed: Bun forwards custom headers (the key among them) across a
      // cross-origin redirect, and Google's API has no reason to redirect a POST. The call fails instead.
      redirect: 'error',
    })
    // The capturing fetch already holds its own copy of the body; release this one. NOT awaited: on
    // the streaming path this is one branch of a `tee()`, and the WHATWG streams spec settles a
    // branch's `cancel()` only once BOTH branches are cancelled or the source ends — awaiting it here
    // would block on the very branch we read next (the whole stream would hang).
    void response.body?.cancel().catch(() => {})
    return { ok: true }
  } catch (err) {
    return { ok: false, err }
  }
}

function commonOf(req: ProviderRequest, attempt: number, startedAt: string) {
  return {
    invocationId: req.correlation.invocationId,
    attempt,
    provider: 'google' as const,
    requestedModel: req.model,
    startedAt,
    // Google documents no id to correlate on (`raw.ts` "Identity") — said on every result.
    correlationBasis: 'inferred' as const,
  }
}

// ---------------------------------------------------------------------------
// invokeOnce
// ---------------------------------------------------------------------------

/** The client's core. Exported so tests (and `retry.ts`) can inject deps directly. Never throws. */
export async function invokeGoogleOnce(
  req: ProviderRequest,
  attempt: number,
  deps: GoogleClientDeps,
): Promise<InvocationResult> {
  const d = resolveDeps(deps)
  const startedAt = d.now().toISOString()
  const startMono = d.monotonicNow()
  const elapsed = () => d.monotonicNow() - startMono
  const common = commonOf(req, attempt, startedAt)
  const failed = (error: ProviderError, extra: { capture?: CaptureRef } = {}): InvocationResult => ({
    ...common,
    latencyMs: elapsed(),
    status: 'failed',
    error,
    ...(extra.capture !== undefined ? { capture: extra.capture } : {}),
  })

  try {
    if (!Number.isInteger(req.maxTokens) || req.maxTokens <= 0) return failed(invalidRequestError())
    const model = normalizeGoogleModel(req.model)
    if (model === null) return failed(invalidRequestError())

    const credential = await decideCredential(req, d)
    if (!credential.ok) return failed(credentialRefusalError())

    const built = buildGoogleBody(req)
    if (!built.ok) return failed(invalidRequestError())

    const capturing = createCapturingFetch(d.fetchImpl, allowlistGoogleHeaders)
    const outcome = await send(googleUrl(model, false), built.body, credential.handle, req.signal, capturing.fetch)
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
      const capture = exchanges[0] !== undefined ? await tryWriteCapture(exchanges[0], d) : undefined
      return failed(classifyProviderError({ responseUnreadable: true }), { capture })
    }

    const ex = exchanges[0]!
    const capture = await tryWriteCapture(ex, d)
    const read = readGoogleExchange(ex, req.model)
    if (!read.ok) return failed(classifyProviderError(read.classifier), { capture })

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
      ...(read.toolUsePrompt !== undefined ? { toolUsePrompt: read.toolUsePrompt } : {}),
      ...(capture !== undefined ? { capture } : {}),
    }
  } catch {
    // Unreachable by construction (every step above is total); a last net so the "never throws"
    // contract does not rest on that reasoning alone. No error text is read — it could quote anything.
    return failed(classifyProviderError({}))
  }
}

// ---------------------------------------------------------------------------
// stream
// ---------------------------------------------------------------------------

/**
 * The streamed attempt. See `ProviderClient.stream`'s contract: iterating never throws, the last
 * event is always `end`, exactly once, and `end.result` is what `invokeOnce` would have returned for
 * the same exchange — `failed` for an HTTP error, an in-band `error` on a 200, a body that ended
 * before any `finishReason`, an abort, or anything unreadable; never a half-completed `completed`.
 *
 * Abort: `req.signal` aborting mid-body ends the attempt `failed` / `aborted`, unless a `finishReason`
 * had already arrived — then the answer was received whole and is `completed`. A consumer that stops
 * iterating early aborts the HTTP request too, and receives no `end` (it has left).
 *
 * The raw capture is written when OUR branch of the body ends — cleanly or not — so a failed stream
 * is captured as far as it got, with the allowlisted headers.
 */
export async function* streamGoogleOnce(
  req: ProviderRequest,
  attempt: number,
  deps: GoogleClientDeps,
): AsyncGenerator<ProviderStreamEvent, void, undefined> {
  const d = resolveDeps(deps)
  const startedAt = d.now().toISOString()
  const startMono = d.monotonicNow()
  const elapsed = () => d.monotonicNow() - startMono
  const common = commonOf(req, attempt, startedAt)
  const failed = (error: ProviderError, extra: { capture?: CaptureRef } = {}): InvocationResult => ({
    ...common,
    latencyMs: elapsed(),
    status: 'failed',
    error,
    ...(extra.capture !== undefined ? { capture: extra.capture } : {}),
  })

  let ended = false
  const end = (result: InvocationResult): ProviderStreamEvent => {
    ended = true
    return { type: 'end', result }
  }

  // Our own controller, so a consumer that walks away can cancel the request; the caller's signal
  // is forwarded into it.
  const internal = new AbortController()
  const forwardAbort = () => internal.abort()
  const aborted = () => req.signal?.aborted === true

  try {
    if (!Number.isInteger(req.maxTokens) || req.maxTokens <= 0) {
      yield end(failed(invalidRequestError()))
      return
    }
    const model = normalizeGoogleModel(req.model)
    if (model === null) {
      yield end(failed(invalidRequestError()))
      return
    }
    const credential = await decideCredential(req, d)
    if (!credential.ok) {
      yield end(failed(credentialRefusalError()))
      return
    }
    const built = buildGoogleBody(req)
    if (!built.ok) {
      yield end(failed(invalidRequestError()))
      return
    }

    req.signal?.addEventListener('abort', forwardAbort, { once: true })
    if (aborted()) internal.abort()

    const capturing = createStreamingCapturingFetch(d.fetchImpl, allowlistGoogleHeaders)
    const outcome = await send(googleUrl(model, true), built.body, credential.handle, internal.signal, capturing.fetch)
    const first = outcome.ok ? await capturing.observed : null

    if (first === null) {
      // No response head was ever observed: the call rejected before one (abort, network).
      const classifier: ClassifierInput = aborted() || (!outcome.ok && isAbort(outcome.err, internal.signal))
        ? { transport: 'aborted' }
        : capturing.requestSent()
          ? { transport: 'network', requestSent: true }
          : { sdkRejected: true, requestSent: false }
      yield end(failed(classifyProviderError(classifier)))
      return
    }

    const isOk = first.status >= 200 && first.status < 300
    const decoder = new TextDecoder()
    const sse = createSseDecoder()
    const reader = createGoogleStreamReader({
      requestedModel: req.model,
      assembler: d.createToolCallAssembler(req.tools),
    })
    let raw = ''
    let bodyEnd: StreamBodyEnd = 'complete'

    if (first.body !== null) {
      const bodyReader = first.body.getReader()
      try {
        for (;;) {
          const { done, value } = await bodyReader.read()
          if (done) break
          const text = decoder.decode(value, { stream: true })
          raw += text
          if (!isOk) continue
          for (const frame of sse.push(text)) {
            for (const ev of reader.accept(frame)) yield ev
          }
        }
        const tail = decoder.decode()
        raw += tail
        if (isOk) {
          for (const frame of [...sse.push(tail), ...sse.end()]) {
            for (const ev of reader.accept(frame)) yield ev
          }
        }
      } catch (err) {
        raw += decoder.decode()
        bodyEnd = isAbort(err, req.signal) || aborted() ? 'aborted' : 'errored'
      } finally {
        try { bodyReader.releaseLock() } catch { /* already released */ }
      }
    }

    const ex: RawExchange = { status: first.status, headers: first.headers, body: raw }
    const capture = await tryWriteCapture(ex, d)
    const extra = { capture }

    if (capturing.requestCount() !== 1) {
      yield end(failed(classifyProviderError({ responseUnreadable: true }), extra))
      return
    }

    if (!isOk) {
      const read = readGoogleExchange(ex, req.model)
      const classifier: ClassifierInput = read.ok ? { httpStatus: first.status, responseUnreadable: true } : read.classifier
      yield end(failed(classifyProviderError(classifier), extra))
      return
    }

    const verdict = reader.finish(bodyEnd)
    for (const ev of verdict.events) yield ev
    if (!verdict.ok) {
      yield end(failed(verdict.error, extra))
      return
    }

    yield end({
      ...common,
      latencyMs: elapsed(),
      status: 'completed',
      messageId: verdict.messageId,
      servedModel: verdict.servedModel,
      usage: verdict.usage,
      usageAnomalies: verdict.usageAnomalies,
      stopReason: verdict.stopReason,
      content: verdict.content,
      toolCallFailures: verdict.toolCallFailures,
      usageCertainty: verdict.usageCertainty,
      cost: verdict.cost,
      usageNotes: verdict.usageNotes,
      ...(verdict.toolUsePrompt !== undefined ? { toolUsePrompt: verdict.toolUsePrompt } : {}),
      ...(capture !== undefined ? { capture } : {}),
    })
  } catch {
    // Nothing above is meant to throw; if something did, the contract still holds: one `end`.
    if (!ended) yield end(failed(classifyProviderError({ sdkRejected: true })))
  } finally {
    req.signal?.removeEventListener('abort', forwardAbort)
    // A consumer that left before `end` must not leave the request running.
    if (!ended) internal.abort()
  }
}

/** Builds a `ProviderClient` over `deps` — the host binds its resolver and capture directory here. */
export function createGoogleClient(deps: GoogleClientDeps): ProviderClient {
  return {
    provider: 'google',
    adapterVersion: ADAPTER_VERSION,
    capabilities: { streaming: true, editPolicy: GOOGLE_EDIT_POLICY },
    invokeOnce: (req, attempt) => invokeGoogleOnce(req, attempt, deps),
    stream: (req, attempt) => streamGoogleOnce(req, attempt, deps),
  }
}
