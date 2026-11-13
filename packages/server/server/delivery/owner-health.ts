/**
 * delivery/owner-health.ts — the health WARN for `delivery.ownerProof: legacy` (ENTREGA.GARANTIDA §2.3.2).
 * PURE. Permanent while the mode is `legacy`; a warning, never an error, and it blocks nothing.
 */
import type { HealthIssue } from '@agentistics/core'
import type { OwnerProofMode } from './principal'

/** What the vault can give, as far as the health check knows it (it never opens or unlocks anything). */
export type OwnerProofVault = 'none' | 'silent-only' | 'human' | 'unknown'

const TAMPER_WHY: Record<string, string> = {
  unreadable: 'the owner-proof mode record cannot be read',
  forged: 'the owner-proof mode record does not carry the vault\'s seal (it was edited by hand or copied)',
  replayed: 'an older owner-proof mode record was put back over a newer one',
  vanished: 'the owner-proof mode record was deleted while agentop was running',
  disagree: 'preferences.json says "legacy" while the sealed owner-proof mode record says "required"',
}

/** S0d.1: the mode is read as `required` because a file around it was tampered with. A warning: it blocks nothing more than `required` does. */
export function analyzeOwnerModeTamper(tampered: string | undefined, issues: HealthIssue[]): void {
  if (!tampered) return
  issues.push({
    id: 'delivery-owner-mode-tampered',
    severity: 'warning',
    title: 'The delivery owner-proof mode was tampered with — reading it as required',
    description: `${TAMPER_WHY[tampered] ?? tampered}. Owner moves keep asking for the vault proof (fail closed). Something with access to your files changed it; check which sessions were running.`,
    guide: 'Choose the mode again in Settings → Vault (it asks the vault proof and re-seals the record).',
  })
}

/**
 * S0d.2: `guards.json` / `guarantees.json` are not what agentop sealed (QA F2: deleting or editing them used to turn the
 * rules off in silence), plus §2.7's `guarantee-off: <rule>, by <via>` for every rule the owner turned off.
 */
export function analyzeGuardIntegrity(f: { guaranteesWarn?: string; guardsTamper?: string; offWarnings: readonly string[] }, issues: HealthIssue[]): void {
  if (f.guardsTamper) {
    issues.push({
      id: 'guards-tampered', severity: 'warning',
      title: 'The delivery guard checkpoints (guards.json) were tampered with',
      description: `guards.json is not what agentop sealed (${f.guardsTamper}). Every guarded board move is refused until it is repaired, so no forged authorization is believed.`,
      guide: 'Check which sessions were running; the checkpoints are rebuilt by `agentop flow guarantee-migrate` once that verb ships (S10).',
    })
  }
  if (f.guaranteesWarn) {
    issues.push({
      id: 'guarantees-tampered', severity: 'warning',
      title: 'The delivery guarantee switches (guarantees.json) were tampered with',
      description: `${f.guaranteesWarn}. The rules keep their last sealed state; nothing was turned off.`,
      guide: 'Set the rule again as the owner (`agentop flow guarantee <off|shadow|activate> <rule>` with the vault proof) — that re-seals the file.',
    })
  }
  for (const w of f.offWarnings) {
    issues.push({ id: `guarantee-off:${w.split(':')[1]?.split(',')[0]?.trim() ?? ''}`, severity: 'warning', title: w, description: `${w}. The owner turned this delivery rule off; it stays WARNed until it is back on.`, guide: 'agentop flow guarantee shadow <rule>' })
  }
}

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
