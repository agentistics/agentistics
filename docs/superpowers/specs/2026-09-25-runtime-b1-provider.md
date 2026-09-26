# B1 — The provider client and the first real call

**Phase B1 of Track B in `2026-09-19-agentistics-runtime-master.md` (§46, §52).** Read §14 (the
event envelope and `ModelCompletedData`), §22 (provider architecture, the four AI SDK conditions,
the credentials boundary) and §24 (`ProviderRuntime`) of that document first; this one only says
what B1 builds, how it is proven and how it is undone. Its shape is P1's
(`2026-09-19-runtime-p1-canonical-journal.md`) on purpose.

**Status:** specification, ready for an implementation plan. The B1 subtasks in §15 are written
FROM this document — a session implementing B1 must not have to invent a contract this document
does not state. Where the research is silent or contradicts itself the gap is an **open item** (§14),
never a value filled from memory.

**Citations.** `M` = the master spec, `P1` = `2026-09-19-runtime-p1-canonical-journal.md`, `OD` =
`2026-09-25-owner-decisions.md`, `CM` = `2026-09-25-runtime-context-manager-design.md`, `R12` / `R13`
= `docs/superpowers/research/12-provider-apis.md` / `13-ai-sdk-fidelity.md`. Line numbers refer to
those files as they stand on this branch. Open items are numbered `O-n` (contracts), `U-n` (usage
table, §5.3) and `C-n` (credentials) and collected in §14.

**Decisions this document encodes** (`2026-09-25-owner-decisions.md`):
- **D3** — our own runtime; the provider layer is built on the Vercel AI SDK **behind our own
  interface**, under the four conditions of master §22.1.1. **The first and only provider in B1 is
  Anthropic, on the owner's own API key, with a spend limit set in the provider console.**
- **D5** — native raw content is stored locally, never sent to a central.
- **D17** — one confidence vocabulary, `exact | estimated | inferred`; a value derived from exact
  inputs by a deterministic rule is `exact`, a price from a table is `estimated`, a number's
  confidence is the weakest of its inputs.
- **D18** — models per item (writers on Sonnet 5 or Opus 5.5, Haiku only on read-only items).
- **D19** — the coordinator releases a commit on a feature branch after checking evidence.

> D17, D18 and D19 are recorded in `2026-09-25-owner-decisions.md` by subtask A1.0, committed on
> `origin/spec/a1-0-apply-decisions` (4478f8a3), a branch this spec's base does not include; the text
> above is quoted from that record.

**Flag:** `AGENTISTICS_PROVIDER` — absent reads as **off**. With it off no provider module is
loaded, no credential file is read, and no verb other than `agentop provider … status` does
anything but say the flag is off.
**Ships nothing to a user's screen.** B1 is measurable from tests, from `agentop` verbs and from the
journal only.

---

## 1. What B1 delivers

1. **The provider contracts**, as pure modules: the usage-mapping type (four counters, `input`
   excluding cache, reasoning carried with a `billing` discriminator), the closed error taxonomy,
   the pure retry plan, and the edit-policy slot the context manager will read.
2. **`ProviderClient`** — one interface, one implementation (Anthropic), with the Vercel AI SDK
   behind it and every one of the four §22.1.1 conditions held and tested.
3. **Credentials** — entered by the user through an `agentop` verb, stored `0600` with the
   `envelope-keys.ts` discipline, never logged, audited, returned or exported, and held only by
   modules that cannot name them.
4. **The retry the runtime owns** — `maxRetries: 0` on the SDK; every attempt is its own recorded
   invocation with its own request id.
5. **Emission** of `model.invoked` / `model.completed` / `model.failed` into the A1 journal, so one
   billed response is exactly one canonical invocation.
6. **The first real call**, and its reconciliation: one live call's recorded usage compared with
   what the Anthropic console bills for it.

**Explicitly not in B1:** no streaming (B2); no tool loop, no policy (B3); no session, resume or
shared access (B4) — a B1 call is a bare invocation with correlation ids, not a session; no other
provider (B5); no gateway (B7); no context manager, and **no rewriting of history** — B1 declares
the edit-policy slot and never exercises it; no surface reads anything B1 writes; no wire change to
a central; no use of any subscription or OAuth credential, ever (§22.3).

## 2. Why this order

B1 is the join between the two tracks: it is the first producer of canonical events that is not an
adapter reading somebody else's files. Its own deliverable is **the exact cost of one call**, which
is why it starts with a single provider and reconciles against a real bill before B5 adds four more
— the usage model has been wrong in this repository in both directions (a 4,8× agy under-count, a
per-line Claude over-count; master §22.1), and discovering that five times in parallel is the
failure mode this order avoids. Streaming is deferred to B2 because Anthropic's streaming usage is
cumulative and differs per provider (§22.1); proving the non-streaming number first gives B2 a
reference to be equal to.

## 3. Where the code goes

```
packages/core/src/provider/
  usage.ts          PURE — ProviderUsage, CacheWriteByTtl, ReasoningUsage {tokens, billing},
                    UsageIteration, ServerToolUse; totals ONLY through tokens.ts
  stop-reason.ts    PURE — StopReason (closed union + 'other' carrying the raw string)
  errors.ts         PURE — ProviderErrorKind (closed union), ClassifierInput, classify(), userCode()
  retry-plan.ts     PURE — (attempt, kind, retryAfterMs, elapsedMs, policy) → RetryDecision
  edit-policy.ts    PURE — EditPolicy type + ANTHROPIC_EDIT_POLICY (declared, UNVERIFIED)

packages/server/server/provider/
  client.ts         ProviderClient interface + PROVIDER_CLIENTS: Record<ProviderId, ProviderClient | null>
  anthropic/raw.ts  PURE — raw { status, headers, body } → ProviderUsage + identity + stop reason,
                    or a ClassifierInput for a non-2xx
  anthropic/client.ts IO — the AI SDK call behind our interface; injects the capturing fetch
  retry.ts          IO — the retry loop the runtime owns (sleep, abort, one attempt at a time)
  capture.ts        IO — writes one attempt's raw capture into the content-store layout
  emit.ts           IO — model.invoked / model.completed / model.failed → the A1 journal
  credential-plan.ts PURE — key shape validation, fingerprint, refusal reasons (§6)
  credentials.ts    IO — the 0700/0600 key store and the opaque CredentialHandle (§6.2, §6.3.2)
  provider-secrets.lint.test.ts   the name guard, by directory walk (§6.3.2)

packages/server/server/cli-provider.ts   the `agentop provider …` verbs (§6.1, §11)
packages/server/test/fixtures/provider/anthropic/   recorded, redacted responses (§9, B1.5)
```

- **Why `stop-reason.ts` is in core.** `ModelCompletedData` lives in
  `@agentistics/core` (P1 §3, `canonical/event.ts`) and must carry the stop reason (see O-5);
  core cannot import from `packages/server`, so the type cannot live in `anthropic/raw.ts`. The
  Anthropic→canonical mapping stays in `raw.ts`; only the vocabulary moves to core.
- **Why `capture.ts` exists before the content store does.** B1 must write each attempt's raw response
  somewhere re-readable (§7, `sourceRef`), and the content store of CM §8.1 has no module yet. This
  file writes into exactly CM §8.1's layout (`~/.agentistics/content/<sha[0:2]>/<sha256>`, 0600) and
  is subsumed by the content-store module when the context manager lands — one layout, never two.
  It carries the `backup-plan.ts` row CM §8.3 requires (content store: excluded by default, with its
  reason), because `backup-coverage.lint.test.ts` makes an undecided path a build failure.
- **The key reaches the client only as an opaque `CredentialHandle`** (§6.3.2, Guard 4), obtained
  through `CredentialResolver` (§4.1); `reveal()` is called in exactly one place, inside
  `anthropic/client.ts`.
- **Nothing under `packages/web` or `packages/tui` changes in B1.** No surface reads the provider
  layer or the events it emits (P1 §1: no surface reads the journal yet).

## 4. Contracts created

### 4.1 `ProviderClient`

```ts
// packages/server/server/provider/client.ts
import type { ProviderId } from '@agentistics/core'               // providers.ts, see O-9

interface CredentialRef { provider: ProviderId; id: string }      // opaque; NEVER a key
interface CredentialResolver {       // implemented by credentials.ts (§6)
  resolve(ref: CredentialRef): Promise<
    | { ok: true; handle: CredentialHandle }   // opaque: toJSON/inspect/String print a fingerprint only
    | { ok: false; reason: 'absent' | 'unreadable' | 'permissions-too-open' | 'wrong-provider' }>
}
// CredentialHandle.reveal() is callable only inside anthropic/client.ts — Guard 1, §6.3.2

interface CallCorrelation {
  invocationId: string          // minted by the caller, 'inv_' prefix (M §13.3 mint convention)
  sessionId?: string; runId?: string; agentId?: string; taskId?: string   // absent in a bare B1 call
}

interface ProviderRequest {
  model: string                 // the REQUESTED id; the served one comes back in the result
  system?: string
  messages: ProviderMessage[]   // sent verbatim — B1 never rewrites history (§4.6)
  tools?: ProviderToolDecl[]    // declarations only: B1 executes no tool (B3)
  maxTokens: number             // required: Anthropic requires it and a default is a guess
  signal?: AbortSignal
  correlation: CallCorrelation
  credential: CredentialRef
}

interface InvocationCommon {
  invocationId: string
  attempt: number               // 1-based; one attempt = one HTTP request = one ModelInvocation
  provider: ProviderId
  requestedModel: string
  startedAt: string             // wall clock, ISO — occurredAt of model.invoked
  latencyMs: number             // monotonic (performance.now) delta, never a wall-clock subtraction
  requestId?: string            // header `request-id`; absent = the header was absent (§4.4)
  capture?: CaptureRef          // { sha256, bytes } of the raw capture; absent if the write failed
}

type InvocationResult =
  | (InvocationCommon & {
      status: 'completed'
      messageId: string         // body `id`, msg_… — the ModelInvocation identity (§4.4)
      servedModel: string       // body `model`; may differ from requestedModel (R12 §6, model row)
      usage: ProviderUsage      // §4.2, read from the RAW body, never from the SDK aggregate
      stopReason: StopReason
      content: ProviderContent[]   // text / tool_use blocks, for the caller; never journaled
    })
  | (InvocationCommon & {
      status: 'failed'
      error: ProviderError      // §4.3 — kind, retryable, userCode, and NO usage field at all
      messageId?: undefined
    })

interface ProviderClient {
  readonly provider: ProviderId
  readonly adapterVersion: string          // bumped on any mapping change (M §14 rule 1)
  readonly capabilities: { streaming: false; editPolicy: EditPolicy }   // B2 flips streaming
  invokeOnce(req: ProviderRequest, attempt: number): Promise<InvocationResult>  // never throws
}

const PROVIDER_CLIENTS: Record<ProviderId, ProviderClient | null>   // anthropic filled; rest null
```

Rules:

- **One call of `invokeOnce` = one HTTP request = at most one billed response = one
  `ModelInvocation`.** The retry lives OUTSIDE the client (§4.5), so the client cannot hide an
  attempt. This is the "one billed response is counted once" rule (`usage-dedupe.ts`, P1 §4.1)
  applied at the source instead of reconstructed after the fact.
- **`invokeOnce` never throws.** Every failure, including an SDK rejection and an abort, is a
  `status: 'failed'` value. A thrown error is how a failed attempt goes unrecorded.
- **A failed result has no `usage` property at all** — not zero, not partial. A zeroed invocation is
  a confident 0 for a call that may have been billed (M §22.1.1, lines 1036-1039).
- **The credential is a reference, resolved inside `anthropic/client.ts` only.** The secret exists
  inside the resolver's callback, is handed to the SDK provider factory for that one call and is
  never returned, logged, captured, audited or placed on an event (M §22.3 rules 2 and 4, lines
  1074-1079). A source test in the `billing-detect.test.ts` shape fails if `apiKey`, `x-api-key` or
  `authorization` appears in `raw.ts`, `retry.ts`, `emit.ts`, `capture.ts` or any core module.
- **`PROVIDER_CLIENTS` is total over `ProviderId`**, like P1's `INTEGRATIONS` (P1 §4.3): a missing
  provider is a declared `null`, and removing `anthropic` fails the build.
- **B2 does not break this interface.** Streaming is ADDED as
  `invokeStream?(req, attempt): AsyncIterable<ProviderStreamPart>` whose last part is
  `{ type: 'result'; result: InvocationResult }` — the same union — gated by
  `capabilities.streaming`. `ProviderRequest`, `InvocationResult`, the retry loop and `emit.ts`
  consume the terminal result either way, so nothing written in B1 changes shape in B2. (Streaming
  usage semantics are B2's: Anthropic's `message_delta.usage` is cumulative, take the last one —
  R12 §1.1 lines 61-70, §7 trap 3.)

**How the AI SDK sits behind it.** Pinned to the versions R13 measured: `ai@7.0.107`,
`@ai-sdk/anthropic@4.0.58`, `@ai-sdk/provider@4.0.17`, contract `LanguageModelV4` (R13 header
lines 3-5, §8 lines 307-310). `anthropic/client.ts` calls `generateText` with `maxRetries: 0`, the
tool declarations without `execute`, and a stop condition of one step; it injects a **capturing
`fetch`** into the provider factory so the raw `{status, headers, body}` of the one HTTP exchange
is taken at the transport, before any SDK parsing can drop a field (R13 §5 lines 222-224 names the
fetch override as the way to see what the SDK hides). `raw.ts` then derives usage, identity and
stop reason from that capture. The SDK's typed usage is read only as a cross-check (a divergence
is a counter, §10). Each of D3's four conditions (OD lines 34-38; M §22.1.1 lines 1017-1034) is
met by a named field:

| Condition (M §22.1.1) | Satisfied by | Why it holds |
|---|---|---|
| 1. capture raw per step | `InvocationCommon.capture` + `raw.ts` | the capture is the fetch body, not `providerMetadata`; `cacheWriteByTtl` comes from `usage.cache_creation` in it (R13 §1 lines 58-85) |
| 2. read `iterations` | `ProviderUsage.iterations` | read from the raw `usage.iterations` array, never from the SDK totals, which exclude advisor tokens (R13 §1 lines 87-96) |
| 3. usage per step | one `invokeOnce` = one step; `usage` from the raw body | `result.usage.raw` is undefined on multi-step calls (R13 §3 lines 168-183); B1 asserts `steps.length === 1` |
| 4. own the retry | `maxRetries: 0` + `retry.ts` | the SDK retries twice by default and a successful retry is invisible (R13 §5 lines 212-224) |

### 4.2 `ProviderUsage` — the normalised usage

```ts
// packages/core/src/provider/usage.ts
interface ProviderUsage {
  input: number                 // EXCLUDES cache read and cache write — always, every provider
  output: number                // includes whatever the provider folds into it (see reasoning)
  cacheRead: number
  cacheWrite: number            // flat total; === sum(cacheWriteByTtl) when that is present
  cacheWriteByTtl?: CacheWriteByTtl
  reasoning?: ReasoningUsage    // ABSENT for Anthropic — see rule below
  iterations?: UsageIteration[] // Anthropic advisor/compaction/fallback — carried, never folded in
  iterationsRelation?: 'unmeasured'   // the only value B1 can state — see O-3
  serverToolUse?: { webSearchRequests?: number }   // a COUNT, not tokens (R12 §1.1 lines 54-56)
  contextTokens?: number        // GAUGE = input + cacheRead + cacheWrite of THIS response
  missing?: Array<'input' | 'output' | 'cacheRead' | 'cacheWrite'>  // counters the source did not state
}
interface CacheWriteByTtl { ephemeral5m: number; ephemeral1h: number }   // both-or-neither
interface ReasoningUsage {
  tokens: number
  billing: 'included-in-output' | 'additive' | 'unknown'
}
interface UsageIteration {
  kind: string                  // 'compaction' | 'message' | 'advisor_message' | 'fallback_message' | …
  model?: string                // an iteration may run another model (R13 §1 line 89-90)
  raw: JSONObject               // verbatim; typed counters extracted only once a fixture pins the keys
}
```

Rules:

