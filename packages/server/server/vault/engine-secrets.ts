/**
 * vault/engine-secrets.ts — engine-api 1.5 `secrets`: the vault as an engine may use it.
 *
 * The engine hands over bytes and gets bytes back; it never sees the data key. Only purposes in the
 * `engine/` namespace are served — anything else is refused (`purpose`) at RUNTIME as well
 * as by type, because an engine is code this host did not compile, and a per-purpose subkey makes the
 * same boundary cryptographic: `engine/provider-key` and the host's `github-backup` are different keys.
 */
import type { EngineSecrets, EngineSecretsStatus, OpenResult, SealResult, VaultRefusal } from '@agentistics/engine-api'
import { VaultRefusalError, isEnginePurpose } from '@agentistics/vault'
import type { EngineAuditEvent } from '@agentistics/engine-api'
import { autoLockRemainingMs, openBytes, refused, sealBytes, sentence, setVaultStateListener, vaultAudit, vaultStatusSync } from './service'

const ENGINE_CODES = new Set<VaultRefusal>(['uninitialized', 'locked', 'protector-lost', 'wrong-machine', 'tampered', 'purpose'])

function asEngineCode(code: string): VaultRefusal {
  if (ENGINE_CODES.has(code as VaultRefusal)) return code as VaultRefusal
  // `no-protector` / `protector-unavailable` are the uninitialized state with a reason.
  return code === 'no-protector' || code === 'protector-unavailable' ? 'uninitialized' : 'locked'
}

function refusePurpose(): ReturnType<typeof refused<'purpose'>> {
  return refused('purpose', sentence('purpose'))
}

type LockedBy = NonNullable<EngineSecretsStatus['lockedBy']>

/** Status bookkeeping only (callbacks, a flag, a reason code) — never a secret. Built by a function so it is one named object, not loose module-level bindings. */
function newBook() {
  return { subscribers: new Set<(s: EngineSecretsStatus) => void>(), everOpen: false, lockedBy: undefined as LockedBy | undefined, lastState: null as EngineSecretsStatus['state'] | null }
}
const book = newBook()

/**
 * engine-api 1.6 `status()`. `lockedBy` is stated ONLY when this module knows it: the reason an
 * auto-lock / user lock / frozen step-up / lost presence happened is reported by the vault through
 * `notifyEngineSecretsChange` (S4.7), and `start` is the one cause known without it — a vault that
 * has not been open in this process since it started. Anything else stays absent, which a 1.6 engine
 * treats as "locked, reason unknown" and says so — never a guessed reason.
 */
export function engineSecretsStatus(): EngineSecretsStatus {
  const s: EngineSecretsStatus = vaultStatusSync()
  if (s.state === 'open') { book.everOpen = true; book.lockedBy = undefined; s.autoLockInMs = autoLockRemainingMs(); return s }
  if (s.state === 'locked') {
    const by = book.lockedBy ?? (book.everOpen ? undefined : 'start')
    if (by) s.lockedBy = by
  }
  return s
}

/** Called by the vault when its state changes (S4.7 wires auto-lock/user lock/step-up freeze here). */
export function notifyEngineSecretsChange(lockedBy?: LockedBy): void {
  book.lockedBy = lockedBy
  const s = engineSecretsStatus()
  if (s.state === book.lastState && lockedBy === undefined) return
  book.lastState = s.state
  for (const cb of [...book.subscribers]) { try { cb(s) } catch { /* a subscriber never breaks the vault */ } }
}

export function __resetEngineSecretsForTests(): void { Object.assign(book, newBook()) }

// Review S5: the vault tells this module on every open and lock (with the reason). Registered on
// import — the engine host imports this module before an engine can subscribe.
setVaultStateListener(by => notifyEngineSecretsChange(by))

export function engineSecrets(): EngineSecrets {
  return {
    status: () => engineSecretsStatus(),
    onStateChange(cb) {
      book.subscribers.add(cb)
      return () => { book.subscribers.delete(cb) }
    },
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
