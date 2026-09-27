/**
 * @agentistics/runtime — the native provider layer (D23).
 *
 * Compiled into the single agentop binary AND publishable on its own, so it may never import from
 * `packages/server` or `packages/web`. Everything the host owns reaches it through three seams:
 *
 *  1. Credentials — a `CredentialResolver` (`provider/credential.ts`), injected into
 *     `createAnthropicClient({ resolver, … })` / `createProviderClients`.
 *  2. Raw captures — a capture directory, injected as `captureDir` (and `writeCapture`'s `opts.dir`).
 *  3. The journal — a `ProviderJournalSink` (`provider/emit.ts`), passed to `createProviderEmitter`.
 */
export * from './provider/credential.ts'
export * from './provider/client.ts'
export * from './provider/registry.ts'
export * from './provider/retry.ts'
export * from './provider/capture.ts'
export * from './provider/emit.ts'
export * from './provider/anthropic/client.ts'
export * from './provider/anthropic/raw.ts'
