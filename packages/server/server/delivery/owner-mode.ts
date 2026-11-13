/**
 * delivery/owner-mode.ts — the `delivery.ownerProof` preference (ENTREGA.GARANTIDA §2.3, D1).
 * Absent / unreadable reads as `legacy`. `required` is opt-in and written only through the owner's fresh
 * proof (`vault/gate.ts` `setOwnerProofMode`), never by the generic preferences PUT.
 */
import { readPreferences, updatePreferences } from '../preferences'
import { parseOwnerProofMode, type OwnerProofMode } from './principal'

export async function readOwnerProofMode(): Promise<OwnerProofMode> {
  try { return parseOwnerProofMode((await readPreferences()).delivery?.ownerProof) } catch { return 'legacy' }
}

export async function writeOwnerProofMode(mode: OwnerProofMode): Promise<void> {
  await updatePreferences(cur => ({ delivery: { ...(cur.delivery ?? {}), ownerProof: mode } }))
}
