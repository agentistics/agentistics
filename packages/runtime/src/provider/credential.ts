/**
 * credential.ts — TYPES ONLY. The credential contract the runtime consumes, owned by the runtime
 * and implemented by the HOST (D23: `@agentistics/runtime` never imports `packages/server`).
 *
 * The runtime never reads a key from disk, from the environment or from anywhere else: a client
 * that needs one is handed a `CredentialResolver` by whoever builds it. In the agentop binary that
 * host is `packages/server` — `server/provider/credentials.ts`'s `resolveCredential` reads the
 * stored key and `server/provider/credential-plan.ts`'s `createCredentialHandle` wraps it into the
 * opaque `CredentialHandle` declared here.
 *
 * No runtime binding lives in this module, so importing it can never pull a store, a path or a
 * secret into anything.
 */
import type { ProviderId } from '@agentistics/core'

/** Opaque reference to a stored credential. NEVER the credential itself. */
export interface CredentialRef {
  provider: ProviderId
  id: string
}

/** The ONLY shape in which a stored key reaches the runtime. */
export interface CredentialHandle {
  readonly provider: ProviderId
  /** `sha256:xxxxxxxx` — safe to print, log and compare. */
  readonly fingerprint: string
  /** The key itself. Callable only by the holders (`anthropic/client.ts` in practice) — the lint
   *  refuses the spelling everywhere else. Never store what it returns on an object that outlives
   *  the call that needed it. */
  reveal(): string
}

/** What resolving a stored credential can answer. The refusals are CODES, rendered by the caller. */
export type CredentialResolution =
  | { ok: true; handle: CredentialHandle }
  | { ok: false; reason: 'absent' | 'unreadable' | 'permissions-too-open' | 'wrong-provider' }

/**
 * Injected by the host into every client that needs a key. The host decides where keys live; a
 * resolver asked for a ref it could never have stored answers `wrong-provider` rather than asking
 * its store about it. Tests inject a fake so they never touch disk.
 */
export interface CredentialResolver {
  resolve(ref: CredentialRef): Promise<CredentialResolution>
}
