import { useSyncExternalStore } from 'react'
import { loadVault } from './vaultApi'
import { vaultLockOf, type VaultLockState } from './vaultGlyph'
import { codeWindowEndsMs } from './vaultCountdown'

/** One poll of `/api/vault` shared by everything in the page that wants the lock state or its countdown. */
export interface VaultWatch {
  lock: VaultLockState; autoLockInMs: number | null; at: number
  /** When the authenticator code is asked again (ms epoch), or null when no window is running (VAULT.UX-R2). */
  codeWindowEndsAt: number | null
}
const POLL_MS = 15_000
let snap: VaultWatch = { lock: 'unknown', autoLockInMs: null, at: 0, codeWindowEndsAt: null }
const subs = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
let onFocus: (() => void) | null = null

export async function refreshVaultWatch(): Promise<VaultWatch> {
  const r = await loadVault()
  const view = r.kind === 'view' || r.kind === 'needs-stepup' ? r.view : null
  snap = view
    ? { lock: vaultLockOf(view.state), autoLockInMs: view.state === 'open' && typeof view.autoLockInMs === 'number' ? view.autoLockInMs : null, at: Date.now(), codeWindowEndsAt: codeWindowEndsMs(view.unlockPolicy, Date.now()) }
    : { lock: 'unknown', autoLockInMs: null, at: Date.now(), codeWindowEndsAt: null }
  for (const s of subs) s()
  return snap
}

function subscribe(cb: () => void): () => void {
  subs.add(cb)
  if (subs.size === 1) {
    void refreshVaultWatch()
    timer = setInterval(() => { void refreshVaultWatch() }, POLL_MS)
    onFocus = () => { void refreshVaultWatch() }
    window.addEventListener('focus', onFocus)
  }
  return () => {
    subs.delete(cb)
    if (subs.size === 0) { if (timer) clearInterval(timer); timer = null; if (onFocus) window.removeEventListener('focus', onFocus); onFocus = null }
  }
}

const quiet: VaultWatch = { lock: 'unknown', autoLockInMs: null, at: 0, codeWindowEndsAt: null }
export function useVaultWatch(enabled: boolean): VaultWatch {
  const live = useSyncExternalStore(enabled ? subscribe : () => () => {}, () => snap, () => quiet)
  return enabled ? live : quiet
}
