/**
 * delivery/owner-health.ts — the health WARN for `delivery.ownerProof: legacy` (ENTREGA.GARANTIDA §2.3.2).
 * PURE. Permanent while the mode is `legacy`; a warning, never an error, and it blocks nothing.
 */
import type { HealthIssue } from '@agentistics/core'
import type { OwnerProofMode } from './principal'

/** What the vault can give, as far as the health check knows it (it never opens or unlocks anything). */
export type OwnerProofVault = 'none' | 'silent-only' | 'human' | 'unknown'

export function analyzeOwnerProof(mode: OwnerProofMode, vault: OwnerProofVault, frozen: boolean, issues: HealthIssue[]): void {
  if (mode === 'required') return
  const next = vault === 'human'
    ? 'Switch the delivery owner proof to required (Settings → Vault).'
    : vault === 'silent-only'
      ? 'Add a password or Windows Hello / Touch ID to the vault, then switch the delivery owner proof to required.'
      : 'Set up the vault with a password or Windows Hello / Touch ID, then switch the delivery owner proof to required.'
  issues.push({
    id: 'delivery-owner-unproven',
    severity: 'warning',
    title: 'Any local process can act as the owner on this machine',
    description: 'Approving or forcing a delivery move does not ask for a proof of the vault credential. Set up the vault (or add a password/Hello to it) and switch to required.'
      + (frozen ? ' The vault authenticator gate is also frozen.' : ''),
    guide: next,
  })
}
