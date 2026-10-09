/**
 * relink-policy.ts — PURE: may a row's conversation link be MOVED by what its own process says now?
 *
 * A link is not final. The process behind a row can go on to a DIFFERENT conversation (`/new`, an
 * account switch, a `/resume` from inside the CLI), and a row left on the old id shows a chat that
 * stopped while the terminal keeps answering. Rows linked BY the process (`process-log`) or by first
 * sighting always followed. A row linked by an id WE handed the CLI (`assigned-id`, `resumed-id` — a
 * reopen) did not, and that was the AGY.RELINK defect: a reopened agy row stayed on `fbd845b8…` after
 * `/new` while its own managed log said `Created conversation e4da8024…`, across a server restart.
 *
 * The id we handed over is only the conversation the process STARTED on. So it may be moved — but
 * only by a source that is EXCLUSIVE to that row's process, because an assigned id is exact and must
 * never be traded for a guess:
 * - `managed-log`: the log agentop chose per managed id (`--log-file`, agy). Nothing else writes it.
 * - `process-file` for a harness whose file is named by its PATH (codex's rollout/lock, kimi's
 *   session directory): read off the descriptors of the row's OWN holder process, never below it,
 *   behind the holder collision guard.
 * agy's legacy `cli-<second>.log`, read by CONTENT, is named by second and can be shared by two
 * processes (one of them possibly already dead), so it is NOT exclusive and an assigned link stays.
 *
 * A MOVE (never a first link) is additionally refused when it would put two LIVE rows on one
 * conversation, or when two rows' sources name the same new id: neither moves, and the next poll asks
 * again. A retired predecessor sharing an id with its reopened continuation is not live and blocks
 * nothing.
 */
import type { ConversationLinkReason, HarnessId } from '@agentistics/core'
import { HARNESS_PROCESS_TRANSCRIPTS } from './harness-session-file'

export type LinkSource = 'managed-log' | 'process-file'

/** `link`: no link yet, ask. `follow`: linked, a different id from this source moves it. `keep`: never ask. */
export type LinkDecision = 'link' | 'follow' | 'keep'

export interface LinkedRow {
  harness: HarnessId
  conversationId?: string | null
  conversationLinkVia?: ConversationLinkReason
}

/** Is `source` exclusive to one row's process for this harness? */
export function sourceExclusive(harness: HarnessId, source: LinkSource): boolean {
  const spec = HARNESS_PROCESS_TRANSCRIPTS[harness]
  if (!spec) return false
  return source === 'managed-log' ? Boolean(spec.managedLog) : spec.conversation.from === 'path'
}

export function linkDecision(row: LinkedRow, source: LinkSource): LinkDecision {
  const spec = HARNESS_PROCESS_TRANSCRIPTS[row.harness]
  if (!spec || (source === 'managed-log' && !spec.managedLog)) return 'keep'
  if (!row.conversationId) return 'link'
  switch (row.conversationLinkVia) {
    case 'process-log':
    case 'first-sighting':
      return 'follow'
    case 'assigned-id':
    case 'resumed-id':
      return sourceExclusive(row.harness, source) ? 'follow' : 'keep'
    default:
      // `harness-session-file` belongs to a harness with its own record (claude), and a link with no
      // recorded provenance is one nobody can vouch for moving.
      return 'keep'
  }
}

/** conversationId -> the LIVE rows linked to it. Built once per poll. */
export function liveLinks(
  rows: readonly { id: string; conversationId?: string | null }[],
  live: (id: string) => boolean,
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>()
  for (const r of rows) {
    if (!r.conversationId || !live(r.id)) continue
    const list = out.get(r.conversationId)
    if (list) list.push(r.id)
    else out.set(r.conversationId, [r.id])
  }
  return out
}

/**
 * May `rowId` move to `target`? Refused when another live row already drives `target`, or when
 * `rivals` (how many rows' sources name `target` as a NEW id this poll) is more than one.
 */
export function moveAllowed(
  rowId: string,
  target: string,
  links: ReadonlyMap<string, readonly string[]>,
  rivals = 1,
): boolean {
  if (rivals > 1) return false
  return !(links.get(target) ?? []).some(id => id !== rowId)
}
