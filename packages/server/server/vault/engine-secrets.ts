/**
 * vault/engine-secrets.ts — engine-api 1.5 `secrets`: the vault as an engine may use it.
 *
 * The engine hands over bytes and gets bytes back; it never sees the data key. Only purposes in the
 * `engine/` namespace are served — anything else is refused (`purpose`) at RUNTIME as well
 * as by type, because an engine is code this host did not compile, and a per-purpose subkey makes the
 * same boundary cryptographic: `engine/provider-key` and the host's `github-backup` are different keys.
 */
import type { EngineSecrets, OpenResult, SealResult, VaultRefusal } from '@agentistics/engine-api'
import { VaultRefusalError, isEnginePurpose } from '@agentistics/vault'
import type { EngineAuditEvent } from '@agentistics/engine-api'
import { openBytes, refused, sealBytes, sentence, vaultAudit, vaultStatusSync } from './service'

const ENGINE_CODES = new Set<VaultRefusal>(['uninitialized', 'locked', 'protector-lost', 'wrong-machine', 'tampered', 'purpose'])

function asEngineCode(code: string): VaultRefusal {
  if (ENGINE_CODES.has(code as VaultRefusal)) return code as VaultRefusal
  // `no-protector` / `protector-unavailable` are the uninitialized state with a reason.
  return code === 'no-protector' || code === 'protector-unavailable' ? 'uninitialized' : 'locked'
}

function refusePurpose(): ReturnType<typeof refused<'purpose'>> {
  return refused('purpose', sentence('purpose'))
}

export function engineSecrets(): EngineSecrets {
  return {
    status: () => vaultStatusSync(),
    async seal(purpose, name, plaintext): Promise<SealResult> {
      if (!isEnginePurpose(purpose) || typeof name !== 'string' || name === '') return refusePurpose()
      try {
        return { ok: true, sealed: await sealBytes(purpose, name, plaintext) }
      } catch (err) {
        if (err instanceof VaultRefusalError) return { ok: false, code: asEngineCode(err.code), sentence: err.message }
        return refused('locked', sentence('locked'))
      }
    },
    async open(purpose, name, sealed): Promise<OpenResult> {
      if (!isEnginePurpose(purpose) || typeof name !== 'string' || name === '') return refusePurpose()
      const r = await openBytes(purpose, name, sealed)
      return r.ok ? r : { ok: false, code: asEngineCode(r.code), sentence: r.sentence }
    },
  }
}

const VAULT_ACTIONS = new Set(['vault.migrated', 'vault.plaintext-pending', 'vault.migration-failed'])

/**
 * engine-api 1.5: an engine reports ITS migration (S1, provider keys) through `host.audit` with a
 * `vault.*` action, and it lands in the same `vault/audit.jsonl` as the host's own — never in the
 * central's Mongo audit. Only `purpose` (an `engine/…` one) and `name` are carried, as bounded
 * strings; every other meta field is dropped, so nothing an engine passes can put a value there.
 * Returns whether the event was a vault event (handled here).
 */
export function routeEngineVaultAudit(e: EngineAuditEvent): boolean {
  if (!VAULT_ACTIONS.has(e.action)) return false
  const purpose = typeof e.meta?.purpose === 'string' && isEnginePurpose(e.meta.purpose) ? e.meta.purpose : undefined
  const name = typeof e.meta?.name === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(e.meta.name) ? e.meta.name : undefined
  vaultAudit({ type: e.action as 'vault.migrated' | 'vault.plaintext-pending' | 'vault.migration-failed', purpose, name, source: 'engine' })
  return true
}
