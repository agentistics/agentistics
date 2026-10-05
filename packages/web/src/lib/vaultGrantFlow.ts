/**
 * Sending a `:vault` chip (owner, 2026-10-04) — what the composer owes the person BEFORE it asks anything.
 *
 *  - vault OPEN on this computer  → `direct`: the click on Send, in their own composer, is the consent.
 *    No Windows Hello, no code; the per-session grant is still minted, audited and dies on lock.
 *  - vault LOCKED                 → `unlock-first`: one line says why, then the ordinary inline unlock runs
 *    ONCE. The grant that follows needs nothing more until the vault locks again.
 *  - a phone / remote origin      → `remote`: its own passkey / code path, exactly as before (never Hello
 *    off loopback).
 */
export type GrantStep = 'direct' | 'unlock-first' | 'remote'

export function grantStep(a: { loopback: boolean; locked: boolean }): GrantStep {
  if (!a.loopback) return 'remote'
  return a.locked ? 'unlock-first' : 'direct'
}

export const UNLOCK_FIRST_LINE = {
  pt: 'Para enviar estas credenciais o cofre precisa ser aberto (Windows Hello + código).',
  en: 'To send these credentials the vault has to be opened (Windows Hello + code).',
} as const
