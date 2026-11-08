/**
 * vault/password-context.ts — the vault password for the ONE request in flight (COFRE.DESBLOQUEIO,
 * 2026-11-07).
 *
 * A vault protected by its own password asks for it wherever Windows Hello would ask for a gesture: at
 * the unlock and at every confirmed action. Rather than threading a new field through the dozens of
 * routes and gate calls that may end up asking, the request's password is held in an AsyncLocalStorage
 * for the duration of that request only: `http.ts` reads the `x-vault-password` header, the local
 * socket reads the op's `password` field, and the password protector reads it from here when (and only
 * when) the gate asks it to prove the person. It is never stored outside the request, never logged,
 * never echoed, and gone when the request's async chain ends.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { VAULT_PASSWORD_MAX_LENGTH } from '@agentistics/core'

const store = new AsyncLocalStorage<{ password: string | undefined }>()

/** The password the current request carried, or undefined. */
export function currentVaultPassword(): string | undefined {
  return store.getStore()?.password
}

/** PURE. A header / field value that can be a password: a non-empty string within the bound. */
export function passwordInput(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && [...v].length <= VAULT_PASSWORD_MAX_LENGTH ? v : undefined
}

/** Run `fn` with `password` as the request's vault password. */
export function withVaultPassword<T>(password: string | undefined, fn: () => Promise<T>): Promise<T> {
  return store.run({ password }, fn)
}
