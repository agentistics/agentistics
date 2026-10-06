/**
 * vault/auth-policy.ts — where the per-action authentication policy lives (owner decision 2026-10-06;
 * the rules are the pure `action-policy.ts` in @agentistics/vault).
 *
 * The policy is SEALED (`vault/auth-policy.sealed`, purpose `vault/personal` — a reserved `vault/*`
 * purpose, so no same-user process can seal one through the socket, ops.ts `opSeal`). Integrity is the
 * point: a plain file anyone running as the user could edit would make "ask nothing to reveal" a file
 * write. Three readings:
 *
 *  - absent → no choice was ever made: today's behaviour (`DEFAULT_AUTH_POLICY`);
 *  - present and opened → the stored choices;
 *  - present and NOT openable (tampered, a foreign key, junk inside) → the STRICTEST policy — both proofs
 *    on every kind. A record that cannot be read is never read as "ask less".
 *
 * Reading needs the vault open (the record is sealed under its key). Every gated action needs the vault
 * open anyway; a locked vault refuses before the policy is consulted.
 */
import { join } from 'node:path'
import { DEFAULT_AUTH_POLICY, PERSONAL_PURPOSE, STRICTEST_AUTH_POLICY, parseAuthPolicy, type AuthPolicy } from '@agentistics/vault'
import { ensureVaultOpen, openFromFile, sealToFile, vaultDir } from './service'

const RECORD_NAME = 'auth/policy'
export function authPolicyFile(): string { return join(vaultDir(), 'auth-policy.sealed') }

/** `locked`: the vault is not open, so the record cannot be read — the screen says so, the gate never gets here. */
export type AuthPolicyRead = { policy: AuthPolicy; state: 'default' | 'stored' | 'unreadable' | 'locked' }

export async function readAuthPolicy(): Promise<AuthPolicyRead> {
  if (!(await ensureVaultOpen({ create: false, migrate: false }))) return { policy: DEFAULT_AUTH_POLICY, state: 'locked' }
  const r = await openFromFile(authPolicyFile(), PERSONAL_PURPOSE, RECORD_NAME)
  if (!r.ok) {
    if ('absent' in r && r.absent) return { policy: DEFAULT_AUTH_POLICY, state: 'default' }
    return { policy: STRICTEST_AUTH_POLICY, state: 'unreadable' }
  }
  try {
    const p = parseAuthPolicy(JSON.parse(new TextDecoder().decode(r.plaintext)))
    return p ? { policy: p, state: 'stored' } : { policy: STRICTEST_AUTH_POLICY, state: 'unreadable' }
  } catch {
    return { policy: STRICTEST_AUTH_POLICY, state: 'unreadable' }
  } finally {
    r.plaintext.fill(0)
  }
}

export async function writeAuthPolicy(p: AuthPolicy): Promise<void> {
  await sealToFile(authPolicyFile(), PERSONAL_PURPOSE, RECORD_NAME, new TextEncoder().encode(JSON.stringify(p)))
}
