/**
 * delivery/integrity-status.ts — the S0d states, readable by every door (REST `GET /api/deliveries/integrity`, the MCP
 * `agentistics_vault_status`, the health panel): the effective owner-proof mode and why it is not the file's word when
 * it is not (S0d.1), and whether `guarantees.json` / `guards.json` are what agentop sealed (S0d.2). Reads only; it
 * never opens the vault, takes a lock or repairs anything.
 */
import { dirname, join } from 'node:path'

export interface DeliveryIntegrity {
  ownerProof: { mode: 'legacy' | 'required'; tampered?: string }
  guarantees: { rules: Record<string, string>; tampered?: string }
  guards: { tampered?: string }
}

export async function deliveryIntegrity(): Promise<DeliveryIntegrity> {
  const [{ readOwnerModeState }, { createGuaranteesStore, RULE_IDS, ruleState }, { createGuardsStore, GuardsUnreadable }, { defaultGuardLockPaths }] = await Promise.all([
    import('./owner-mode'), import('./activation'), import('./guards-store'), import('./guard-locks'),
  ])
  const dir = dirname(defaultGuardLockPaths().tasks)
  const owner = await readOwnerModeState()
  const g = await createGuaranteesStore(join(dir, 'guarantees.json')).read()
  let guardsTamper: string | undefined
  try { await createGuardsStore(join(dir, 'guards.json')).read() } catch (e) { guardsTamper = e instanceof GuardsUnreadable ? (e.tampered ?? e.why) : 'unreadable' }
  return {
    ownerProof: { mode: owner.mode, ...(owner.tampered ? { tampered: owner.tampered } : {}) },
    guarantees: { rules: Object.fromEntries(RULE_IDS.map(r => [r, ruleState(g.doc, r)])), ...(g.tampered ? { tampered: g.tampered } : {}) },
    guards: guardsTamper ? { tampered: guardsTamper } : {},
  }
}
