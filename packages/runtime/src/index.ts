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
export * from './provider/stream.ts'
export * from './stream/event-stream.ts'
export * from './provider/openai-compatible/client.ts'
export * from './provider/openai-compatible/raw.ts'
export * from './provider/openai-compatible/usage.ts'
export * from './provider/openai-compatible/models.ts'
// ── B3: the tool loop, the policy, the tools and the sandbox ────────────────────────────────────
// `tools/grant.ts` is deliberately NOT exported: minting a grant is the gate's alone
// (`tools-gate.lint.test.ts`), and a public `mintGrant` would be a door around the policy for any
// host. `tools/testing.ts` (offline doubles) is not exported either.
export * from './tools/contract.ts'
export * from './tools/define.ts'
export * from './tools/gate.ts'
export * from './tools/paths.ts'
export * from './tools/catalogue.ts'
export * from './tools/file/index.ts'
export * from './tools/fs/index.ts'
export * from './tools/shell/index.ts'
export * from './tools/git/index.ts'
export * from './tools/interact/plan.ts'
export * from './tools/interact/ask-user.ts'
export * from './loop/loop.ts'
export * from './loop/emit.ts'
export * from './loop/wire.ts'
export * from './policy/index.ts'
export * from './sandbox/index.ts'
// ── B4.1: session and run lifecycle, recorded ───────────────────────────────────────────────────
export * from './session/types.ts'
export * from './session/content-store.ts'
export * from './session/sqlite-store.ts'
export * from './session/lifecycle.ts'
export * from './session/scheduler.ts'
export * from './session/runtime.ts'
export * from './session/resume.ts'
export * from './session/protocol.ts'
export * from './session/hub.ts'
export * from './tools/env.ts'