- **`input` excludes cache, per provider on the way in.** Anthropic's `input_tokens` already does
  (R12 §1.1 lines 37-40: `total_input = cache_read + cache_creation + input`), so `raw.ts` copies it;
  B5's OpenAI/Google/OpenRouter clients subtract the cached sub-count (M §14.2 lines 596-600; R12
  §7 trap 2). A generic "add cache to input" helper is right for one provider and wrong for the rest.
- **Four counters, always, and no total field.** Anthropic has no `total_tokens` (R12 §1.1 lines
  57-59); a total is computed only through `packages/core/src/tokens.ts`, never by hand
  (`tokens.lint.test.ts` covers `core/src/provider/`).
- **A subset is never inferred into a total** (M §14.2 lines 601-602). A counter absent from the raw
  body is listed in `missing` and set to 0 ONLY as the type's placeholder; readers must check
  `missing` first, exactly as `unmeasured: true` is read before an agent row's figures. Anthropic
  documents all four as present once any cache activity occurs (R12 §1.1); whether
  `cache_*_input_tokens` is present on a response with NO cache activity is not stated — hence
  `missing` exists rather than a silent 0 (see O-7).
- **`cacheWriteByTtl` is both-or-neither and must sum to `cacheWrite`.** It mirrors
  `ModelUsage.cacheCreation1hInputTokens` / `cacheCreation5mInputTokens`
  (`packages/core/src/types.ts` lines 19-30), which `calcCost` already prices at 2x / 1.25x
  (`types.ts` lines 1067-1080). A raw `cache_creation` whose buckets do not sum to
  `cache_creation_input_tokens` is NOT adopted: the flat figure stands, the breakdown is dropped,
  and a divergence counter increments — a half-true split prices only what it states.
- **`reasoning` is ABSENT for Anthropic, and absent is not `unknown`.** Absent means *the provider
  reports no separate figure*; Anthropic folds thinking into `output_tokens` and has no field (R12
  §1.1 lines 49-53; M §22.1 line 981). `billing: 'unknown'` means *a figure was reported and its
  relation to `output` is not established* — it is carried and never summed (M §14.2 lines
  589-595). The two must not collapse: an absent field turned into `{tokens: 0, billing: 'unknown'}`
  is a confident 0 for thinking the model did. If `output_tokens_details.thinking_tokens` ever
  appears in a raw Anthropic body (R13 §1 line 70 shows the SDK schema declaring it; R12 says no
  such field — O-2), `raw.ts` carries it as `{tokens, billing: 'unknown'}` until a fixture
  shows whether it is inside `output_tokens`.
- **`iterations` are carried, never folded, never dropped.** R13 §1 (lines 87-96) records that
  advisor/compaction iterations carry billed tokens absent from the SDK's top-level totals. What R13
  does not establish is whether Anthropic's own raw top-level `usage` includes them (the exclusion it
  cites is the SDK's `convertAnthropicUsage`, not the API). So B1 stores each iteration verbatim with
  its own `model`, sets `iterationsRelation: 'unmeasured'`, and the projection treats an invocation
  that carries iterations as **priced partially and SAYS SO** — neither adding them (double count if
  the top level already includes them) nor ignoring them (under-report if it does not). B1 enables
  neither compaction nor the advisor, so its own calls should carry none; the field exists so a
  response that does is never silently truncated.
- **`serverToolUse` is carried, not priced.** R12 §1.1 documents `server_tool_use.web_search_requests`
  as a count; `ModelUsage.webSearchRequests` (`types.ts` line 31) is the precedent. B1 enables no
  server tool; pricing web search is out of scope.
- **`contextTokens` is a gauge** computed from this response's three input-side counters — the
  Claude transcript rule in CLAUDE.md ("the context gauge"), exact by D17 (deterministic over exact
  inputs). It is never summed across invocations.

**Field-by-field mapping to M §14.2 `ModelCompletedData` (lines 566-585):**

| `ModelCompletedData` | Source in B1 | Confidence (D17) |
|---|---|---|
| `providerRequestId` | `messageId` (body `id`, msg_…) — see §4.4 and O-4 | exact |
| `provider` | `'anthropic'` | exact |
| `model` | `servedModel` (body `model`) | exact |
| `deployment` | `'direct'` (M §22 line 955) | exact |
| `usage.{input,output,cacheRead,cacheWrite}` | `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` | exact |
| `cacheWriteByTtl` | `{ephemeral_5m: …, ephemeral_1h: …}` from `usage.cache_creation` | exact |
| `reasoning` | absent | — |
| `contextTokens` | `input + cacheRead + cacheWrite` | exact |
| `contextWindow` | absent — Anthropic does not state it (R12 §1) | — |
| `costUSD` / `costSource` | absent — Anthropic returns no money (R12 §1.1; M §22.1 line 981) | — |
| `latencyMs` | monotonic delta | exact |
| `status` | `'completed'` | — |
| **proposed additions** | `requestedModel`, `requestId`, `stopReason`, `attempt`, `invocationId`, `iterations`, `iterationsRelation`, `serverToolUse`, `missing`, `captureRef` | — (O-5) |

### 4.3 Error taxonomy

```ts
// packages/core/src/provider/errors.ts
type ProviderErrorKind =
  | 'invalid-request'   | 'authentication'  | 'billing'         | 'permission'
  | 'not-found'         | 'conflict'        | 'request-too-large'
  | 'rate-limited'      | 'spend-cap'       | 'api-error'       | 'provider-timeout'
  | 'overloaded'        | 'http-other'
  | 'network'           | 'client-timeout'  | 'aborted'
  | 'sdk-rejected'      // the SDK threw with zero completed steps and no HTTP classification
  | 'response-unreadable'  // a 2xx whose body raw.ts cannot read as a Message

interface ClassifierInput {
  httpStatus?: number; errorType?: string; errorCode?: string   // error.details.error_code
  retryAfterHeader?: string
  transport?: 'network' | 'client-timeout' | 'aborted'
  requestSent?: boolean          // did the capturing fetch observe the request leave?
  sdkRejected?: boolean
}
interface ProviderError {
  kind: ProviderErrorKind
  retryable: boolean
  retryAfterMs?: number          // parsed from `retry-after` (seconds), only when present
  usageOutcome: 'none-reported' | 'unknown'
  userCode: string               // a sentence CODE rendered by i18n; never provider/internal text
  httpStatus?: number; errorType?: string; requestId?: string   // requestId: header, else body request_id
}
```

| Kind | Trigger (R12 §1.7 lines 213-225 unless noted) | Retryable | `usageOutcome` | `userCode` |
|---|---|---|---|---|
| `invalid-request` | 400 `invalid_request_error` | no | none-reported | `provider.request_invalid` |
| `authentication` | 401 `authentication_error` | no | none-reported | `provider.key_rejected` |
| `billing` | 402 `billing_error` | no | none-reported | `provider.billing` |
| `permission` | 403 `permission_error` | no | none-reported | `provider.forbidden` |
| `not-found` | 404 `not_found_error` (e.g. unknown model) | no | none-reported | `provider.not_found` |
| `conflict` | 409 `conflict_error` | **no, in B1** — R12 says "Yes (after resolving)"; resolving is not something a blind retry does | none-reported | `provider.conflict` |
| `request-too-large` | 413 `request_too_large` | no | none-reported | `provider.too_large` |
| `rate-limited` | 429 `rate_limit_error` WITH `retry-after` | yes, honouring `retry-after` | none-reported | `provider.rate_limited` |
| `spend-cap` | 429 or 400 with `error.details.error_code === 'enforced_spend_limit_reached'` (R12 §1.6 lines 205-209, §7 trap 8) | **never** | none-reported | `provider.spend_cap` |
| `api-error` | 500 `api_error` | yes, backoff | none-reported | `provider.unavailable` |
| `provider-timeout` | 504 `timeout_error` | yes | none-reported | `provider.timeout` |
| `overloaded` | 529 `overloaded_error` | yes, backoff | none-reported | `provider.overloaded` |
| `http-other` | any other non-2xx, or a known status with an unknown `error.type` | 5xx yes / 4xx no | none-reported | `provider.error` |
| `network` | fetch rejected (DNS, reset) | yes **only if `requestSent === false`** | unknown if sent | `provider.network` |
| `client-timeout` | our own deadline fired | **no in B1** (§4.5) | unknown | `provider.no_response` |
| `aborted` | the caller's `signal` | never (R13 §6 lines 254-256) | unknown | `provider.cancelled` |
| `sdk-rejected` | SDK threw, zero steps, no HTTP facts (R13 §3 lines 161-167, §6 lines 267-269) | no | unknown | `provider.error` |
| `response-unreadable` | 2xx, capture present, body not a Message | no | unknown | `provider.error` |

Rules:

- **The union is closed and the classifier is total.** An unrecognised `error.type` under a known
  status becomes `http-other` and the raw type is kept; never a thrown `default`.
- **`spend-cap` is decided by `error_code`, never by status.** Same status and same `error.type` as
  an ordinary 429, opposite behaviour under retry (R12 §7 trap 8); a status-only classifier spins
  against a cap until the next billing period.
- **No kind carries usage.** `usageOutcome: 'none-reported'` means an HTTP error response arrived and
  stated no usage; it does NOT claim the call was free (R12 does not say whether an error response
  bills). `'unknown'` means no response was read at all, so the provider may have completed and
  billed it (R13 §5 lines 231-241). Either way `model.failed` carries no usage object.
- **The user sees a code, never provider text.** `userCode` is rendered by the i18n layer; the
  provider's `error.message` and any internal exception text go to the log through `safeError`
  (`packages/server/server/errors.ts` lines 12-21), with its correlation `ref`. The `requestId` is
  surfaced (it is what Anthropic support asks for, R12 §1.7 line 223) — it is not a secret.
- **`sdk-rejected` exists because the SDK's zero-step failure is a rejection, not a zero usage**
  (R13 §3/§6). With the capturing fetch, most such cases also carry HTTP facts and classify under a
  status kind; `sdk-rejected` is the residue where nothing was observed on the wire.

### 4.4 Request identity

Two ids exist and they are not the same thing (R12 §1.2 lines 74-82):

| Id | Where | Shape | Role in B1 |
|---|---|---|---|
| message id | body top-level `id` (2xx only) | `msg_…` | **the `ModelInvocation` identity**; `eventId` input for `model.completed`; `providerRequestId` |
| request id | response header **`request-id`** (every response); error bodies also carry `request_id` | `req_…` | support/correlation id, carried as `requestId` on every attempt, success or failure |

- **The header is `request-id`** — lowercase, no `x-` or `anthropic-` prefix, verified verbatim
  (R12 §1.2 lines 76-80; M §22.1 line 981).
- **How it survives the SDK:** both are captured by our fetch wrapper directly, so neither depends on
  SDK plumbing. The SDK route is the cross-check: `result.response.id` / `step.response.id` carry the
  msg id and `result.response.headers['request-id']` the header, because
  `extractResponseHeaders` copies every header indiscriminately (R13 §2 lines 120-132).
- **The `ModelInvocation` is keyed on `messageId`**, per P1 §4.1 (lines 85-87: "keyed on the
  provider's own id wherever one exists") and `usage-dedupe.ts`'s measured rule. A failed attempt has
  no message id and is keyed on `(invocationId, attempt)` (§7).
- **Header absent → field absent, never synthesised.** `requestId` is omitted and the absence is
  counted (`provider.request_id_missing`). Usage confidence is unaffected (the usage was still read
  off the body, exact). Any cross-layer correlation that must then fall back on
  `(agentId, startedAt, model)` is marked `inferred` (M §13.3 lines 441-444; M §22.1 lines
  1003-1005). On a failed attempt, the body's `request_id` is used when the header is absent, and
  `raw.ts` records which one supplied it.
- **A 2xx body with no `id` is `response-unreadable`**, not a completed invocation with a made-up
  identity: R12 documents `id` as always present on a `Message`.

### 4.5 The retry the runtime owns

```ts
// packages/core/src/provider/retry-plan.ts
interface RetryPolicy { maxAttempts: 3; baseDelayMs: 2000; factor: 2; maxDelayMs: 30_000; maxElapsedMs: 60_000 }
type RetryDecision =
  | { retry: true; delayMs: number; reason: 'retry-after' | 'backoff' }
  | { retry: false; reason: 'not-retryable' | 'attempts-exhausted' | 'retry-after-exceeds-budget'
                          | 'elapsed-exhausted' | 'aborted' }
decideRetry(input: { attempt: number; error: ProviderError; elapsedMs: number; policy: RetryPolicy }): RetryDecision
```

Rules:

- **`maxRetries: 0` on the SDK, always** (OD D3 line 37; M §22.1.1 condition 4). `retry.ts` calls
  `invokeOnce` once per attempt, emits that attempt's events, asks `decideRetry`, sleeps (abortably),
  and loops. The SDK's own loop would make a failed attempt invisible (R13 §5 lines 217-224).
- **Each attempt is its own `model.invoked` + `model.completed | model.failed`**, with its own
  `attempt` number and its own `requestId`. Three attempts are six events, never one event with a
  count.
- **Only a kind marked retryable in §4.3 is retried.** `retry-after` (seconds, R12 §1.6 line 192)
  wins over backoff when present; a `retry-after` beyond `maxDelayMs` or beyond the remaining
  elapsed budget ends the loop with that reason, and the failure carries `retryAfterMs` so a surface
  can say when to try again. Backoff is `baseDelayMs × factor^(attempt-1)` capped at `maxDelayMs`.
- **The numbers are targets, chosen to match the vendors' own defaults**: 2 retries (R12 §1.7 lines
  228-230: official SDKs retry twice), 2000 ms initial and factor 2 (R13 §5 lines 213-214, the AI
  SDK's own defaults). They are a policy object, not constants scattered in `retry.ts`.
- **No idempotency key is sent, so an ambiguous attempt is NOT retried in B1.** The AI SDK sends none
  (R13 §5 lines 231-241). R13 asserts Anthropic accepts an `Idempotency-Key` header but cites no
  Anthropic page, and R12 is silent (O-1). Until that is verified, B1 retries only attempts whose
  outcome is known: an HTTP error response was read (`usageOutcome: 'none-reported'`), or the
  request provably never left (`network` with `requestSent === false`). `client-timeout` and a
  `network` failure after the request left end the loop — a second request after a first that may
  have completed server-side would bill twice with nothing to reconcile against.
- **An ambiguous attempt is recorded as maybe-billed, never as free.** Its `model.failed` carries
  `usageOutcome: 'unknown'` and no usage; the projection counts it in an `unknownOutcomeAttempts`
  figure beside the invocation totals, so "cost of this call" reads as "at least X, plus N attempts
  whose billing is unknown" rather than a clean number that is quietly short.
- **Abort ends the loop immediately** and is never retried, matching the SDK's own guard (R13 §6
  lines 254-256). An abort during a backoff sleep emits no new `model.invoked`.
- **`decideRetry` is pure** and receives `elapsedMs`; `retry.ts` owns the clock and the sleep.

### 4.6 Edit policy — the slot

```ts
// packages/core/src/provider/edit-policy.ts
type EditableKind = 'tool-result' | 'tool-input' | 'reasoning' | 'assistant-text'
interface EditPolicy {
  provider: ProviderId
  kinds: Record<EditableKind, 'replaceable' | 'immutable' | 'unverified'>
  status: 'declared-unverified' | 'measured'
  verifiedAt?: string            // required when status === 'measured'
  source: string                 // the doc or measurement the declaration rests on
}
```

- **Every `ProviderClient` declares one** (`capabilities.editPolicy`), because CM §7 (lines 220-226)
  requires each provider adapter to state which content kinds may be replaced in place, and the
  context manager may never edit a kind its provider declares immutable.
- **Anthropic's is declared, UNVERIFIED:** `reasoning: 'immutable'` (CM §7 lines 216-218 cites
  Anthropic's documentation that editing earlier turns can invalidate later reasoning blocks on its
  newest models; the signed `signature_delta` of R12 §1.3 lines 125-129 is the mechanism),
  `assistant-text: 'immutable'` (CM §7 line 227: never rewritten, a product rule not an API one),
  `tool-result: 'unverified'`, `tool-input: 'unverified'`, `status: 'declared-unverified'`. The
  measurement ("send an edited history, check it is accepted and the reasoning survives", CM §7 line
  225) belongs to the context-manager phase.
- **B1 rewrites no history.** `ProviderRequest.messages` is sent verbatim; nothing in B1 reads the
  policy. The type exists so the context manager plugs into a declared slot rather than widening
  `ProviderClient` later.

