/**
 * Which lucide icon IS the vault, in one place (owner, 2026-10-04: the old `vault` glyph — a box with
 * a dial — read as an "X in a square" at nav size and was called ugly). Every surface that draws the
 * vault (header button, Nay panel tab, FAB pop, quick sheet, the page header) goes through
 * `VaultGlyph`, so changing the choice is one line here.
 */
export type VaultIconName = 'vault' | 'lock-keyhole' | 'key-round'

export const VAULT_ICON: VaultIconName = 'vault'

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
