import type { SessionMeta } from '@agentistics/core'

/** Identity key for a session row. Harness is part of it so ids never collide across harnesses. */
export function sessionKey(s: SessionMeta): string {
  return `${s.harness ?? 'claude'}:${s.session_id}`
}
