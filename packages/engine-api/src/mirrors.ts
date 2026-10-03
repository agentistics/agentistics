/**
 * mirrors.ts — the public vocabulary this contract names, re-declared STRUCTURALLY.
 *
 * This package is Apache-2.0 and the platform packages are not, so it may import none of them
 * (the licensing lint fails the build if it does). Each type below mirrors one the host already
 * owns; the host side proves the two still agree with a type-level test
 * (`packages/server/server/engine/engine-api-mirrors.test.ts`), so a drift fails `tsc` in the
 * public repository, at the place it happens.
 *
 * Where the host's type is large (a canonical event, a capability state), the mirror is the
 * smallest shape the contract reads, and the host's own type must be ASSIGNABLE to it.
 */

/** Mirrors `HarnessId` — must stay EQUAL to the host's union. */
export type HarnessId = 'claude' | 'codex' | 'gemini' | 'copilot' | 'antigravity' | 'kimi' | 'opencode'

/** Mirrors `ProviderId` — must stay EQUAL to the host's union. */
export type ProviderId = 'anthropic' | 'openai' | 'google' | 'moonshot' | 'openai-compatible' | 'other'

/** Mirrors the keys of the host's exposure `Capabilities` — must stay EQUAL. A route names one of
 *  these, never a new one. */
export type CapabilityName =
  | 'localShell'
  | 'localChat'
  | 'localTranscripts'
  | 'localProcesses'
  | 'mcpAdmin'
  | 'requireMfaForOwner'
  | 'requireSecureCookies'

/** The part of a canonical event the contract reads. The host's event type is assignable to it. */
export interface EngineEvent {
  eventId: string
  type: string
  occurredAt: string
}

/** The part of a capability state the contract reads. */
export interface EngineCapabilityState {
  state: 'supported' | 'partial' | 'not_supported' | 'not_applicable' | 'unknown'
}

/** Mirrors the host's health issue shape. */
export interface EngineHealthIssue {
  id: string
  severity: 'error' | 'warning' | 'info'
  title: string
  description: string
  guide?: string
}

/**
 * Mirrors the host's `SessionActivity` (1.4) — what a managed session is doing right now, as the
 * fleet poll reads it off the screen. Must stay EQUAL (`engine-api-mirrors.test.ts`).
 */
export type EngineSessionActivity = 'working' | 'waiting-approval' | 'waiting' | 'exited'
