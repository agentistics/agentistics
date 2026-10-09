/**
 * acp-backend.ts — A5.4's composite, kept as the name its callers and tests know. Since F2.0 it IS
 * `withStructured` (`structured-backend.ts`) with the `adapter-chat` flag off: a spawn whose harness the
 * person opted into (`preferences.acpHarnesses`) and that the engine drives over ACP (`engine.acp`) is
 * started there; everything else, and every ACP start that fails, is tmux's — byte for byte as before.
 */
import type { EngineAcp } from '@agentistics/engine-api'
import { withStructured, type StructuredBackend } from './structured-backend'
import type { SessionBackend } from './types'

export { harnessOfArgv } from './structured-backend'

export interface AcpProvider {
  acp(): Promise<EngineAcp | null>
  /** The harnesses the person opted into, read fresh each spawn. */
  allowed(): Promise<readonly string[]>
}

export function withAcp(base: SessionBackend, provider: AcpProvider): StructuredBackend & { acpSessions(): string[] } {
  const b = withStructured(base, { acp: provider.acp, allowed: provider.allowed, structured: async () => null })
  return Object.assign(b, { acpSessions: () => b.structuredSessions().map(s => s.id) })
}
