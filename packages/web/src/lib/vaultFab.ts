/**
 * vaultFab.ts — the vault icon that pops up ABOVE the Nay chat button (owner, 2026-10-03).
 *
 * Right-click on the button (a long-press on touch, Shift+F10 or the context-menu key from the
 * keyboard) summons a vault icon; clicking it opens the quick vault, clicking anywhere else or
 * pressing Escape sends it back into the button. PURE: the DOM half is `components/nay/VaultFabPop.tsx`.
 *
 * The phases exist so the icon can ANIMATE OUT: a dismiss does not unmount it, it enters `leaving`
 * and only the end of that animation (`settled`) takes it away. A summon during `leaving` brings it
 * straight back — a person who right-clicks twice quickly must not be left with nothing.
 */

export type VaultFabPhase = 'hidden' | 'shown' | 'leaving'

export type VaultFabEvent =
  | { type: 'summon' }
  /** An outside press, Escape, a drag of the button, or the button going away. */
  | { type: 'dismiss' }
  /** The disappear animation finished (or there was none). */
  | { type: 'settled' }
  /** The icon itself was activated: it leaves AND the quick vault opens. */
  | { type: 'activate' }

export interface VaultFabState {
  phase: VaultFabPhase
  /** The quick vault sheet is open (independent of the icon, which leaves as the sheet opens). */
  panel: boolean
}

export const VAULT_FAB_INITIAL: VaultFabState = { phase: 'hidden', panel: false }

export function vaultFabReduce(s: VaultFabState, e: VaultFabEvent): VaultFabState {
  switch (e.type) {
    case 'summon': return s.phase === 'shown' ? s : { ...s, phase: 'shown' }
    case 'dismiss': return s.phase === 'shown' ? { ...s, phase: 'leaving' } : s
    case 'settled': return s.phase === 'leaving' ? { ...s, phase: 'hidden' } : s
    case 'activate': return s.phase === 'hidden' ? s : { phase: 'leaving', panel: true }
  }
}

/** The sheet closing is its own fact: the icon stays wherever it was (normally already hidden). */
export function closeVaultPanel(s: VaultFabState): VaultFabState {
  return s.panel ? { ...s, panel: false } : s
}

/** Is the icon in the DOM at all? (`leaving` still is — it is animating out.) */
export const vaultIconMounted = (s: VaultFabState): boolean => s.phase !== 'hidden'

/** The touch long-press that summons it, and how far a finger may wander before it is a drag. */
export const VAULT_LONG_PRESS_MS = 450
export const VAULT_PRESS_SLOP = 6

/** Keys that summon it from a focused button: Shift+F10 and the context-menu key. */
export function isContextMenuKey(e: { key: string; shiftKey: boolean }): boolean {
  return e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)
}

export interface VaultFabMotion {
  /** CSS `animation` for the icon while `shown` / `leaving`. */
  enter: string
  leave: string
  /** How long `leaving` lasts before `settled` (the fallback timer if `animationend` never fires). */
  leaveMs: number
  /** The FAB's own glow/ripple when the icon opens; `null` = none. */
  ripple: string | null
}

/**
 * The look. Normal: the icon RISES from behind the button with a spring (scale 0.6 → 1, a slight
 * overshoot, fading in, 260 ms) and SINKS back reversed (180 ms), and the button gives one soft
 * ripple. Reduced motion: a plain fade both ways, no ripple.
 */
export function vaultFabMotion(reduced: boolean): VaultFabMotion {
  if (reduced) {
    return { enter: 'ag-vault-fade-in 160ms linear both', leave: 'ag-vault-fade-out 120ms linear both', leaveMs: 120, ripple: null }
  }
  return {
    enter: 'ag-vault-rise 260ms cubic-bezier(0.34, 1.56, 0.64, 1) both',
    leave: 'ag-vault-sink 180ms cubic-bezier(0.4, 0, 1, 1) both',
    leaveMs: 180,
    ripple: 'ag-vault-ripple 520ms ease-out both',
  }
}
