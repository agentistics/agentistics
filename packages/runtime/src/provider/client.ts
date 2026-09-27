/**
 * client.ts — the `ProviderClient` contract and the registry of clients (spec
 * docs/superpowers/specs/2026-09-25-runtime-b1-provider.md §4.1).
 *
 * One call of `invokeOnce` = one HTTP request = at most one billed response = one
 * `ModelInvocation`. The retry lives OUTSIDE the client (`retry.ts`, §4.5), so a client cannot hide
 * an attempt. `invokeOnce` never throws: every failure, an SDK rejection and an abort included, is
 * a `status: 'failed'` value, and a failed result has no `usage` property at all — a zeroed
 * invocation is a confident 0 for a call that may have been billed.
 *
 * This module is a NON-holder of the credential: it names the opaque `CredentialRef` and the
 * `CredentialHandle` TYPE only (declared in `./credential.ts`). The one place a key is unwrapped is
 * `anthropic/client.ts` (`provider-secrets.lint.test.ts`, Guard 1).
 *
 * There is no module-level client registry: a client needs a `CredentialResolver` and a capture
 * directory, and both belong to the HOST (D23 — the runtime reads no host path and no host store).
 * `createProviderClients` builds the registry from what the host injects.
 */
import type {
  EditPolicy,
  ProviderError,
  ProviderId,
  ProviderUsage,
  StopReason,
  UsageAnomaly,
} from '@agentistics/core'
import type { CredentialRef } from './credential.ts'

export type { CredentialHandle, CredentialRef, CredentialResolution, CredentialResolver } from './credential.ts'

export interface CallCorrelation {
  /** minted by the caller, `inv_` prefix — the grouping key of an invocation's attempts */
  invocationId: string
  sessionId?: string
  runId?: string
  agentId?: string
  taskId?: string
}

/** One content block of a message sent to the provider. Sent verbatim — B1 rewrites no history (§4.6). */
export type ProviderMessagePart =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }

export interface ProviderMessage {
  role: 'user' | 'assistant'
  content: string | ProviderMessagePart[]
}

/** A tool DECLARATION only: B1 executes no tool (B3). */
export interface ProviderToolDecl {
  name: string
  description?: string
  /** JSON Schema of the tool input */
  inputSchema: Record<string, unknown>
}

export interface ProviderRequest {
  /** the REQUESTED id; the served one comes back on the result */
  model: string
  system?: string
  messages: ProviderMessage[]
  tools?: ProviderToolDecl[]
  /** required: Anthropic requires it and a default is a guess */
  maxTokens: number
  signal?: AbortSignal
  correlation: CallCorrelation
  credential: CredentialRef
}

/** What came back, for the caller. Never journaled. */
export type ProviderContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  /** any other block kind (thinking, server tool results, …) — carried by its raw type, never dropped */
  | { type: 'other'; rawType: string }

/** `{sha256, bytes}` of one attempt's raw capture in the content store (`capture.ts`). */
export interface CaptureRef {
  sha256: string
  bytes: number
}

/**
 * The one HTTP exchange of an attempt, as the capturing fetch saw it. `headers` has ALREADY passed
 * through the allowlist (`anthropic/raw.ts` `allowlistHeaders`) — request headers are never here.
 */
export interface RawExchange {
  status: number
  headers: Record<string, string>
  body: string
}

export interface InvocationCommon {
  invocationId: string
  /** 1-based; one attempt = one HTTP request = one ModelInvocation */
  attempt: number
  provider: ProviderId
  requestedModel: string
  /** wall clock, ISO — the occurredAt of `model.invoked` */
  startedAt: string
  /** monotonic (performance.now) delta, never a wall-clock subtraction */
  latencyMs: number
  /** header `request-id` (on failure, the body's `request_id` when the header is absent); absent = not stated */
  requestId?: string
  /** absent when the capture could not be written (or there was no response to capture) */
  capture?: CaptureRef
}

export type InvocationResult =
  | (InvocationCommon & {
      status: 'completed'
      /** body `id`, msg_… — the ModelInvocation identity (§4.4) */
      messageId: string
      /** body `model`; may differ from requestedModel */
      servedModel: string
      /** read from the RAW body, never from the SDK aggregate */
      usage: ProviderUsage
      /** divergences met while reading the raw usage; empty on a clean read */
      usageAnomalies: UsageAnomaly[]
      stopReason: StopReason
      content: ProviderContent[]
    })
  | (InvocationCommon & {
      status: 'failed'
      error: ProviderError
      messageId?: undefined
    })

export interface ProviderClient {
  readonly provider: ProviderId
  /** bumped on any mapping change (M §14 rule 1) */
  readonly adapterVersion: string
  /** B2 flips `streaming` */
  readonly capabilities: { streaming: false; editPolicy: EditPolicy }
  /** never throws */
  invokeOnce(req: ProviderRequest, attempt: number): Promise<InvocationResult>
}

/** Why a provider has no client — a sentence code, rendered by the caller. */
export const PROVIDER_CLIENT_ABSENT: Record<Exclude<ProviderId, 'anthropic'>, string> = {
  openai: 'provider.not_in_b1',
  google: 'provider.not_in_b1',
  moonshot: 'provider.not_in_b1',
  other: 'provider.not_a_vendor',
}