## 5. The per-provider usage table

From research 12 (primary-source reads of each vendor's pages) and research 13 (what the AI SDK's typed shape does with each field). **Every cell is traceable to a research section; a cell neither supports reads "not in research 12/13 — open".** The Anthropic row is exact and is what B1 implements; every other row is B5's, to be verified at implementation.

### 5.1 Anthropic — exact field map (B1 ships this)

Source for this whole sub-table unless noted otherwise: research/12-provider-apis.md §1
(Anthropic — Messages API), cross-checked against research/13-ai-sdk-fidelity.md §1–2 for what the
AI SDK's typed shape does with each field.

| Canonical field (`ModelCompletedData`) | Raw JSON path | Included in / excluded from | Non-streaming | Streaming location | AI SDK v4 typed field | Research citation |
|---|---|---|---|---|---|---|
| `usage.input` | `usage.input_tokens` | **EXCLUDES** `cache_creation_input_tokens` and `cache_read_input_tokens` — documented formula: `total_input_tokens = cache_read_input_tokens + cache_creation_input_tokens + input_tokens` | top-level `usage.input_tokens` | `message_start.usage.input_tokens` (present at start; not repeated as a delta — see below) | `LanguageModelV4Usage.inputTokens.noCache` (via `convertAnthropicUsage`) | research 12 §1.1, §1.6; research 13 §1 |
| `usage.output` | `usage.output_tokens` | **INCLUDES** thinking-block tokens — no separate `thinking_tokens` field exists in the public Messages API usage object | top-level `usage.output_tokens` | `message_start.usage.output_tokens` is a **non-final placeholder** (docs' own example shows `1` or `2`); the **last `message_delta.usage.output_tokens`** is authoritative and is documented **CUMULATIVE**, never additive across deltas | `LanguageModelV4Usage.outputTokens.total` | research 12 §1.1, §1.3 ("TRAP" paragraph) |
| `usage.cacheRead` | `usage.cache_read_input_tokens` | Billed at 0.1× base input (0.025× for Fable 5.1/Mythos 5.1); NOT counted toward ITPM rate limits except Haiku 3.5 | top-level | repeated in the final `message_delta.usage` alongside input side when present (docs' server-tool example) | `LanguageModelV4Usage.inputTokens.cacheRead` (`convert-anthropic-usage.ts`) | research 12 §1.1, §1.5, §1.6; research 13 §1 |
| `usage.cacheWrite` | `usage.cache_creation_input_tokens` | Flat SUM of the two per-TTL buckets below; always present once ANY cache write occurs | top-level | same placement as cache_read | `LanguageModelV4Usage.inputTokens.cacheWrite` | research 12 §1.1, §1.5 |
| `cacheWriteByTtl['ephemeral_5m']` | `usage.cache_creation.ephemeral_5m_input_tokens` | Sub-component of `cache_creation_input_tokens`; the nested `cache_creation` object **only appears when a request writes to both TTL buckets or a 1h-TTL write occurs** — it is NOT unconditionally present the way the flat counter is | top-level, conditional | same object, conditional | **NOT modeled as a typed field.** Declared nowhere in the AI SDK's zod schema for the usage object (`z.looseObject` — no `cache_creation` key declared); survives only as an untyped extra key inside `providerMetadata.anthropic.usage` and inside `LanguageModelV4Usage.raw` (`raw: rawUsage ?? usage`, defaulting to the full parsed object since no call site passes `rawUsage`) | research 12 §1.1, §1.5; research 13 §1 (the `z.looseObject` schema quote, lines ~65–85) |
| `cacheWriteByTtl['ephemeral_1h']` | `usage.cache_creation.ephemeral_1h_input_tokens` | Same as above | top-level, conditional | same | same — raw passthrough only | research 12 §1.1, §1.5; research 13 §1 |
| server tool use counters | `usage.server_tool_use.web_search_requests` | A COUNT, not a token figure; appended only when a server tool (web search) ran | top-level | confirmed live in the docs' own streamed `message_delta.usage` SSE example | **NOT in the AI SDK v4 usage-mapping table research 13 documents** (`convertAnthropicUsage`'s confirmed field list covers only `cache_creation_input_tokens`/`cache_read_input_tokens`) → not in research 12/13 — open whether it is typed or raw-only | research 12 §1.1, §1.3 |
| `iterations` (advisor/compaction sub-calls) | `usage.iterations[]` (each with its own token counts and optionally its own `model`; kinds `compaction`/`message`/`advisor_message`/`fallback_message`) | **Deliberately EXCLUDED from the top-level totals** by the AI SDK's `convertAnthropicUsage` ("Advisor tokens are NOT rolled into the top-level totals because they bill at a different rate") — these are real, separately-billed tokens absent from `usage.inputTokens`/`outputTokens` | declared in the AI SDK's own zod schema (`z.array(...).nullish()`) | not covered | `AnthropicUsageIteration[]` under `providerMetadata.anthropic.iterations` — this IS typed, unlike the TTL buckets | **research 12 §1.1 does not mention `iterations` at all** (it was fetched directly from Anthropic's own docs and lists only the six fields quoted at the top of §1.1) — **research 13 §1 is the only source for this field**, sourced from the AI SDK's zod schema and an internal SDK code comment, not from a primary Anthropic doc page fetched in this pass. **Flagged as an open item below** — see §5.3 |
| `providerRequestId` | HTTP header **`request-id`** (lowercase, no prefix) | Also carried as `id` (`msg_...`) on the response body (a different id — the message id, not the request id) and as `request_id` (snake_case) inside error bodies only | response header on every call | same header on the (single) HTTP response backing an SSE stream | `LanguageModelV4ResponseMetadata` does not carry the header itself; the header is read generically via `extractResponseHeaders()` → `result.response.headers['request-id']` (indiscriminate passthrough of every header, not a curated field) | research 12 §1.2; research 13 §2 |
| `model` (message id) | top-level `id` (`msg_...`) | This is the **message id**, distinct from the request-id header above | top-level | present on `message_start.message.id` | `LanguageModelV4ResponseMetadata.id`, surfaced as `result.response.id` / per-step `step.response.id` | research 12 §1.2; research 13 §2 |
| `model` (model id) | top-level `model` | May differ from the requested model if a server-side fallback occurred (Claude Fable content-block fallback case) | top-level | present on `message_start.message.model` | `result.response.modelId` / typed `model` field per §6 comparison table | research 12 §1.2, §1.3 (fallback content block), §6 comparison row |
| `status`/stop reason | `stop_reason` | 7-value enum: `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn` (server-tool loop continuation — NOT the same as `tool_use`), `refusal` (check sibling `stop_details.category`), `model_context_window_exceeded` | top-level, final only | carried on the final `message_delta.delta.stop_reason` | mapped into the SDK's own `finishReason` vocabulary (not itemized field-by-field in research 13; research 13 does not enumerate the SDK's stop-reason mapping for Anthropic specifically) | research 12 §1.8, §6 comparison row — **the AI SDK's own finishReason mapping for these 7 values is not in research 12/13 — open** |
| service tier | — | **Not in research 12/13 for Anthropic** — research 12 documents a Priority Tier only as a parallel *rate-limit header* family (`anthropic-priority-*`), never a `service_tier` field on the usage/response body itself (that field is documented for **Google**, §5.2 below, not Anthropic) | — | — | — | not in research 12/13 — open |

#### Normalisation rule into canonical `usage` (four counters, input excludes cache)

Per research 12 §1.1 and §1.6, Anthropic's own documented formula is:

```
total_input_tokens = cache_read_input_tokens + cache_creation_input_tokens + input_tokens
```

`input_tokens` already excludes both cache counters by definition — Anthropic is the **one**
provider among those research 12 covers whose `input` field is cache-exclusive on the wire; every
other provider's equivalent field already includes its cache sub-count (research 12 §6 comparison
table, row `input`, and §7 trap #2). So the canonical mapping for B1 requires **no subtraction** for
Anthropic — `usage.input = input_tokens`, `usage.cacheRead = cache_read_input_tokens`,
`usage.cacheWrite = cache_creation_input_tokens`, `usage.output = output_tokens` — but the
provider-boundary code that does this must still perform the (provider-specific) subtraction for
every other provider once B5 lands, per master §14.2's "input is normalised to EXCLUDE the cache
counters, per provider on the way in" rule.

#### What "context tokens" is for Anthropic

Research 12 §1.1 documents Anthropic's own formula for `total_input_tokens` (quoted above) as the
rate-limit-relevant total of the **last** call's input side. The product's existing convention
(carried over from the JSONL-based adapter, not itself part of research 12/13's scope) computes the
context gauge as `input + cache_creation + cache_read` of the last turn — this is **arithmetically
identical** to Anthropic's own documented `total_input_tokens` formula, so it is **CONFIRMED against
research 12 §1.1**: reading the last call's `usage.input_tokens + usage.cache_creation_input_tokens +
usage.cache_read_input_tokens` is exactly Anthropic's own stated total-input-tokens figure, and
`ModelCompletedData.contextTokens` for Anthropic should be populated from that same sum, taken as a
**gauge from the most recent `model.completed` event only, never summed across events** (master
§14.2's own rule for the field, consistent with research 13 §1's finding that Anthropic reports
usage as a per-call object, not a running total, outside of `message_delta`'s in-stream cumulation).

---

### 5.2 Other providers — B5, to be verified at implementation

All rows below are from research/12-provider-apis.md §2–5 and are marked **B5 — to be verified at
implementation**: none of this has been exercised against a live API call, several fields are
themselves marked UNVERIFIED inside research 12, and master §22.1's own summary table (quoted for
comparison in §5.3 below) sometimes states things research 12 does not settle.

#### OpenAI — Responses API (OpenAI's forward direction per research 12 §2)

| Canonical field | Raw field | Includes cache? (→ subtract) | Reasoning field + billing | Request-id header | In-band cost | Streaming usage placement |
|---|---|---|---|---|---|---|
| input | `usage.input_tokens` | **INCLUDES** `input_tokens_details.cached_tokens` as a sub-count → **subtract** to get true non-cache input | — | `x-request-id` (confirmed header, response-side); `X-Client-Request-Id` is a REQUEST-side id the caller may set | none documented for OpenAI directly | **UNVERIFIED** whether `usage` appears only on `response.completed` or also earlier — research 12 §2.3 states this is the "practical" reading but explicitly not confirmed against a live stream |
| output | `usage.output_tokens` | — | `output_tokens_details.reasoning_tokens` — billing = **included-in-output** ("Reasoning tokens are counted as output tokens and included within the total `output_tokens` count", verbatim from the reasoning guide) | — | — | same as above |
| cache read | `input_tokens_details.cached_tokens` | n/a (this IS the cache counter) | — | — | — | placement UNVERIFIED (see input row) |
| cache write | `input_tokens_details.cache_write_tokens` | n/a | — | — | — | **documented only for GPT-5.6+; UNVERIFIED whether present for older Responses-API models** (research 12 §2.1) |
| `total_tokens` | `usage.total_tokens` | Real field (unlike Anthropic); **UNVERIFIED from fetched docs whether it includes the cached sub-count**, though research 12 infers "yes" from the cache-hit-rate formula's wording | — | — | — | — |

#### OpenAI — Chat Completions (older, still-dominant format; not independently re-fetched this pass)

| Canonical field | Raw field | Includes cache? | Reasoning field + billing | Request-id header | In-band cost | Streaming usage placement |
|---|---|---|---|---|---|---|
| input | `usage.prompt_tokens` | **INCLUDES** `prompt_tokens_details.cached_tokens` → subtract | — | `x-request-id` (same header family as Responses API) | none | trailing chunk only, and only when `stream_options.include_usage: true` was requested — `choices` empty on that chunk, followed by literal `data: [DONE]` |
| output | `usage.completion_tokens` | — | `completion_tokens_details.reasoning_tokens` — billing = **included-in-output** (same trap as Responses API; not independently re-verified for Chat Completions specifically in this pass, but research 12 states the shape is well-established/OpenAI-compatible) | — | — | same |
| cache read | `prompt_tokens_details.cached_tokens` | n/a | — | — | — | — |
| cache write | not exposed | — | — | — | — | Chat Completions pre-5.6 writes are free/automatic with no counter |

#### Google Gemini (`generateContent`/`streamGenerateContent`, NOT the newer snake_case "Interactions API")

| Canonical field | Raw field | Includes cache? (→ subtract) | Reasoning field + billing | Request-id header | In-band cost | Streaming usage placement |
|---|---|---|---|---|---|---|
| input | `usageMetadata.promptTokenCount` | **UNVERIFIED** from fetched docs whether it includes `cachedContentTokenCount` — research 12 §3.1 gives an inference (probably includes it, since it's a resource-backed cache, not an in-band prefix match) but explicitly says "this is inference, not a confirmed doc statement. Verify empirically before billing off it." | — | — | none documented | **UNVERIFIED** whether `usageMetadata` appears on every chunk (cumulative) or only the last one — not stated in the fetched reference page (research 12 §3.3) |
| output | `usageMetadata.candidatesTokenCount` | **EXCLUDES** `thoughtsTokenCount` — it is a separate top-level sibling, not a sub-count | `thoughtsTokenCount` — billing = **additive** (thinking-guide states response pricing is "the sum of output tokens and thinking tokens", verbatim) — this is the OPPOSITE direction from OpenAI's sub-count trap | — | — | same as input row |
| cache read | `usageMetadata.cachedContentTokenCount` | n/a | — | **No documented request-id / correlation-id header was found** — research 12 §3.2 calls this a "genuine capability gap," left as an open item since live headers were not fetched | — | — |
| cache write | not clearly separated from `promptTokenCount` in the fetched schema | — | — | — | — | — |
| extra | `toolUsePromptTokenCount` (extra input tokens for tool-call scaffolding, a sibling count, NOT nested inside `promptTokenCount`); `serviceTier` field is present in the quoted `usageMetadata` JSON shape but its values/meaning are not documented in the fetched excerpt | — | — | — | — | — |

#### OpenRouter (normalizes to, and extends, the OpenAI Chat Completions shape)

| Canonical field | Raw field | Includes cache? | Reasoning field + billing | Request-id header | In-band cost | Streaming usage placement |
|---|---|---|---|---|---|---|
| input | `usage.prompt_tokens` | OpenAI semantics — includes cache sub-count | — | **No dedicated response header found documented** (research 12 §4.2) — response `id` is `gen-`-prefixed instead, and may be `null` pre-routing on some API "skins" | `usage.cost` (total credits charged, includes OpenRouter's own markup) AND `cost_details.upstream_inference_cost` (what the upstream provider actually charged) — **unique to OpenRouter among all providers surveyed**, `costSource: 'provider'` per master §22.1 | usage is on the **last SSE message only** ("included in the last SSE message for streaming responses, or in the complete response for non-streaming requests") |
| output | `usage.completion_tokens` | — | `completion_tokens_details.reasoning_tokens` — OpenAI semantics (included-in-output) | — | — | — |
| cache read | `prompt_tokens_details.cached_tokens` | — | — | — | — | — |
| cache write | `prompt_tokens_details.cache_write_tokens` | — | — | — | — | — |
| mid-stream error | in-band `error` field on an HTTP 200 chunk, `finish_reason: "error"` | — | — | — | — | **a status-code-only check will read a failed generation as successful** — explicit documented gotcha, research 12 §4.3 |

#### LiteLLM (proxied)

Research 12 does **not** cover LiteLLM as its own primary-source section (§1–5 cover Anthropic,
OpenAI, Google, OpenRouter, Ollama only). Master §22.1's table row ("LiteLLM | proxied | proxied |
proxied | proxied | `response_cost` in callbacks") is therefore **not corroborated by research
12/13 at all** — see §5.3, contradiction/gap list.

#### Ollama (local, no billing)

| Canonical field | Raw field | Includes cache? | Reasoning field + billing | Request-id header | In-band cost | Streaming usage placement |
|---|---|---|---|---|---|---|
| input | `prompt_eval_count` | n/a — `prompt_eval_cached_count` is a **local KV-cache hit counter with no monetary discount**, latency-only | — | **None — confirmed absence**, no request-id concept exists at all (research 12 §5.2) | none — no billing concept | NDJSON stream, one JSON object per line, `done: false` until the terminal object which carries `done: true` plus full duration/count accounting; `"stream": false` collapses to one object |
| output | `eval_count` | — | **No separate reasoning/thinking counter documented** for Ollama's own API surface — UNVERIFIED, not covered in the fetched `api.md` excerpt | — | — | — |
| durations | `total_duration`, `load_duration`, `prompt_eval_duration`, `eval_duration` | **all in NANOSECONDS** — a shared `durationMs` field needs an explicit `/1e6` conversion for Ollama alone | — | — | — | `done_reason` mixes real stop reasons (`stop`, `length`) with OPERATIONAL states reusing the same field (`load`, `unload`) — must be filtered before treating the field as "why did generation end" |

---

### 5.3 Contradictions and gaps (U-n)

Every item below is either (a) a direct disagreement between two of the three source documents, or
(b) a place where the master spec states something as settled that research 12/13 do not support, or
mark UNVERIFIED, or are silent on. None are resolved here — each is left as an OPEN item.

1. **U-1. Master's provider table does not distinguish OpenAI Responses API from Chat Completions, and
   its field names are Responses-API-shaped while OpenAI actually exposes two different field names
   depending on which API is used.**
   - Master, `specs/2026-09-19-agentistics-runtime-master.md:982`: `| OpenAI | usage.input_tokens |
     usage.output_tokens | input_tokens_details.cached_tokens | — |
     output_tokens_details.reasoning_tokens inside output |` — one unlabeled "OpenAI" row.
   - Research 12 §2.1 documents **two distinct shapes**: Chat Completions uses `prompt_tokens` /
     `completion_tokens` / `prompt_tokens_details.cached_tokens` /
     `completion_tokens_details.reasoning_tokens`; the Responses API uses `input_tokens` /
     `output_tokens` / `input_tokens_details.{cached_tokens,cache_write_tokens}` /
     `output_tokens_details.reasoning_tokens`. These are different field names, not two spellings of
     one thing.
   - **OPEN**: master's table silently picks the Responses-API field names with no Chat-Completions
     row, so an implementer following the master table alone would build a Chat-Completions client
     that reads the wrong keys (`prompt_tokens` vs `input_tokens`) if that path is ever used.

2. **U-2. Master states Google's `promptTokenCount` mapping with no caveat; research 12 marks the same
   fact UNVERIFIED and says it must be checked empirically before billing off it.**
   - Master, line 983: `| Google | promptTokenCount | candidatesTokenCount | cachedContentTokenCount
     | — | thoughtsTokenCount, toolUsePromptTokenCount |` — presented as a settled mapping table row,
     with no note that whether `promptTokenCount` includes the cached portion is unknown.
   - Research 12 §3.1: *"UNVERIFIED from the fetched pages whether it INCLUDES
     cachedContentTokenCount ... this is inference, not a confirmed doc statement. Verify
     empirically before billing off it."*
   - **OPEN**: the master table's flat presentation loses research 12's explicit uncertainty flag —
     an implementer reading only the master spec would not know this needs empirical verification
     before it can be trusted for cost math.

3. **U-3. `iterations` (Anthropic advisor/compaction sub-calls) appears only in research 13 (via the AI
   SDK's zod schema and an internal code comment), and is absent from research 12's direct read of
   Anthropic's own primary docs — its status as a real, documented Messages API field is unconfirmed.**
   - Research 13 §1 (lines ~65–96): quotes the AI SDK's zod schema declaring
     `iterations: z.array(...).nullish()` and states Anthropic returns per-iteration usage for
     `compaction`/`message`/`advisor_message`/`fallback_message` sub-calls, with advisor tokens
     deliberately excluded from top-level totals by the SDK.
   - Research 12 §1.1, which was fetched directly from `platform.claude.com/docs/en/api/messages.md`
     (Anthropic's own primary source), lists exactly six usage fields (`input_tokens`,
     `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation`,
     `server_tool_use`) and **does not mention `iterations` anywhere**.
   - Master, `specs/2026-09-19-agentistics-runtime-master.md:1021-1026` (§22.1.1, point 2), adopts
     research 13's finding as an action item ("Read `providerMetadata.anthropic.iterations`, or
     under-report") but master's own §22.1 usage-mapping table (line 981) does **not** list
     `iterations` as an Anthropic field at all.
   - **OPEN**: it is unclear whether `iterations` is (a) a genuinely documented but not-yet-fetched
     part of the Messages API (e.g. tied to `pause_turn`/server-tool continuation, or a newer
     compaction feature not covered by the fetched page), or (b) an AI-SDK-internal/forward-looking
     schema field not yet exercised against real Anthropic traffic. This needs a direct, fresh fetch
     of Anthropic's usage-object reference (or a live API call) before B1 can decide whether to
     read it at all.

4. **U-4. Master's `costSource` type in §14.2 does not include the value its own prose assigns two
   sentences later.**
   - Master, `specs/2026-09-19-agentistics-runtime-master.md:581`: the `ModelCompletedData`
     interface declares `costSource?: 'provider' | 'harness'` — a two-value union.
   - Master, line 603-604 (same section, §14.2 bullet list): *"`costUSD` is present only when
     somebody else computed it. Otherwise the projection prices it through `calcCost` and marks
     `costSource: 'table'`."* — `'table'` is not one of the two values the type declares.
   - **OPEN**: this is an internal contradiction inside the master spec itself (not a research
     disagreement), between the `ModelCompletedData` type definition and its own explanatory prose.
     Also note §22.1 (line 984) uses a third convention, `costSource: 'provider'`, for OpenRouter's
     in-band `usage.cost` — consistent with the type's `'provider'` value, which sharpens that the
     type is missing (at least) the `'table'` case the prose requires.

5. **U-5. Anthropic's per-TTL `cache_creation` breakdown is conditionally present per research 12, but
   master's field comment reads as if it is a stable, always-available breakdown.**
   - Research 12 §1.1: *"the nested `cache_creation` object is the finer breakdown [that] only
     appears when a request actually writes to both TTL buckets or a 1h-TTL write occurs (the flat
     `cache_creation_input_tokens` is always present once any cache write occurs; the nested
     `cache_creation` object is the finer breakdown)."*
   - Master, line 573: `cacheWriteByTtl?: Record<string, number>   // Anthropic reports ephemeral_5m
     / ephemeral_1h` — the field is optional (`?`), which is consistent with conditional presence,
     but the comment does not carry research 12's specific conditionality rule (both-TTL-write or
     any-1h-write), which an implementer would need to correctly treat a missing `cacheWriteByTtl`
     as "no TTL breakdown was returned" rather than "no cache write occurred at all" (the flat
     `cacheWrite` counter is the one that answers that question).
   - **OPEN** (minor): not a contradiction, but master's comment underspecifies the condition
     research 12 documents; worth carrying the exact conditionality into the implementation.

6. **U-6. LiteLLM's row in master's §22.1 table has no corroborating research-12 section at all.**
   - Master, line 985: `| LiteLLM | proxied | proxied | proxied | proxied | response_cost in
     callbacks |`.
   - Research 12 §1–5 covers exactly five providers (Anthropic, OpenAI, Google, OpenRouter, Ollama)
     and its own header states "Anthropic, OpenAI, Gemini, OpenRouter and Ollama follow" — LiteLLM
     is not one of the sections. `response_cost in callbacks` cannot be traced to any research 12
     citation.
   - **OPEN**: not in research 12/13 at all — this entire row is unverified and must be researched
     fresh before B5 implements LiteLLM support.

7. **U-7. OpenRouter's own documentation set is internally inconsistent about whether Gemini caching
   through OpenRouter is automatic or requires a manual breakpoint, and research 12 flags this
   itself rather than resolving it — worth carrying forward as an open item since master's table
   does not mention OpenRouter-routed-Gemini caching at all.**
   - Research 12 §4.5: *"Google Gemini also listed under 'manual breakpoint' providers for
     OpenRouter specifically, which appears to CONTRADICT §3.5's 'Gemini 2.5+ implicit by default'
     ... treat as UNVERIFIED which of the two claims governs actual billing behavior when routing
     Gemini through OpenRouter."*
   - Master §22.1 does not mention this case at all (its OpenRouter row is silent on a
     per-upstream-model caching-mode distinction).
   - **OPEN**: carried over verbatim from research 12; not addressed anywhere in master.

8. **U-8. Master's stop-reason handling for Anthropic's 7-value enum is stated as a requirement
   ("Stop-reason branching for `tool_use` vs `pause_turn` vs `refusal`") but the actual mapping onto
   whatever finish-reason vocabulary the runtime or the AI SDK will use is not specified in
   research 12/13 or master.**
   - Research 12 §1.8 documents the raw enum; research 12 §7 trap #6 documents the *consequence* of
     conflating `pause_turn` and `tool_use` (wrong continuation shape) but does not map the enum onto
     any canonical vocabulary.
   - Research 13 does not discuss Anthropic's finish-reason mapping into the AI SDK's own
     `finishReason` type at all (its §3 "Streaming" section covers the stream-part vocabulary
     generically, not the Anthropic-specific stop-reason translation).
   - Master does not define a canonical `stopReason` enum for `ModelCompletedData` in the excerpt
     read (§14.2's interface has no `stopReason` field at all — the `status: 'completed' | 'failed'`
     field is the only outcome discriminator shown).
   - **OPEN**: neither research document nor the read master sections specify where Anthropic's
     `stop_reason` value lands in `ModelCompletedData`, or whether a separate field is needed to
     preserve `pause_turn` vs `tool_use` vs `refusal` (with `stop_details.category`) as distinct,
     since `status: 'completed' | 'failed'` alone cannot distinguish them.

9. **U-9. Service tier**: Google's `usageMetadata` JSON example in research 12 §3.1 includes a
   `serviceTier` key, but research 12's prose never explains what values it takes or what it means;
   master does not mention `serviceTier` for any provider. **Not in research 12/13 — open** for both
   Google's meaning and whether Anthropic has an equivalent (Anthropic's rate-limit headers document
   a "Priority Tier" mirror header family, `anthropic-priority-*`, but that is a *rate-limit*
   concept, not a response-body service-tier field — research 12 §1.6).

10. **U-10. Server tool use counters (`server_tool_use.web_search_requests`) and Anthropic's `iterations`
    array are absent from the AI SDK's documented typed-field table in research 13 §1**, which lists
    only cache-creation/cache-read as the confirmed typed Anthropic fields — so it is unconfirmed
    whether B1, if it uses the AI SDK, gets `server_tool_use` as anything other than raw passthrough.
    **Not in research 12/13 — open**, tracked separately from U-3 above because `iterations` and
    `server_tool_use` are two different unresolved fields with two different open questions
    (existence/documentation status for `iterations`; typed-vs-raw status for `server_tool_use`).

## 6. Credentials

### 6.0 The boundary this section implements

Master spec §22.3 (`specs/2026-09-19-agentistics-runtime-master.md:1058-1079`) quotes Anthropic's
terms and derives four rules; D3 (`specs/2026-09-25-owner-decisions.md`, "API cost and the first
provider") narrows B1 to **Anthropic only, the owner's own API key, a spend limit set in the provider
console**. Everything below is the mechanical form of those two texts:

1. The only credential B1 ever sends is an **Anthropic API key the user entered into agentop
   themselves**. No OAuth token, no subscription session, no key picked up from another tool.
2. The key is stored with the `envelope-keys.ts` discipline — 0600, never logged, never audited,
   never returned (§22.3 rule 2) — and **tightened where that module is weaker than it claims**
   (§6.2.3).
3. `billing-detect.ts`'s source-grep guard is extended to the provider layer (§22.3 rule 4): the
   modules that hold the key are fixed and few, everything else is structurally unable to name it
   (§6.3).

### 6.1 Entry — one verb, never argv, never a web form, never a chat

**Syntax (proposed, B1.3 implements it in `packages/server/server/cli-provider.ts`):**

```
agentop provider key set anthropic            # hidden tty prompt (default)
agentop provider key set anthropic --stdin    # read ONE line from a pipe; no prompt
agentop provider key status [anthropic]       # presence + fingerprint, never the value
agentop provider key remove anthropic         # delete the stored key (§6.5)
```

Dispatch follows the existing top-level pattern in `packages/server/bin/cli.ts` — `command` is
`process.argv[2]` (`cli.ts:21-22`) and each verb is a lazy import that exits with its return code,
e.g. `hooks` (`cli.ts:449-453`), `events` (`cli.ts:455-459`), `backup` (`cli.ts:461-465`). B1 adds
one more block of the same shape: `if (command === 'provider') { const { runProvider } = await
import('../server/cli-provider.ts'); process.exit(await runProvider(args)) }`. `provider` is chosen
over `key` because B5 adds providers and the gateway (D11) will want `agentop provider …` verbs too.

**Rules, each with its reason:**

- **Never an argv argument.** A value on the command line lands in shell history and in
  `/proc/<pid>/cmdline` (readable by any process of the same user, and by `ps`). The repo already
  states and follows this for the GitHub PAT: `cli-backup.ts:648-650` — "The token is asked for
  HERE, never taken as an argv token — a value on the command line ends up in shell history and in
  `ps`." `runProvider` must **refuse** any extra positional after the provider id, in words ("a key
  is never accepted on the command line — run the command without it and paste at the prompt"),
  rather than ignore it; an ignored argument is a key that reached the history file and the user
  believes was used.
- **The hidden prompt already exists.** `cli-ui.ts:134-171` `maskedInput()` reads in raw mode with
  no echo (`cli-ui.ts:163`, "no echo — the whole point of this function") and is what
  `agentop backup github setup` uses (`cli-backup.ts:650`, `:893`, `:935`). B1 reuses it; no new
  prompt primitive is needed. **Two limits of it that B1 must handle, not inherit:**
  1. On a non-TTY stdin it silently falls back to the ECHOING `input()` (`cli-ui.ts:143-145`). For
     `--stdin` that is harmless (a pipe has no echo), but B1 must not reach the fallback by
     accident: without `--stdin`, a non-TTY stdin is **refused** ("no terminal to read a hidden key
     from — pipe it with --stdin"), never read through `input()`.
  2. It keeps every character `>= ' '` (`cli-ui.ts:163`) and drops ESC, so a terminal that wraps a
     paste in bracketed-paste markers would leave `[200~…[201~` inside the value. The pure
     `credential-plan.ts` therefore **validates shape** before anything is stored: non-empty, no
     whitespace or control characters, no `[`/`~` bracket-paste residue, begins with `sk-ant-`
     (the prefix `packages/core/src/redact.ts:59` already treats as an Anthropic key), and a
     length bound. A rejected value is refused in words that never echo it.
- **`--stdin` reads exactly one line** and is the scripted path (`pass show … | agentop provider key
  set anthropic --stdin`). The help text must say that `echo sk-ant-… |` puts the key in shell
  history — the pipe protects argv, not the command that feeds it.
- **`ANTHROPIC_API_KEY` in the environment is NOT accepted, implicitly or as a fallback.** Reasons:
  1. That variable already means something else on this machine: `billing-detect.ts:49` and
     `:108-109` read it (reduced to `'set'`) as a signal that **Claude Code** is billed by API key.
     It may be an employer's key configured for Claude Code. §22.3 rule 2 says keys are "entered by
     the user" — picking up another tool's key silently is not that, and it would spend money from
     a key the owner did not hand to agentop.
  2. `agentop server` often runs as a systemd user service (`autostart.ts`), whose environment is
     not the login shell's. An env fallback makes the same verb use a key from one launch path and
     none (or a different one) from another, with nothing on screen saying which.
  3. The SDK itself may read `ANTHROPIC_API_KEY` when no key is passed (to be verified at the pinned
     version — C-1). Accepting env on our side would hide that second implicit path.
  So: the provider layer never reads `process.env` for a credential, the Anthropic client always
  passes the key **explicitly**, and a test runs a call with `ANTHROPIC_API_KEY` set and no stored
  key and asserts it is **refused** (`no-credential`), not sent. An explicit, one-shot import
  (`--from-env <NAME>`, which reads a named variable once and stores it) is conceivable and is left
  as C-4, not built.
- **No web form in B1.** A route that accepts a key is a route that touches host secrets and would
  have to be registered in `capability-guard.ts` (its exact/prefix tables, `capability-guard.ts:16-98`),
  is reachable from any page the user visits on a local port (the same reason `preferences.ts:900-903`
  gives for redacting `GET /api/preferences`), and on a central under the `public` profile every
  local capability is `false` (`exposure.ts:84-87`). B1's delivery is a recorded call, not a
  settings screen; nothing in it needs a browser. **B1 adds no `/api` route at all.** It does add
  one prefix row, `['/api/provider', 'localShell']`, to `capability-guard.ts` so the first provider
  route anyone writes later is guarded by having been ADDED — the precedent and its test are
  `capability-guard.test.ts:194` ("a shell route nobody has written yet is guarded by having been
  ADDED").
- **Nobody is ever asked to paste a key into a chat, an issue, a task comment or a file.** This is
  stated in the verb's help and in the B1 dispatch prompts: an agent session implementing B1 never
  receives the owner's key. Every step that needs a live key (fixture recording, the live test, the
  reconciliation) is a command **the owner runs**, reading the key from the store (§15, B1.5/B1.7/B1.8).

### 6.2 Storage

#### 6.2.1 Where, and why not `preferences.json`

- **Path:** `~/.agentistics/provider-keys/anthropic.json`, built in `config.ts` as
  `export const PROVIDER_KEYS_DIR = join(AGENTISTICS_DATA_DIR, 'provider-keys')` plus a
  `providerKeyFile(provider)` helper that accepts only a closed `ProviderId` (the `safeConnId`
  pattern, `config.ts` — interpolate into a path only after a check). Deriving from
  `AGENTISTICS_DATA_DIR` (`config.ts:53-54`), **never** `HOME_DIR` directly and **never**
  `CLAUDE_DIR` (`config.ts:13`, which can be a container's read-only mount of someone else's
  `~/.claude`), is `config.ts`'s own stated rule (`config.ts:55`).
- **Why a `join(AGENTISTICS_DATA_DIR, '…')` literal matters:** `backup-coverage.lint.test.ts:23-43`
  finds every path the server writes under `~/.agentistics` by grepping for exactly
  `join(AGENTISTICS_DATA_DIR, '<name>'` or `'.agentistics', '<name>'`, and fails
  (`:51-60`) unless each is carried by a backup source or excluded with a reason. Building the path
  that way is what makes forgetting the backup decision a red build (§6.2.4).
- **One file per provider, JSON** `{ "v": 1, "provider": "anthropic", "value": "<key>",
  "storedAt": "<ISO>" }`. Not a `.key` extension: `backup-plan.ts:259-261` has a `contains: '.key'`
  secret rule whose `restoreWith` names control-socket tokens, and `excludeFor` is first-match-wins
  (`backup-plan.ts:406-416`), so a `.key` file would be excluded with the wrong restore sentence.
- **Not in `preferences.json`, for four independent reasons read from the code:**
  1. It is SERVED — `GET /api/preferences` returns it through `redactPreferences`
     (`preferences.ts:900-915`), which blanks exactly the fields it knows about
     (`team.connections[].token`, `team.token`). A new secret field there is one forgotten line in
     that function away from being returned to any page on a local port.
  2. It is written with the **default mode**: `writeFileAtomic` creates its tmp file with plain
     `writeFile(tmp, text, 'utf-8')` (`preferences.ts:468-473`), no `mode`, then renames it.
  3. It travels in every backup (redacted, staged by `cli-backup.ts` — `backup-plan.ts:150-158`,
     `backup-coverage.lint.test.ts:54-56`), again through a redaction list that must know the field.
  4. It is a shallow merge across top-level keys under a cross-process lock
     (`preferences.ts:835-846`), hand-editable, and read by many modules — the opposite of "a few
     named holders".
  `envelope-keys.ts:5-8` and `config.ts` (the `envelopeKeyFile` doc comment) make the same choice
  for the machine private key for reason 1; `github-store.ts:1-8` makes it for the GitHub PAT.

#### 6.2.2 Modes

- **Directory `0700`**, file **`0600`**. `mkdir(PROVIDER_KEYS_DIR, { recursive: true, mode: 0o700 })`
  followed by an explicit `chmod(dir, 0o700)` (mkdir's mode is masked by umask and ignored when the
  directory exists).
- **Explicit `chmod(file, 0o600)` after every write.** `writeFile`'s `mode` only applies on CREATE;
  `github-store.ts:107-118` documents exactly this and chmods after every write, and
  `github-store.test.ts:54-69` asserts 0600 after first write AND after a rotation.
- **On read, a file whose mode has any group/other bit (`mode & 0o077 !== 0`) is REFUSED** in words
  naming the fix (`chmod 600 <path>`), the way ssh treats a private key. `status` shows the refusal
  as its own state (`present, permissions too open (0644)`). The WSL/DrvFs caveat that
  `envelope-keys.ts:36` swallows (`chmod(...).catch(() => {})`) is C-5: B1 does not swallow
  a failed chmod on a credential; it reports it and refuses.

#### 6.2.3 Atomic write — better than the precedent

`envelope-keys.ts:32-37` `writePrivate` is `mkdir` (no mode) + `writeFile(path, body, {mode:
0o600})` + a best-effort chmod: **not atomic** (a crash mid-write leaves a truncated key) and the
directory mode is whatever umask gives. `preferences.ts:468-473` is atomic but its tmp file is
created at the default mode, so for the interval before `rename` a copy of the content is readable
by group/other. B1's `credentials.ts` combines the two correctly:

1. `open(tmp, 'wx', 0o600)` in the **same directory** (so `rename` is atomic on one filesystem), tmp
   name unique per call (`preferences.ts:459-467` explains why pid alone is not enough);
2. write, `fsync`, close;
3. `rename(tmp, final)`; `chmod(final, 0o600)`;
4. on any failure, `unlink(tmp)` and report — never leave a tmp copy behind. A leftover tmp is
   still covered by the backup exclusion because the prefix rule is on the directory (§6.2.4) — and
   `backup-plan.ts:283` excludes `.tmp-` anyway as regenerable — but the unlink is the rule, the
   exclusion is the net.

Concurrent `set` from two processes: last `rename` wins, both files were complete; no lock is needed
for one small file (contrast `preferences.ts`, which read-modify-writes a shared document).

#### 6.2.4 Backup — excluded as `secret`, with the command that re-establishes it

B1.3 adds one row to `CROSS_HARNESS_SECRETS` (`backup-plan.ts:140-…`), shaped like the GitHub PAT
row (`backup-plan.ts:160-165`):

```ts
{
  pattern: '.agentistics/provider-keys', match: 'prefix', reason: 'secret',
  restoreWith: 'agentop provider key set anthropic',
  why: 'Provider API keys entered for the native runtime (credentials.ts, 0600, never logged).',
},
```

- `restoreWith` is required for a `secret` and is tested for (`backup-plan.ts:65`,
  `backup-plan.test.ts:58-69`, `:145` "omittedSecrets lists every secret rule, each with its
  command"), so the restore prints the command.
- B1.3 adds `.agentistics/provider-keys/anthropic.json` to the probe list of
  `backup-plan.test.ts:58-69` and `:164-178` ("no credential filename can pass the filter —
  asserted over the source itself"), so deleting the row fails the build **by name**.
- Without the row, `backup-coverage.lint.test.ts:51-60` fails on `provider-keys` — that is the
  intended forcing function, not something to work around.

#### 6.2.5 A central never holds one

- A central aggregates many machines; a provider key is one person's billing credential, and D7/D10
  keep native execution local. `runProvider` refuses every `key set` and every call when
  `TEAM_CENTRAL` (`config.ts:126`) is true **or** the effective `team.mode` is `'central'`, with a
  sentence ("a central does not run the native runtime and never stores a provider key").
- The key never appears in anything a member pushes: `IngestBody` gains no field, the journal
  carries no credential value (§6.3), and D7 keeps events off the wire in these phases anyway.
- No HTTP surface exists in B1 (§6.1), so there is nothing for the `public` profile to deny; the
  `/api/provider` prefix row makes the future answer `localShell`, which `public` sets to `false`
  (`exposure.ts:84`) and `lan` only grants on an explicit opt-in (`exposure.ts:72-77`).

#### 6.2.6 What `status` may print, and what it must never print

`agentop provider key status` prints, per provider: **present / absent / unreadable / permissions
too open**, the **path**, the **file mode**, `storedAt`, and a **fingerprint**
`sha256:<first 8 hex of sha256(key)>`.

- **Decided: no substring of the key — not the last 4, not the prefix after `sk-ant-`, not the
  length.** A suffix is literal key material: it narrows a brute force, it appears in every
  screenshot and paste of the status output, and — the decisive reason for this repo — it defeats
  the fixture/log grep (§6.3.3): a test cannot distinguish "four characters of the key, printed on
  purpose" from "the key, leaking". A truncated hash is non-reversible for a high-entropy key, is
  stable across reads (so a rotation is visible as `old → new`), and matches the fingerprint idiom
  the repo already uses for public keys (`envelope-keys.ts:57-61`, `fingerprintOf`).
- Its cost is stated: a hash cannot be compared against the Anthropic console, which (if it shows
  anything) shows a masked form of the key itself. Whether matching against the console is needed
  is C-3; until an owner asks, the hash is the answer.
- Must never print: the value, any substring, the file's contents, the raw JSON.

### 6.3 The name guard — who may hold the key, and everyone else cannot name it

#### 6.3.1 How the existing guard works (`billing-detect.test.ts`)

- `billing-detect.test.ts:14-25` builds a `FORBIDDEN` list of secret field names **from string
  fragments at runtime** (`'access' + 'Token'`, `'refresh' + '_token'`, `'customApiKey' +
  'Responses'`, `'mcp' + 'OAuth'`, …) — so the test file does not itself contain the strings it
  forbids (`:6-13` explains why).
- `:30-38` reads `billing-detect.ts`'s own **source** with `readFileSync(new URL('./billing-detect.ts',
  import.meta.url))` and asserts `not.toContain(field)` for each; `:41-48` does the same for the
  pure `packages/core/src/billingDetect.ts`.
- `:51-56` asserts the API key is reduced to presence: the source must contain `'set' as const` and
  must not match `/ANTHROPIC_API_KEY\]?\s*:\s*(?!'set')[a-z]/i`.
- `:95-104` walks the runtime result and fails on any string that looks like a credential
  (`/^sk-|^sk_ant|^gho_|^ey[A-Za-z0-9]/`, or containing `@`).
- The module's contract (`billing-detect.ts:9-20`): "A field this module cannot name is a field it
  cannot leak."

#### 6.3.2 How B1 extends it — a new `provider-secrets.lint.test.ts`

In `packages/server/server/provider/`, same shape (runtime-assembled needles, source read with
`readFileSync`), but driven by a **directory walk**, not a fixed file list, so a module added to the
provider layer later is covered by having been created — the `backup-coverage.lint.test.ts` /
`capability-guard.test.ts:194` principle.

**The HOLDERS — the only files that may ever have the key's value in a variable:**

| File | Why it must hold it | What it may do with it |
|---|---|---|
| `packages/server/server/provider/credentials.ts` | reads and writes the file | load → wrap in a handle; store; remove |
| `packages/server/server/provider/anthropic/client.ts` | the SDK needs a string | unwrap the handle **once**, inside the single function that builds the SDK provider, pass it as the explicit key option, never store it on an object that outlives the call |
| `packages/server/server/cli-provider.ts` | receives it from the prompt / stdin | validate via `credential-plan.ts`, hand it to `credentials.ts`, drop it |

`credential-plan.ts` is **pure** and validates a string it is given; it is not a holder in the
storage sense but receives the value, so it is listed as a holder for the guard and has its own
test that its output (the plan/refusal) never contains the input.

**Guard 1 — non-holders cannot name the key.** For every `.ts` under
`packages/server/server/provider/**` and `packages/core/src/provider/**` except the holders, plus
`packages/server/server/journal/**` once it exists, the source must not contain:
`apiKey`, `x-api-key` (case-insensitive), `authorization` (case-insensitive), `PROVIDER_KEYS_DIR`,
`provider-keys`, `providerKeyFile`, `ANTHROPIC_API_KEY`, and must not import `credentials.ts` except
through the handle **type**. (Needles assembled from fragments, as `billing-detect.test.ts:14-25`.)

**Guard 2 — no provider module can reach a subscription credential (§22.3 rule 1).** For every
`.ts` under both provider directories **including the holders** and `cli-provider.ts`, the source
must not contain `billing-detect.test.ts`'s `FORBIDDEN` set plus: `CLAUDE_CREDENTIALS_FILE`,
`.credentials.json`, `claudeAiOauth`, `oauthAccount`, `CLAUDE_JSON_FILE`, `CLAUDE_DIR`,
`auth.json`, `oauth_creds`, `apiKeyHelper`, `authToken`, and must not import `billing-detect`
or `billingDetect`. `config.ts:28` (`CLAUDE_CREDENTIALS_FILE`) and `config.ts:32`
(`CLAUDE_JSON_FILE`) are the constants that point at those files; a provider module that cannot
spell them cannot open them. (Which bearer/OAuth options the SDK itself exposes is enumerated at
the pinned version in B1.2 and added to this list — C-1.)

**Guard 3 — no provider module reads the environment for a credential.** No `process.env` in any
provider file except behind a named allowlist of non-secret variables (none in B1). The runtime
test in §6.1 (env set, no stored key → refused) is the behavioural half.

**Guard 4 — the holders themselves hand out nothing.** `credentials.ts` exports the value only as
an opaque `CredentialHandle`:

- the string lives in a closure, not a property; `JSON.stringify(handle)`, `String(handle)`,
  `` `${handle}` ``, `util.inspect(handle)` (`Symbol.for('nodejs.util.inspect.custom')`) and
  `Object.keys(handle)` all yield `[credential anthropic sha256:xxxxxxxx]` — tested by value;
- the only way out is `handle.reveal()`, and Guard 1's needle list includes `reveal(` so the only
  files allowed to call it are the holders (in practice: `anthropic/client.ts`).

#### 6.3.3 Every sink, and the rule for it

- **Logs** — no provider module logs a request or response object whole; `console.*` of any
  object that can carry headers is refused by review and by Guard 1 (it cannot name the header to
  strip it, so it must never print the container). A test captures stdout/stderr across `key set`
  (tty and `--stdin`), `status`, `remove`, a failed call and a successful call, and asserts the key
  string appears in none.
- **Audit** — `audit.ts` writes to the central's Mongo `audit` collection (`audit.ts:1-12`,
  `:98-101`); a solo machine has no audit sink, so `key set`/`remove` write **no** audit event and
  the key never approaches `writeAudit`. `audit.ts:72-75`'s `REDACT` set (`token`, `secret`, …)
  does not contain `apiKey`; B1 does not rely on it and does not add the key to any `meta`.
- **Errors** — anything returned to a client goes through `safeError` (`errors.ts:12-20`: generic
  code + correlation ref to the client, message to the log). B1 has no route, so the rule that
  matters is the other half: `core/provider/errors.ts` builds its taxonomy from an **allowlist** of
  fields of the SDK error (status code, provider error type, `request-id`, `retry-after`) — never
  from the error object whole. The SDK's call error carries response headers and the request body
  (research 13 §5, `13-ai-sdk-fidelity.md:209-248`); whether it also carries request headers is
  C-2, and the allowlist makes the answer irrelevant.
- **Journal events** — master §22 (`…master.md:953`): "Credential — a reference, NEVER a value in
  the journal". `ModelCompletedData` (`…master.md:562-584`) has no credential field, and B1 adds
  none (whether to add the fingerprint as a reference is C-6). B1.6's emission test walks
  every emitted event and fails on any string matching `redact.ts`'s patterns (`redact.ts:59`
  `sk-ant-…`) or equal to the test key.
- **Raw captures** — condition 1 of §22.1.1 (`…master.md:1017-1020`) makes B1 capture the raw
  response per step. Research 13 §2 (`13-ai-sdk-fidelity.md:116-137`) found the SDK copies
  **every** response header indiscriminately (`extractResponseHeaders` → `Object.fromEntries([...
  response.headers])`). `anthropic/raw.ts` therefore stores headers through an **allowlist**
  (`request-id`, `anthropic-ratelimit-*`, `retry-after`, `content-type`) — never a denylist, the
  same rule as the relayed fleet row. **Any raw REQUEST capture must strip the key header**:
  `x-api-key`, plus `authorization`, `cookie`, `set-cookie` defensively; the default is to capture
  **no request headers at all**, and — per §7 — no request body either in B1.
- **Fixtures** — recorded fixtures (`packages/server/test/fixtures/provider/anthropic/`, the repo's fixture convention) pass through the same
  `raw.ts` allowlist before they are written, and `fixtures-redaction.test.ts` greps **every file**
  in that directory for `sk-ant-`, `x-api-key`, `authorization`, `anthropic-organization-id` and
  the `redact.ts` patterns. A fixture is recorded by the owner's command, never by an agent session
  (§6.1), so the only way a key reaches a fixture is a recorder defect — which this test catches.

### 6.4 Subscription credentials — never used, enforced three ways

1. **Structurally** — Guard 2 (§6.3.2): no provider module can name or import the files, constants
   or fields that lead to `~/.claude/.credentials.json`, `~/.claude.json`'s `oauthAccount`, Codex's
   `auth.json`, Gemini's `oauth_creds.json`, or `apiKeyHelper`.
2. **Behaviourally** — a test sets `HOME`/`CLAUDE_DIR` to a temp dir holding a fake
   `.credentials.json` with a plausible OAuth token, stores **no** provider key, sets
   `ANTHROPIC_API_KEY`, and asserts the call is refused with `no-credential` and no HTTP request is
   made (the transport is a stub that fails the test if invoked).
3. **By the verb's copy** — `agentop provider key set` says in its help that a Claude Pro/Max
   subscription cannot be used by agentop's own loop (§22.4) and that delegation to the official
   CLI is the route for a subscription (§22.4 (1)).

`billing-detect.ts` keeps reading `.credentials.json` for **plan facts only** (`billing-detect.ts:96`,
`:128-131`); that is observation, allowed by §22.3 rule 3, and it stays outside the provider layer —
Guard 2 forbids the provider layer from importing it.

### 6.5 Removal and rotation

- **`agentop provider key remove anthropic`** — unlink the file; remove `provider-keys/` if it is
  now empty (it existed only to hold the key — the "containers that existed only to hold our entry
  are pruned" rule from `claude-hooks.ts`, CLAUDE.md). Print the fingerprint removed and, in the
  same sentence, that **the key is still valid at Anthropic until revoked in the console** —
  deleting a local copy is not revocation. Idempotent: removing an absent key says "no key stored",
  exit 0. Exactly reversible: `set` recreates exactly what `remove` deleted.
- **Rotation** — `set` over an existing key asks for confirmation (tty) or requires `--replace`
  (`--stdin`), writes atomically (§6.2.3), and prints `sha256:old → sha256:new`. No history of old
  keys is kept.

### 6.6 Spend limit

- **B1 does not enforce money.** D3 puts the spend limit in the Anthropic console, set by the owner;
  that limit is the control, and B1's delivery is *recording* the exact usage of each call, not
  budgeting it.
- **B1 adds no local money ceiling**, because a local ceiling needs a trustworthy local cost, which
  is exactly what B1.8 is proving. What B1 does bound, structurally: every call carries an explicit
  `max_tokens` (the call site requires it — no default), and the first-call verb and the live test
  use a fixed tiny prompt with `max_tokens ≤ 64`. A local budget is B5-or-later, C-7.

## 7. Emission into the A1 journal

**Event types B1 emits: exactly three** — `model.invoked`, `model.completed`, `model.failed`
(M §14.1 lines 539-543; M §24 line 1128: `ProviderRuntime` emits `model.*`). `model.started` /
`model.delta` are streaming-only and belong to B2.

**B1 does NOT emit `session.*`, `run.*` or `agent.*`.** Those belong to `SessionRuntime` and
`AgentRuntime` (M §24 lines 1125-1126), and B4 is where sessions become the runtime's. Inventing a
session for a bare call would put a session on record that nothing opened and nothing will close.
A standalone B1 call therefore carries:

- `invocationId` (minted, `inv_…`) in `data` — the grouping key of an invocation's attempts;
- `sessionId` / `runId` / `agentId` / `taskId` **only when the caller supplied them** — all four are
  optional on the envelope (M §14 lines 498-501);
- nothing else. The resulting orphan invocation conflicts with `ModelInvocation.agentId: Id` being
  required in M §13 (line 345) — O-6.

```ts
interface ModelInvokedData {
  invocationId: string; attempt: number; provider: 'anthropic'
  requestedModel: string; maxTokens: number; messageCount: number; toolCount: number
}
// ModelCompletedData = M §14.2 + the proposed additions of §4.2's last table row
interface ModelFailedData {
  invocationId: string; attempt: number; provider: 'anthropic'; requestedModel: string
  kind: ProviderErrorKind; httpStatus?: number; errorType?: string; requestId?: string
  retryAfterMs?: number; willRetry: boolean; usageOutcome: 'none-reported' | 'unknown'
  latencyMs: number; captureRef?: CaptureRef
}
```

No `data` field carries conversation text, a prompt, a tool input, an error message or a credential
(P1 §13 lines 212-214: P1 writes no conversation text; the `action`/`command`/`instruction`
source-lint of P1 §8 line 148 covers these types too).

**Envelope fields:**

| Field | `model.invoked` | `model.completed` | `model.failed` |
|---|---|---|---|
| `source` | `{kind: 'provider', id: 'anthropic', version: <@ai-sdk/anthropic version>}` | same | same |
| `provenance.mode` | `'native'` | `'native'` | `'native'` |
| `provenance.confidence` | `exact` | `exact` (all usage read off the body) | `exact` (the facts it states are observed; it states no usage) |
| `provenance.adapterVersion` | `ProviderClient.adapterVersion` | same | same |
| `provenance.sourceRef` | `anthropic:inv:<invocationId>:<attempt>` | `anthropic:msg:<messageId>` + `captureRef` in data | `anthropic:inv:<invocationId>:<attempt>` + `captureRef` in data |
| `occurredAt` | wall clock just before the request is dispatched | wall clock when the response body was fully read | wall clock when the failure was observed |
| `recordedAt` | journal write time | journal write time | journal write time |

- **Confidence per D17.** Usage read off the response is `exact`; `contextTokens` is exact (a
  deterministic rule over exact inputs). **Cost is not on the event**: Anthropic returns no money
  (R12 §1.1 — the usage object has no cost field; M §22.1 line 981 lists none), so `costUSD` and
  `costSource` are absent and the projection prices the invocation through `calcCost`
  (`packages/core/src/types.ts` line 1067) — that figure is `estimated` (a price table), and it is
  the projection's confidence, never back-written onto the event. A missing `request-id` does not
  lower the event's confidence (§4.4); a correlation that has to fall back on
  `(agentId, startedAt, model)` is `inferred`, and that belongs to whichever reader correlates.
- **`calcCost` input.** `ProviderUsage` maps onto `ModelUsage` directly: `input→inputTokens`,
  `output→outputTokens`, `cacheRead→cacheReadInputTokens`, `cacheWrite→cacheCreationInputTokens`,
  and `cacheWriteByTtl` onto `cacheCreation1hInputTokens` / `cacheCreation5mInputTokens`
  (both-or-neither, as `calcCost` already requires, `types.ts` lines 1060-1066). The model priced is
  `servedModel`, never `requestedModel`. `iterations` are not priced until O-3 is measured, and
  the projection says the figure is partial when any are present.
- **`eventId` derivation inputs** (P1 §4.1 `deriveEventId`): `sourceKind: 'provider'`,
  `sourceId: 'anthropic'`, `type`, and `sourceRef` as above. `model.completed` is keyed on the msg id
  so the same billed response seen later by another reader (a gateway, B7) is one invocation — but
  see O-8: the signature also hashes `sourceKind`/`sourceId`, so two sources cannot actually
  converge on one id as P1 states. `model.invoked` and `model.failed` have no provider id and are
  keyed on `(invocationId, attempt)`; `ordinal` is unused (one event of each type per attempt).
- **`sourceRef` must be re-readable, so B1 stores the raw capture.** Per attempt, `capture.ts` writes
  `{ status, headers: <allowlist>, body }` as one JSON document into CM §8.1's content-addressed
  layout and the event carries `captureRef = {sha256, bytes}`. The **body is stored whole** because it
  is the only evidence for the four counters, the TTL split, `iterations` and the stop reason, and
  re-projecting a corrected mapping (the `adapterVersion` lever, M §14 rule 1) needs it — the agy
  protobuf incident (CLAUDE.md) is what re-reading the source is for. **Headers are an allowlist**
  (`request-id`, `retry-after`, `anthropic-ratelimit-*`, `content-type`, `date`): request headers are
  never captured (the key travels in them), and `anthropic-organization-id` /
  `anthropic-workspace-id` (R12 §1.2 lines 89-90) are excluded as account identifiers — a decision
  flagged in O-10. The **request body is NOT stored in B1**: it is the context manager's literal
  log (CM §9), and nothing B1 records needs it.
- **D5 is respected by construction** (OD lines 71-76; CM §8.3 lines 245-254): the capture is
  native raw content, stored locally, 0600, excluded from backup by default, and never reaches a
  central — B1 adds nothing to the team push (P1 §1: no wire change; OD D7).
- **The journal writes are two appends per attempt**: `model.invoked` BEFORE the request leaves (so a
  crash mid-call leaves a record that a billable call was outstanding), the terminal event after.
- **A journal that is absent or failing never fails the call** (P1 §4.2 lines 108-110). The call
  completes, the result reaches the caller, and the loss is a counter (`journal.provider_events_lost`
  by type) plus the journal's own health issue. A capture that cannot be written leaves `captureRef`
  absent and increments `provider.capture_failed`; the event is still written.

## 8. What B1 changes in existing code

| File | Change | Risk |
|---|---|---|
| `packages/server/package.json` (+ `bun.lock`) | adds `ai` and `@ai-sdk/anthropic`, **pinned exactly** to the versions research 13 measured (`ai@7.0.107`, `@ai-sdk/anthropic@4.0.58`, `@ai-sdk/provider@4.0.17`) | six majors in ~three years (master §22.1.1); pinned, and only `anthropic/client.ts` may import either package — a source test enforces it, so a major bump is a one-file migration |
| `packages/server/bin/cli.ts` | one dispatch line: `provider` → `cli-provider.ts` | none — a new verb |
| `packages/server/server/backup/backup-plan.ts` | two rows: `.agentistics/provider-keys` (`secret`, `restoreWith: 'agentop provider key set anthropic'`, §6.2.4) and the raw-capture content directory (excluded by default, context-manager §8.3) | `backup-coverage.lint.test.ts` fails the build if either path is undecided, which is the point |
| `packages/core/src/index.ts` (barrel) | exports `provider/*` | **A1.1, A1.2 and A1.4 edit this file too**: a trivial merge; B1's lines are kept together in one block |
| `packages/core/src/canonical/event.ts` (A1.1's file) | `ModelCompletedData` / `ModelFailedData` / `ModelInvokedData` gain the fields §4.2 and §7 list | **not B1's to decide alone** — the additions are open item O-5 and must be accepted into A1's contract (or A1's contract must be amended) before B1.6 (emission) is written |
| `packages/server/server/config.ts` | `PROVIDER_KEYS_DIR` + `providerKeyFile(provider)` (§6.2.1) | none — two constants |
| `packages/server/server/capability-guard.ts` | one prefix row `['/api/provider', 'localShell']` (§6.1) | none — no route exists yet; it makes the first one guarded |

There is deliberately **no HTTP route** in B1. Every B1 action is an `agentop` verb run by the person
at their own terminal. The only `capability-guard.ts` change is one pre-emptive prefix row,
`['/api/provider', 'localShell']` (§6.1), so the first provider route anyone writes later is guarded
by having been added; nothing is added to `AUTH_PUBLIC` or to `exposure.ts`'s surface, and a central never gains a way to make a model call. The verbs themselves refuse on a
central (`TEAM_CENTRAL`) and while `AGENTISTICS_PROVIDER` is off, each in a sentence (§6).

Nothing under `packages/web`, `packages/tui`, `packages/vscode` or `packages/mcp` changes. No store
is migrated, no Mongo collection is touched, no wire shape changes.

## 9. Tests

**Pure (unit), one file per module**
- `usage.ts`: `input` never includes cache; TTL both-or-neither and sum check (a non-summing split is
  dropped, flat figure kept); `missing` populated for an absent counter; `reasoning` absent ≠
  `{billing:'unknown'}`; totals only via `tokens.ts` (the existing lint must cover the directory).
- `stop-reason.ts`: the seven Anthropic values (R12 §1.8) map one-to-one; an unknown value becomes
  `{kind:'other', raw}`, never a throw and never `end_turn`.
- `errors.ts`: a table test with one row per §4.3 line — status × `error.type` × `error_code` ×
  transport → kind, retryable, usageOutcome, userCode; `spend-cap` wins over `rate-limited` on
  `error_code` for both 429 and 400; an unknown `error.type` → `http-other`; no kind has a usage field
  (type-level test).
- `retry-plan.ts`: retry-after honoured; retry-after beyond budget → no retry; backoff sequence;
  attempts exhausted at 3; `client-timeout` and `network` with `requestSent: true` → no retry;
  aborted → no retry.
- `anthropic/raw.ts`: over recorded fixtures (below) → exact `ProviderUsage`, `messageId`,
  `requestId`, `servedModel`, `stopReason`; `request-id` absent → field absent; 2xx without `id` →
  `response-unreadable`.
- `edit-policy.ts`: `ANTHROPIC_EDIT_POLICY.status === 'declared-unverified'`; a `measured` policy
  without `verifiedAt` fails to type-check.
- Source guards: no credential-shaped identifier outside `anthropic/client.ts`; no `action` /
  `command` / `instruction` field in the three data types (P1 §8).

**Recorded fixtures** — `packages/server/test/fixtures/provider/anthropic/<name>.json`, each:
`{ recordedAt, sdkVersions, request: {model, maxTokens, cacheControl?: summary only}, response:
{status, headers: <allowlist>, body} }`, redacted: no request headers, no org/workspace ids, prompt
and output text replaced by a fixed placeholder of the same byte length only where the text is not
the point of the fixture. Required set: plain completion; `tool_use` stop; `max_tokens` stop; a 5m
cache write; a cache read; a **1h cache write** (so `cache_creation.ephemeral_1h_input_tokens` is
non-zero); mixed 5m+1h; 401; 429 with `retry-after`; 529; and, **if obtainable**, a response carrying
`iterations` (compaction or advisor) — if not obtainable, the test for it is present and skipped with
the stated reason "no fixture yet; O-3", never deleted.

**The four SDK conditions — each has a test that FAILS if the condition is dropped**
1. Raw capture: a fixture with `cache_creation.{ephemeral_5m, ephemeral_1h}` → `cacheWriteByTtl` is
   set. Removing the capturing fetch (reading SDK typed usage) leaves it undefined and fails.
2. Iterations: a synthetic raw body with `usage.iterations` → `ProviderUsage.iterations.length > 0`
   and `iterationsRelation === 'unmeasured'`; reading from SDK totals drops them and fails.
3. Per step: a two-step `generateText` against a mock provider asserts `result.usage.raw ===
   undefined` (pinning R13 §3's finding against the installed version) AND that the B1 client refuses
   a call that produced more than one step (`steps.length !== 1` → `response-unreadable`, counted).
4. Own retry: a mock fetch returning 529 then 200 → the client makes exactly ONE request per
   `invokeOnce` (the SDK's `maxRetries` is 0), and `retry.ts` produces 4 events (2 invoked, 1 failed,
   1 completed) with distinct `attempt`s. Setting `maxRetries` back to the default makes the fetch
   count 2 inside one `invokeOnce` and fails.

**Behaviour**
- Each attempt is exactly one `model.invoked` + one terminal event; `eventId`s are distinct across
  attempts and stable across reruns of the same fixture.
- Abort before any response (zero steps): `model.failed{kind:'aborted', usageOutcome:'unknown'}` with
  no usage property; abort during backoff emits no further `model.invoked`.
- Journal failing (injected throwing journal): the call returns `completed`, the loss counter
  increments — the P1 §5 test shape.
- Capture write failing: event written without `captureRef`, counter increments.

**Live** — one test file, `anthropic/client.live.test.ts`, runs a single minimal call (`max_tokens ≤
64`) and checks the result against the SDK cross-check and the four-counter invariants. It runs only
when **both** `AGENTISTICS_LIVE_ANTHROPIC=1` is set **and** a key resolves through
`CredentialResolver`; otherwise it is **skipped with a stated reason** naming which half is missing
(`opt-in absent` / `absent` / `unreadable` / `permissions-too-open`) — never a silent pass, and the
pre-commit `bun test` therefore never spends money. It never reads a key from a test file, the
environment or a prompt: the opt-in variable is a non-secret switch, and it is the one `process.env`
read Guard 3 (§6.3.2) allows, in a test file only.

## 10. Budgets — targets, and how each is measured

| Budget | Target | How measured |
|---|---|---|
| overhead our layer adds per attempt (capture + `raw.ts` + classify + event build, excluding provider latency and journal I/O) | ≤ 5 ms p95 — a **target**, not a measurement | benchmark over the fixture set with a mock fetch that returns instantly; reported in the PR |
| SDK-vs-raw divergence | 0 on every fixture for the four flat counters | counter `provider.sdk_usage_divergence`; a non-zero value on a fixture fails the test |
| raw capture size per attempt | body bytes + allowlisted headers only, no re-encoding (≤ body + 2 KB) | measured on every fixture and on the live call; median and max reported |
| retry ceiling | 3 attempts, ≤ 60 s elapsed including sleeps (target, matching vendor defaults, §4.5) | `retry-plan` unit tests; policy object is the single source |
| journal writes per attempt | exactly 2 appends; each within P1's ≤ 2 ms p95 append budget (P1 §9) | counted in the behaviour tests; timed in the P1 benchmark harness |
| memory | no response body retained after capture + parse; nothing accumulates across calls | a test issuing 1 000 mocked calls under a bounded heap |

A budget missed is reported, not relaxed: the overhead target is only meaningful against a
measured number, and the first measurement sets it.

## 11. Observability

`agentop provider status` (the whole layer; `agentop provider key status`, §6.2.6, is its
credential half and prints the same credential lines) answers on every machine — with the flag off, with no key, on a central —
and says which of those it is rather than failing. It prints:

- whether `AGENTISTICS_PROVIDER` is on;
- per provider: whether a credential is **present**, where it is stored, and whether the file's mode
  is still `0600` — never the key, never any part of it (§6);
- counters since the process started: attempts, completed, failed **by kind** (§4.3), retries,
  `request_id_missing`, `capture_failed`, `sdk_usage_divergence`, `provider_events_lost` (by event
  type), `unknown_outcome_attempts`;
- the last call's time, model, request id and four counters.

The first real call is its own verb, `agentop provider try anthropic` (§6, §15): one minimal
request, and it prints the served model, the four counters, the TTL split when present, the request
id, the `eventId`s written to the journal, and the **table-priced** cost labelled as an estimate
(D17) — Anthropic returns no money, so B1's cost is never presented as the provider's (open item
O-13).

A health issue is raised when the credential file exists with a mode wider than `0600`, and when
`provider_events_lost` is non-zero — the shape the journal and the archive already use.

## 12. Rollback

Turn `AGENTISTICS_PROVIDER` off: no provider module loads, no credential is read, the verbs say the
flag is off. Optionally run `agentop provider key remove anthropic`, which deletes the credential
file and nothing else, and delete the raw-capture directory. The `model.*` events already in the
journal stay — they are facts about calls that happened (D6, events are kept) and no surface reads
them in B1. Removing the two dependencies is a revert of `package.json` / `bun.lock`; nothing outside
`anthropic/client.ts` imports them, so the revert touches no other file.

## 13. Acceptance criteria

1. With the flag off, the product is byte-identical in behaviour (the existing suite passes, and no
   provider module is imported — asserted).
2. `agentop provider key set anthropic` stores the key `0600` from a hidden prompt or a pipe, never
   from argv; `status` reports it present without printing any part of it; `remove` deletes exactly
   that file. The name-guard source test (§6) passes, and fails when a forbidden identifier is
   introduced outside the modules allowed to hold the value.
3. No log line, audit event, error body, journal event, raw capture or fixture contains the key or
   the request's auth header — asserted by a test that runs a mocked call with a sentinel key and
   greps every output channel for it.
4. `agentop provider try anthropic` makes **one** real call and writes exactly one `model.invoked`
   and one `model.completed` whose four counters equal the raw response body's, byte for byte, and
   whose `providerRequestId` / `requestId` equal the body `id` and the `request-id` header.
5. **Reconciliation:** that call's recorded usage is compared with what the Anthropic console shows
   for it, and the comparison (equal, or each difference explained) is attached to the task — the
   agy lesson (CLAUDE.md): a number is not trusted until it has met a bill.
6. Each of the four §22.1.1 conditions has a test that fails when the condition is removed (§9a).
7. A retried call writes one `model.invoked` + one terminal event **per attempt**, with distinct
   attempt numbers and request ids; an ambiguous attempt (timeout, network after send) is recorded
   `usageOutcome: 'unknown'` and is not retried.
8. An abort with zero completed steps is a `model.failed` with **no** usage property.
9. A failing journal never fails the call; the loss is counted and visible in `status`.
10. Every budget in §10 is measured and reported in the handback/PR; a missed budget is reported, not
    relaxed.
11. Every open item in §14 that blocks a subtask is either resolved with a citation or carried into
    that subtask's handback as still open — none is resolved from memory.

## 14. Open items

**None of these is resolved from memory.** Each names the subtask it blocks, or is carried into that subtask's handback as still open. They come in three families, one per research item of B1.0.

### 14.1 Contracts (O-n)

1. **O-1.** **Does Anthropic accept an idempotency key?** R13 §5 (lines 233-235) asserts "Anthropic's own
   Messages API supports an `Idempotency-Key` header" with no citation to an Anthropic page; R12,
   the primary-source survey of the Messages API, never mentions one. Until verified from
   Anthropic's docs, B1 does not retry ambiguous attempts (§4.5).
2. **O-2.** **Is there a thinking-token field in Anthropic usage?** R12 §1.1 (lines 49-53): "no
   `thinking_tokens` field". R13 §1 (line 70) quotes the SDK's zod schema declaring
   `output_tokens_details: { thinking_tokens }`. M §22.1 (line 981) follows R12. A fixture from a
   thinking-enabled call must settle it; until then a present value is `billing: 'unknown'`.
3. **O-3.** **Are `iterations` inside or outside Anthropic's raw top-level usage?** R13 §1 (lines 87-96)
   establishes only that the SDK's `convertAnthropicUsage` excludes advisor tokens; M §22.1.1 (lines
   1021-1026) says "excluded from the top-level totals" without saying whose. R12 does not mention
   `iterations` at all, nor the key names inside an iteration. `iterationsRelation: 'unmeasured'`
   and partial pricing until a raw fixture decides it.
4. **O-4.** **What is `providerRequestId`?** M §13 (line 346) comments "Anthropic message.id / request-id
   header" — two different ids (R12 §1.2: `msg_…` vs `req_…`). P1 §4.1 keys on `message.id`. This
   spec uses the msg id and carries the header separately as `requestId`, which `ModelCompletedData`
   has no field for.
5. **O-5.** **`ModelCompletedData` (M §14.2, lines 566-585) lacks fields B1 must carry**: stop reason,
   request-id header, requested vs served model (R12 §6: served can differ on fallback), attempt /
   invocation grouping, iterations, server tool use, a missing-counter list, a capture reference.
   Proposed as additions (§4.2 table); the master contract must be amended, not bypassed.
6. **O-6.** **`ModelInvocation.agentId` is required** (M §13 line 345) but a bare B1 call has no agent and B1
   must not invent one (§7). Either the field becomes optional (an orphan invocation) or B1 is only
   callable with an agent supplied.
7. **O-7.** **Are `cache_creation_input_tokens` / `cache_read_input_tokens` always present, or only with
   cache activity?** R12 §1.1 describes the flat counters as present "once any cache write occurs"
   and R12 §8 (lines 943-945) leaves the nested `cache_creation` presence condition open. Hence
   `ProviderUsage.missing`; a no-cache fixture decides it.
8. **O-8.** **`deriveEventId` cannot give "the same id from three sources".** P1 §4.1 (lines 85-87) and P1 §8
   (lines 147-148) require it; the signature (P1 lines 76-78, and M §14 line 489) hashes
   `sourceKind` and `sourceId`, which differ between a native call and a gateway/transcript reading
   of the same response. Must be resolved in A1 before B7 exists; B1 alone is unaffected (its calls
   have one source).
9. **O-9.** **`ProviderId` has two definitions.** Code: `'anthropic' | 'openai' | 'google' | 'moonshot' |
   'other'` (`packages/core/src/providers.ts` line 21) — a billing entity keyed off model ids. M §22
   (line 950): `anthropic | openai | google | openrouter | litellm | ollama | custom`, where
   `openrouter` / `litellm` are routes rather than billers. `PROVIDER_CLIENTS` is keyed on the code's
   type in B1; B5 must decide whether routes join it or become `ModelDeployment`.
10. **O-10.** **Response headers that identify the account** (`anthropic-organization-id`,
    `anthropic-workspace-id`, R12 §1.2 lines 89-90) are excluded from the capture here by analogy with
    `billing-detect.ts`'s rule; that is a decision, not a research finding, and needs the owner's nod.
11. **O-11.** **`costSource` contradiction in M §14.2.** The type (line 581) is `'provider' | 'harness'`; the
    bullet (lines 603-605) says the projection "marks `costSource: 'table'`"; M §13 (line 356) has
    all three. Left unresolved here: B1 writes no cost, so it does not need to pick.
12. **O-12.** **`ModelCompletedData.status: 'completed' | 'failed'`** (M §14.2 line 583) duplicates the
    separate `model.failed` event type (M §14.1 line 542), and `ModelInvocation.status` adds
    `'cancelled'` (M §13 line 357). B1 emits `model.failed` for every failure (abort included, as
    `kind: 'aborted'`); what a `failed` status on a `model.completed` would mean is undefined.
13. **O-13.** **"The first cost figure that comes from the provider"** — M §49 (line 1739) describes B1 so;
    Anthropic returns no money (R12 §1.1; M §22.1 line 981), so B1's cost is table-priced
    (`estimated`). B1 delivers exact USAGE from the provider; the §49 sentence should say that.
14. **O-14.** **Does `@ai-sdk/anthropic@4.0.58` accept a custom `fetch`, and does `APICallError` expose the
    response headers and body?** R13 names a fetch override as possible (§5 lines 222-224) and
    `APICallError.isRetryable` (§5 lines 227-230) but verifies neither the factory option nor the
    error's fields. The capturing-fetch design depends on the first; if it is absent, capture moves
    to `wrapLanguageModel` / `wrapGenerate` (R13 §7 lines 275-280), which sees `response.body` and
    `response.headers` on success only — failed attempts would then lose their raw capture.
15. **O-15.** **Single-step `generateText` and the stop condition.** R13 §9 notes `stepCountIs` was renamed
    `isStepCount` in 7.0.0 but does not verify that tool declarations without `execute` end the
    call after one step. The per-step test (§9a condition 3) pins the behaviour against the installed
    version; the alternative — calling the model's `doGenerate` directly (R13 §7 lines 281-285) — is
    recorded but not chosen, because D3 names `maxRetries`, a `generateText` option.
16. **O-16.** **How an error response is billed** is not stated anywhere in R12; `usageOutcome:
    'none-reported'` deliberately claims nothing either way.
17. **O-17.** **Rate-limit headroom (M §41.1)** needs the `anthropic-ratelimit-*` headers "on a native call".
    B1 keeps them in the raw capture only; whether they become a typed field on `model.completed`
    (and with what retention, since they change per response) is for the §41.1 projection to decide.

18. **O-18.** **`ModelInvocation.reasoningTokens?: number`** (M §13, line 353, comment "never added on
    top of output") is the bare number that M §14.2's own 2026-09-20 correction (lines 589-595) forbids:
    Google's `thoughtsTokenCount` IS additive. The entity must carry `ReasoningUsage` (`{tokens,
    billing}`, §4.2), or a projection reading the entity sums it one way and one reading the event the
    other. Blocks B1.6 only in that the entity and the event must agree; B1 itself reports no
    reasoning (Anthropic has no field).

### 14.2 Usage table (U-n)

The ten contradictions and gaps are listed in §5.3 as U-1…U-10, with both sides quoted. U-3 overlaps O-3 (`iterations`) and U-4 overlaps O-11 (`costSource`).

### 14.3 Credentials (C-n)

1. **C-1.** **The SDK's implicit key sources at the pinned version.** Whether `@ai-sdk/anthropic` falls back
   to `ANTHROPIC_API_KEY` when no key is passed, and which bearer/OAuth-style options it exposes.
   Research 13 does not say (its only key mention is the OpenAI-compatible `apiKey?` option,
   `13-ai-sdk-fidelity.md:287`). Must be read from the SDK source at the pinned version in B1.2;
   the result feeds Guard 2's needle list and the §6.1 env test.
2. **C-2.** **Whether the SDK's call error or result carries REQUEST headers** (and so the `x-api-key`
   value). Research 13 §2 covers response headers only (`:116-137`). The allowlist in §6.3.3 makes
   B1 safe either way; the finding decides whether the fixture test also needs a request-header probe.
3. **C-3.** **Console matching.** Whether the owner needs to match a stored key against what the Anthropic
   console shows. If yes, a suffix hint would be needed and §6.2.6's decision would change — an
   owner decision, not an implementer's.
4. **C-4.** **`--from-env <NAME>`** as an explicit one-shot import. Not built in B1; would be an explicit
   act (a named variable, read once, stored), which §22.3 permits.
5. **C-5.** **WSL/DrvFs chmod.** `envelope-keys.ts:36` swallows a failed chmod on DrvFs. B1 refuses instead
   (§6.2.2). `AGENTISTICS_DATA_DIR` is normally on ext4 under WSL, so this only bites a user who
   points `AGENTISTICS_DIR` at `/mnt/c/...`; confirm that refusing is acceptable there.
6. **C-6.** **A credential REFERENCE on `model.*` events.** §22's "Credential — a reference" suggests one;
   `ModelCompletedData` has no field for it. Adding `credentialFingerprint` would make a rotation
   visible in the journal; it is a canonical-model change (A1's contract), so not B1's to decide.
7. **C-7.** **A local spend ceiling** (per call / per day), after B1.8 proves the local number.
8. **C-8.** **A key-validation call.** `status` is offline. A "does this key work" check that costs nothing
   (e.g. a models-list endpoint) is not established by the research; the first real call (B1.7) is
   the validation in B1.
9. **C-9.** **Stale backup row, observed while reading.** `backup-plan.ts:147-150` excludes
   `.agentistics/machine-key` for "the X25519 private key … (envelope-keys.ts)", but the key actually
   lives at `join(TEAM_CONN_DIR, 'envelope-key.json')` (`config.ts`, `envelopeKeyFile`), i.e. under
   `.agentistics/connections/`, which the row above it (`backup-plan.ts:141-145`) already excludes.
   Nothing leaks; the `machine-key` row names a path nothing writes. Out of B1's scope — reported,
   not fixed.
10. **C-10.** **D18's "integrating session".** §15 reads it as "the session that runs a GROUP and merges its
    subagents' work". Whether a LOOSE (single-item) subtask session also counts as integrating —
    and so runs on Opus 5.5 — is not stated; §15 assumes it does not (Sonnet 5), which is the
    cheaper reading and needs no approval.

---

## 15. Proposed subtasks B1.1 … B1.8

**Model rule (D18, owner decision — committed on `origin/spec/a1-0-apply-decisions`, 4478f8a3; quoted):** "integrating sessions run on
claude-opus-5-5; an item that WRITES a file runs on Sonnet 5 or Opus 5.5; Haiku only on a read-only
item (two Haiku subagents of the A1.0 session reported edits that were not on disk); the per-item
approval for Opus now applies to Opus 5.5 — the model and the reason are still recorded per item."
So the old table's "B1.5 fixtures — Haiku" (`specs/2026-09-20-delivery-breakdown.md` §4) is
**withdrawn**: B1.5 writes files, so it runs on Sonnet 5. Every writer item below is Sonnet 5
unless stated; a group's integrating session is Opus 5.5 per D18 (the model + reason recorded on the
session; any *item* on Opus 5.5 would need the per-item approval — none is proposed).

**Commit rule (D19):** the coordinator may release a commit on the B1 feature branch after checking
the subtask's evidence; the PR to `dev` stays the owner's.

**Mapping from the old five-row table:** old B1.1 → new B1.1 + B1.4(a); old B1.2 → B1.4; old B1.3 →
B1.3; old B1.4 → B1.6; old B1.5 → B1.5. New: B1.2 (dependency + compile gate), B1.7 (first-call
verb + live test), B1.8 (acceptance + reconciliation).

### B1.1 · Group — the pure provider contract (`@agentistics/core`)

- **Objective:** the provider-neutral, pure contract every later piece is written against: usage
  mapping, error taxonomy, retry plan, edit policy.
- **May touch:** `packages/core/src/provider/{usage.ts, stop-reason.ts, errors.ts, retry-plan.ts, edit-policy.ts}`
  + their `*.test.ts`; `packages/core/src/index.ts` (barrel export only).
- **Must not touch:** anything under `packages/server/`, `packages/web/`, `packages/core/src/canonical/`
  (A1's), `package.json`, `bun.lock`.
- **Integrating session:** Opus 5.5 (D18). **Items:**
  - (a) `usage.ts` — Anthropic usage → the four counters + `cacheWriteByTtl` + `iterations`
    (§22.1.1 conditions 1–3; master `:1017-1030`), per-step only, `input` excludes cache
    (`…master.md:596-600`) · **Sonnet 5** — writes a file; the money-bearing mapping.
  - (b) `errors.ts` — the taxonomy built from an allowlist of fields (§6.3.3), including
    "aborted with zero completed steps → `model.failed`, no usage" (`…master.md:1036-1039`) ·
    **Sonnet 5**.
  - (c) `retry-plan.ts` — pure: which failures retry, backoff, and "each attempt is its own event
    with its own request id" (condition 4, `…master.md:1031-1035`) · **Sonnet 5**.
  - (d) `edit-policy.ts` (§4.6, Anthropic's policy `declared-unverified`) + `stop-reason.ts` (§4.2,
    R12 §1.8's seven values + `other`) · **Sonnet 5**.
- **Tests:** table tests per module; a usage test that `iterations` are carried verbatim and never dropped nor summed (condition 2;
  `iterationsRelation: 'unmeasured'` until O-3 is measured, §4.2); a test that no reader sums a `billing: 'unknown'` reasoning
  count; `tokens.lint.test.ts` stays green.
- **Blockers:** none. Can start immediately.
- **Acceptance:** all four modules pure (no IO import), `bun test` green, exported from core.

### B1.2 · The SDK dependency and the compile gate (loose subtask)

- **Objective:** add `ai` + `@ai-sdk/anthropic` at **exact pinned versions**, prove
  `bun run build:binary` still produces a working `release/agentop`, and answer C-1/2 from
  the SDK source at that pin.
- **May touch:** root `package.json` and/or `packages/server/package.json` (dependencies), `bun.lock`.
  **This subtask is the sole owner of `bun.lock`** for B1: no other B1 session runs `bun add`, and a
  `bun.lock` rewritten by a routine `bun install` in another worktree is discarded, never staged.
- **Must not touch:** any `.ts` source.
- **Model:** **Sonnet 5** — writes `package.json`/`bun.lock`; the SDK-source reading that answers
  C-1/2 is part of the same session because its findings gate security guards (Haiku would
  be permitted for a read-only item by D18, but not chosen here: a wrong "no, it does not read env"
  is a leak).
- **Evidence to reproduce:** research 13 §8 (`13-ai-sdk-fidelity.md:301-337`) measured, outside the
  repo, `ai@7.0.107` + `@ai-sdk/anthropic@4.0.58`: 112 modules, zero `require(`, `bun build
  --compile` succeeds and the binary runs; it flagged `undici` as a real dependency of
  `@ai-sdk/provider-utils`, runtime use UNVERIFIED. B1.2 repeats this **inside the repo** against
  the real binary pipeline (the `react-devtools-core` stub history in CLAUDE.md is why "compiles
  under `bun run`" is not enough).
- **Tests:** `bun run build:binary`; run the binary (`--version`, and a smoke entry that imports the
  SDK and constructs — not calls — an Anthropic model); `bun tsc --noEmit`; `bun test`.
- **Blockers:** none. Parallel with B1.1 and B1.3.
- **Acceptance:** exact versions (no caret) recorded; binary builds and runs; binary size delta
  reported; a short written finding for C-1 and C-2 attached to the task.

### B1.3 · Group — credentials (§6)

- **Objective:** a key can be entered, stored, reported and removed exactly as §6 says, and the
  guards of §6.3 make leaking it a red build.
- **May touch:** `packages/server/server/provider/{credentials.ts, credential-plan.ts}` + tests;
  `packages/server/server/provider/provider-secrets.lint.test.ts`; `packages/server/server/cli-provider.ts`
  + test; `packages/server/bin/cli.ts` (one dispatch block + help line); `packages/server/server/config.ts`
  (`PROVIDER_KEYS_DIR`, `providerKeyFile`); `packages/server/server/backup/backup-plan.ts` (one
  `CROSS_HARNESS_SECRETS` row) + `backup-plan.test.ts` (probe entries);
  `packages/server/server/capability-guard.ts` (`/api/provider` prefix) + its test; `docs/` page
  for the verb.
- **Must not touch:** `preferences.ts`, `envelope-keys.ts`, `billing-detect.ts`, `cli-ui.ts`
  (reused as is), anything under `provider/anthropic/`, `package.json`, `bun.lock`.
- **Integrating session:** Opus 5.5 (D18). **Items:**
  - (a) `credential-plan.ts` (pure: shape validation, fingerprint, refusal reasons incl. central
    and permissions) + `credentials.ts` (IO: atomic 0700/0600 write, mode-checked read, remove,
    `CredentialHandle`) + tests · **Sonnet 5** — writes files; security-shaped.
  - (b) `cli-provider.ts` + `cli.ts` dispatch: `set` (tty via `maskedInput` / `--stdin` / refusals
    for argv and non-TTY), `status`, `remove`, central refusal, the `AGENTISTICS_PROVIDER` flag
    gate (off → every verb but `status` refuses in a sentence) · **Sonnet 5**.
  - (c) guards: `provider-secrets.lint.test.ts` (Guards 1–3 by directory walk), the backup row and
    probes, the `capability-guard` prefix and its test · **Sonnet 5**.
- **Tests:** mode 0600/0700 after first write AND after rotation (the `github-store.test.ts:54-69`
  shape); too-open file refused; tmp never left behind on an injected failure; `JSON.stringify` /
  `String` / `inspect` of a handle never contain the key; stdout+stderr of every verb never contain
  it; argv key refused; `ANTHROPIC_API_KEY` set + no stored key → `no-credential`; fake
  `.credentials.json` present → never read (Guard 2 + behavioural test); `backup-coverage.lint`
  and `backup-plan.test.ts` green with the new probes; the lint's own "found something" check
  (as `backup-coverage.lint.test.ts:62-69`) so an empty walk cannot pass vacuously.
- **Blockers:** none. The `CredentialHandle` **type** is the first thing this group lands, because
  B1.4 imports it.
- **Acceptance:** every §6 rule has a test; `bun test` + `tsc` green; the owner runs `set`,
  `status`, `remove` once on a real terminal and the output is attached.

### B1.4 · Group — the Anthropic client

- **Objective:** one non-streaming Anthropic call through our `ProviderClient`, with raw per-step
  capture, request id, our own retry, and nothing hidden by the SDK.
- **May touch:** `packages/server/server/provider/client.ts` (interface + registry, a total
  `Record<ProviderId, …>` with Anthropic filled and the rest declared absent),
  `packages/server/server/provider/anthropic/{raw.ts, client.ts}`, `packages/server/server/provider/{retry.ts, capture.ts}`
  + tests; `packages/server/server/backup/backup-plan.ts` (the content-directory row only, §7 —
  **after** B1.3 has landed its own row in the same file; sequential, not parallel).
- **Must not touch:** `credentials.ts` (consumes the handle only), `packages/core/src/provider/*`
  (B1.1's — changes go back to B1.1), `package.json`, `bun.lock`, the journal.
- **Integrating session:** Opus 5.5 (D18). **Items:**
  - (a) `client.ts` interface + registry and `anthropic/client.ts` (IO, `maxRetries: 0`, key passed
    explicitly from `handle.reveal()` inside one function, explicit `max_tokens` required) ·
    **Sonnet 5**.
  - (b) `anthropic/raw.ts` (pure) + `capture.ts` (IO): the capturing `fetch`'s raw `{status, headers,
    body}` → B1.1's usage type (the SDK's typed usage only as a cross-check, §4.1); header ALLOWLIST; `request-id` → `providerRequestId` (`…master.md:981`, `:1003`, verified 2026-09-20);
    `iterations` read (condition 2) · **Sonnet 5**.
  - (c) `retry.ts`: executes B1.1's `retry-plan.ts`, one attempt record per HTTP attempt · **Sonnet 5**.
- **Tests:** against a stub `fetch` (no network): usage per step never from the aggregate
  (condition 3, `result.usage.raw` is `undefined` on multi-step per research 13); a retried call
  yields two attempt records with two request ids; abort with zero steps → failed, no usage;
  captured headers contain only allowlisted names; the SDK is never constructed without an explicit
  key.
- **Blockers:** B1.1 (types), B1.2 (dependency present), B1.3's `CredentialHandle` type.
- **Acceptance:** stub-transport tests green; Guards 1–3 green over the new files; no network in `bun test`.

### B1.5 · Fixtures from recorded responses + mapping tests (loose)

- **Objective:** real Anthropic response shapes on disk, redacted, driving the usage-mapping tests.
- **May touch:** `packages/server/test/fixtures/provider/anthropic/**`,
  `packages/server/scripts/record-anthropic-fixtures.ts` (the **owner-run** recorder, reading the key
  through `credentials.ts` and writing through `raw.ts`'s allowlist),
  `packages/server/server/provider/anthropic/{raw.fixtures.test.ts, fixtures-redaction.test.ts}`.
- **Must not touch:** `raw.ts`/`client.ts` (defects go back to B1.4), `package.json`, `bun.lock`.
- **Model:** **Sonnet 5** — it writes files (the recorder, fixtures, tests); D18 withdraws Haiku here.
- **Tests:** every fixture maps to the expected four counters, TTL buckets and request id;
  `fixtures-redaction.test.ts` greps every fixture for `sk-ant-`, `x-api-key`, `authorization`,
  `anthropic-organization-id` and the `redact.ts` patterns.
- **Blockers:** B1.4 (`raw.ts`). Recording needs the owner's key → **the owner runs the recorder**;
  the session may start from fixtures hand-built from documented shapes and swap in recorded ones.
- **Acceptance:** at least one recorded plain call and one with cache write; redaction test green;
  the session never held the key.

### B1.6 · `model.*` emission into the journal (loose)

- **Objective:** each attempt becomes `model.invoked` then `model.completed` or `model.failed` in
  the canonical journal, with the exact usage, idempotent on replay.
- **May touch:** `packages/server/server/provider/emit.ts` + test.
- **Must not touch:** `packages/core/src/canonical/**` and `packages/server/server/journal/**` (A1's
  — a needed change goes back to A1), provider client files, `package.json`, `bun.lock`.
- **Model:** **Sonnet 5** — writes files; "the join between the two tracks" (old table).
- **Tests:** event ids via `deriveEventId`, keyed on the provider's own id wherever one exists
  (P1 §4.1: `specs/2026-09-19-runtime-p1-canonical-journal.md` §4.1 — Anthropic's `msg_…`; a failed
  attempt has no message id and keys on `(invocationId, attempt)` — §7, never on the `request-id` header, which can be absent);
  appending twice changes no count (`duplicates` counted, P1 §4.2); a failed call carries no usage,
  never zeros (`…master.md:1036-1039`); **no emitted string matches `sk-ant-` or equals the test key**.
- **Blockers:** **A1.1** (canonical types/event union) **including acceptance of the O-5 field
  additions** to `ModelCompletedData` and the `ModelInvokedData`/`ModelFailedData` shapes of §7,
  **A1.2** (`event-id.ts`, and O-8), **A1.3** (the journal), and B1.1 (usage/attempt types). Can be written against B1.1 in parallel with B1.4.
- **Acceptance:** emission tests green against the real A1 journal (a temp SQLite file).

### B1.7 · The first-call verb + the gated live test (loose)

- **Objective:** `agentop provider try anthropic [--model <id>]` sends one fixed tiny prompt
  (`max_tokens ≤ 64`), records it through B1.6, and prints usage, `request-id` and the event ids —
  plus a live test that runs only when explicitly enabled.
- **May touch:** `packages/server/server/cli-provider.ts` (the `try` sub-verb only — coordinate with
  B1.3, which owns the file first), `packages/server/server/provider/anthropic/client.live.test.ts`.
- **Must not touch:** credentials, client internals, journal, `package.json`, `bun.lock`.
- **Model:** **Sonnet 5** — writes files.
- **Tests:** the live test is skipped unless `AGENTISTICS_LIVE_ANTHROPIC=1` **and** a key is stored,
  and when skipped it says so in words (never a silent pass); when enabled it asserts one
  `model.completed` with all four counters and a `providerRequestId`. `bun test` (the pre-commit
  hook) never spends money.
- **Blockers:** B1.3, B1.4, B1.6.
- **Acceptance:** the owner runs the live test once; output attached.

### B1.8 · Acceptance and reconciliation (loose, read-only items)

- **Objective:** prove the recorded number: one real call's journaled usage equals Anthropic's own
  record of it, and every §6 rule held.
- **May touch:** nothing in `packages/`; evidence is attached to the task (a short report in the
  task's files).
- **Items:**
  - (a) reconciliation: the owner runs `agentop provider try anthropic`; the four counters and the
    `request-id` in the journal are compared with the Anthropic console's record for that request;
    any difference is a defect in B1.1/B1.4, not a tolerance · **Sonnet 5** (read-only; Haiku
    permitted by D18, not chosen — this comparison is what B1 exists to prove).
  - (b) security sweep of the whole B1 diff against §6 (every sink in §6.3.3, Guard coverage, the
    backup row, the central refusal) · **Sonnet 5** (read-only review).
  - (c) mechanical grep sweep: `sk-ant-` / `x-api-key` across the repo, fixtures, the journal file
    and `~/.agentistics` logs after the live call · **Haiku** (read-only, mechanical — D18 allows it).
- **Blockers:** B1.5, B1.7.
- **Acceptance:** reconciliation row attached with the console's figure beside ours; the Task B1
  delivery criterion ("call Anthropic with the user's API key and record the exact usage of that
  call", delivery-breakdown §4) is met by that row, not by tests alone.

### Dependency graph

```
            ┌──────── B1.1 (core contract) ────────┐
start ──────┼──────── B1.2 (deps + compile) ───────┼──► B1.4 (Anthropic client) ──► B1.5 (fixtures)
            └──────── B1.3 (credentials) ──────────┘            │                         │
                         │  (handle type first)                  │                         │
A1.1 + A1.2 + A1.3 ──────┴──► B1.6 (emission) ◄── B1.1           ▼                         ▼
                                   └──────────────────────► B1.7 (try verb + live test) ──► B1.8
```

- **Immediately parallel:** B1.1, B1.2, B1.3 (no shared files; only B1.2 touches `bun.lock`).
- **Then:** B1.4 (needs B1.1 + B1.2 + B1.3's handle type) and B1.6 (needs B1.1 + A1.1–A1.3) in
  parallel.
- **Then:** B1.5 (after B1.4) and B1.7 (after B1.3 + B1.4 + B1.6) in parallel.
- **Last:** B1.8.
- **Shared-file hazards:** `cli-provider.ts` (B1.3 then B1.7 — sequential), `cli.ts` (B1.3 only),
  `backup-plan.ts` (B1.3 then B1.4 — sequential), `bun.lock` (B1.2 only), and
  `packages/core/src/index.ts` (B1.1, plus A1.1/A1.2/A1.4 — a trivial merge; keep B1's export lines
  in one block).
- **Numbering note for the coordinator:** the brief's "B1.4 needs A1.1's types" refers to the old
  five-row table's emission row, which is **B1.6** here (mapping above).
