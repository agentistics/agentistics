/**
 * user-prefs-store.ts — the central's per-ACCOUNT UI preferences (`userPrefs` collection).
 *
 * A collection of its own rather than a field on AccountDoc: accounts are listed by the governance
 * panels and mapped to `PublicAccount`, and UI preferences have no business travelling with an
 * identity record.
 */
import type { AccessibilityPrefs } from '@agentistics/core'

export interface UserPrefsDoc {
  /** The accountId. */
  _id: string
  accessibility?: AccessibilityPrefs
  /** A person's own interface arrangement, by key — see user-ui-prefs.ts for the closed list. */
  ui?: Record<string, unknown>
  /** Local write timestamp. */
  updatedAt: Date
}

const localPrefs = new Map<string, UserPrefsDoc>()

export async function readUserAccessibility(accountId: string): Promise<AccessibilityPrefs | null> {
  return localPrefs.get(accountId)?.accessibility ?? null
}

export async function writeUserAccessibility(accountId: string, prefs: AccessibilityPrefs): Promise<void> {
  const current = localPrefs.get(accountId) ?? { _id: accountId, updatedAt: new Date() }
  localPrefs.set(accountId, { ...current, accessibility: prefs, updatedAt: new Date() })
}

export async function readUserUi(accountId: string): Promise<unknown> {
  return localPrefs.get(accountId)?.ui ?? null
}

/** Each named key is replaced whole (`$set` on `ui.<key>`); keys not named are left as they are. */
export async function writeUserUi(accountId: string, patch: Record<string, unknown>): Promise<void> {
  const current = localPrefs.get(accountId) ?? { _id: accountId, updatedAt: new Date() }
  localPrefs.set(accountId, { ...current, ui: { ...(current.ui ?? {}), ...patch }, updatedAt: new Date() })
}

/** Called when an account is deleted — its preferences have no owner left. */
export async function deleteUserPrefs(accountId: string): Promise<void> {
  localPrefs.delete(accountId)
}
