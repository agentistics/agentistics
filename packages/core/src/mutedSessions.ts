/**
 * mutedSessions.ts — the one rule for which sessions have their notifications switched off.
 *
 * A mute is keyed by `sessionIdentityKey` (conversationId ?? id), so it survives a reopen, and it
 * suppresses DELIVERY only — never the session's fleet state. Absent = on. The web store, the
 * server's event producer and the MCP/CLI door all read and write through these.
 */

export const MAX_MUTED = 500

/** PURE: the set after muting/unmuting `key`. Idempotent; never mutates `current`. */
export function planMute(current: readonly string[], key: string, muted: boolean): string[] {
  const has = current.includes(key)
  if (muted) return has ? [...current] : [...current, key].slice(-MAX_MUTED)
  return has ? current.filter(x => x !== key) : [...current]
}
