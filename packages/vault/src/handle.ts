/**
 * handle.ts — a vault HANDLE: one open data key bound to ONE scope (SECRETS.4 §1.1, §6.3).
 *
 * The two scopes are two vaults with two data keys, so the separation is cryptographic. The handle
 * is the third of the three ways the hard rule is enforced ("the runner scope never reads the human
 * scope"): the runner code path is constructed with a `RunnerHandle`, whose `seal`/`open` accept
 * only `cloud-runner/*` purposes BY TYPE, and refuse anything else at RUNTIME before any crypto — a
 * runner process is given no object through which a human purpose is even nameable.
 *
 * There is no `scope` argument anywhere a caller could set: the scope is fixed when the handle is
 * made from the vault that was opened, and every purpose is checked against it.
 *
 * The handle keeps its OWN copy of the data key and `close()` zeroes it; after `close()` every call
 * refuses (`closed`).
 */
import type { EnginePurpose, HostPurpose, HumanExtraPurpose, RunnerPurpose, VaultScope } from './format'
import { isKid } from './format'
import { openRecord, sealToBytes, type OpenFailure } from './seal'

export type HumanPurpose = HostPurpose | EnginePurpose | HumanExtraPurpose
export type PurposeOf<S extends VaultScope> = S extends 'cloud-runner' ? RunnerPurpose : HumanPurpose

export type HandleOpen = { ok: true; plaintext: Uint8Array } | { ok: false; code: OpenFailure | 'closed'; kid?: string }

export interface VaultHandle<S extends VaultScope> {
  readonly scope: S
  readonly kid: string
  /** Seal to the `.sealed` file's bytes. THROWS for a purpose of the other scope, or once closed. */
  seal(purpose: PurposeOf<S>, name: string, plaintext: Uint8Array): Uint8Array
  /** Open a sealed file. A purpose of the other scope is `purpose`, checked before any crypto. */
  open(purpose: PurposeOf<S>, name: string, bytes: Uint8Array | string): HandleOpen
  /** Zero this handle's copy of the data key. Idempotent. */
  close(): void
  readonly closed: boolean
}

export type HumanHandle = VaultHandle<'human'>
export type RunnerHandle = VaultHandle<'cloud-runner'>

/**
 * Make a handle over an open data key. The DEK is COPIED: the caller keeps (and zeroes) its own.
 * `scope` is the scope recorded in the vault that produced the key — never a caller's choice.
 */
export function makeHandle<S extends VaultScope>(scope: S, dek: Uint8Array, kid: string): VaultHandle<S> {
  if (!isKid(kid)) throw new Error('vault: handle needs a valid key id')
  if (dek.length !== 32) throw new Error('vault: data key has the wrong length')
  const key = new Uint8Array(dek)
  let closed = false
  return {
    scope,
    kid,
    get closed() { return closed },
    seal(purpose, name, plaintext) {
      if (closed) throw new Error('vault: the handle is closed')
      return sealToBytes({ dek: key, kid, scope, purpose, name, plaintext })
    },
    open(purpose, name, bytes) {
      if (closed) return { ok: false, code: 'closed' }
      return openRecord({ dek: key, kid, scope, purpose, name, bytes })
    },
    close() {
      key.fill(0)
      closed = true
    },
  }
}
