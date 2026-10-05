/**
 * The vault's picture is ONE drawing — a solid safe (owner-approved, 2026-10-05, style "C Sólido"): a
 * silhouette with the dial cut out, a handle on the side and two feet. Every surface that draws the vault
 * (header button, Nay tab, FAB pop, quick sheet, the page, settings) goes through `VaultGlyph`.
 */

/** Lock state as the header icon shows it: a dot, never a colour alone (the tooltip says it too). */
export type VaultLockState = 'open' | 'locked' | 'unknown'

/** `/api/vault`'s `state` word → what the icon shows. Anything else (down, refused) is `unknown`. */
export function vaultLockOf(state: unknown): VaultLockState {
  if (state === 'open') return 'open'
  return typeof state === 'string' && state !== '' ? 'locked' : 'unknown'
}

export function vaultLockWord(s: VaultLockState, pt: boolean): string {
  if (s === 'open') return pt ? 'aberto' : 'unlocked'
  if (s === 'locked') return pt ? 'trancado' : 'locked'
  return pt ? 'estado desconhecido' : 'state unknown'
}

/**
 * The badge on the header button: red + a CLOSED padlock when locked, green + an OPEN padlock when open
 * (owner, 2026-10-05). `unknown` (the server did not answer) draws NO badge — a colour for a state nobody
 * could read would be the confident answer this product refuses elsewhere.
 */
export function vaultBadgeOf(s: VaultLockState): { color: string; shape: 'open' | 'closed' } | null {
  if (s === 'open') return { color: '#22c55e', shape: 'open' }
  if (s === 'locked') return { color: '#ef4444', shape: 'closed' }
  return null
}
