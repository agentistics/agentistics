/**
 * native-gate.ts — the NATIVE harness and the model PROVIDERS are experimental (owner decision,
 * 2026-10-03): visible and usable only with the experimental flag on (`agentop experimental enable`,
 * which writes `AGENTISTICS_PROVIDER=1` at boot — `applyExperimental`; an explicit variable still
 * decides, as for every row of `EXPERIMENTAL_FEATURES`). ONE reading, here, for every surface:
 *
 * - the engine's native and provider routes answer 403 `experimental` (an engine that is present but
 *   gated — never the 404 `engine-absent` of a community build);
 * - `GET /api/engine` says `nativeExperimental`, which the web, the TUI and the MCP read;
 * - the projection query hides the native harness's figures (`agentistics`) and refuses to be asked
 *   for them by name.
 */
import { providerFlagOn } from './config'

/** The native runtime's harness id in the journal and the projections. */
export const NATIVE_HARNESS = 'agentistics'

/** The engine prefixes that belong to the native harness and the providers. The marketplace installs
 *  into the native harness's catalogue, so it is gated with it (MKT.UI). */
export const NATIVE_PREFIXES = ['/api/runtime/sessions', '/api/provider', '/api/marketplace'] as const

export function nativeExperimentalOn(env: Record<string, string | undefined> = process.env): boolean {
  return providerFlagOn(env)
}

export const EXPERIMENTAL_SENTENCE = {
  en: 'The native Agentistics harness and model providers are experimental — turn them on with `agentop experimental enable`.',
  pt: 'O harness nativo do Agentistics e os provedores de modelo são experimentais — ative com `agentop experimental enable`.',
} as const

export const EXPERIMENTAL_REFUSAL = { error: 'experimental', sentence: EXPERIMENTAL_SENTENCE.en, sentencePt: EXPERIMENTAL_SENTENCE.pt } as const

/** The 403 for a native/provider path while the flag is off; `null` when the path is not one, or it is on. */
export function nativeGateRefusal(pathname: string, on: boolean): { status: 403; body: typeof EXPERIMENTAL_REFUSAL } | null {
  if (on) return null
  const native = NATIVE_PREFIXES.some(p => pathname === p || pathname.startsWith(p + '/'))
  return native ? { status: 403, body: EXPERIMENTAL_REFUSAL } : null
}
