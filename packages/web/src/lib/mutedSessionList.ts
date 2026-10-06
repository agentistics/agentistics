import { sessionIdentityKey } from '@agentistics/core'

export interface MutedSessionRow {
  id: string
  conversationId?: string
  title: string
  harness: string
}

/** The muted sessions currently known by the fleet, in fleet order. */
export function mutedSessionRows<T extends MutedSessionRow>(
  rows: readonly T[],
  mutedKeys: readonly string[],
): T[] {
  const muted = new Set(mutedKeys)
  const seen = new Set<string>()
  return rows.filter(row => {
    const key = sessionIdentityKey(row)
    if (!muted.has(key) || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function mutedSessionCount(rows: readonly MutedSessionRow[], mutedKeys: readonly string[]): number {
  return mutedSessionRows(rows, mutedKeys).length
}
