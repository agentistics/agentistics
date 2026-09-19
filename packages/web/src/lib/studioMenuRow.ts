import type { ReactNode } from 'react'

/**
 * The mobile session menu's "Studio" row (§2 of the slots/references design), pulled out of
 * `SessionsPage.tsx`'s `extra` array literal into its own module so its `on: studioOpen` wiring can
 * be tested without importing the page itself. `SessionsPage.tsx` pulls in the whole fleet, filters
 * and session state — `sessionsPage.lint.test.ts` already documents it as not mountable in a unit
 * test — and importing a module only for the side effect of resolving one named export is exactly
 * the hazard that comment warns about. `onSelect` and `icon` stay parameters rather than being fixed
 * here so the call site keeps deciding what pressing the row DOES; only the `on` wiring — which
 * mirrors the desktop button's `useStudioShown` flag — is what this guards.
 */
export function studioMenuRow(
  studioOpen: boolean, icon: ReactNode, onSelect: () => void,
): { id: 'studio'; label: string; icon: ReactNode; on: boolean; onSelect: () => void } {
  return { id: 'studio', label: 'Studio', icon, on: studioOpen, onSelect }
}
