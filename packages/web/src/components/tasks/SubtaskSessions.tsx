/**
 * SubtaskSessions — the sessions filed under one subtask, wherever a subtask is drawn.
 *
 * **A subtask holds ANY NUMBER of sessions.** That is new — the cell it replaces was
 * `Subtask.sessionId`, ONE session written straight onto the subtask record, which could not
 * express the ordinary case (a piece of work picked up again the next morning is a second session
 * on the same subtask) and was a second place the link lived: the server's `task-attach.ts` decides
 * where a session is filed, and a field on the other record was a rule nothing enforced. So this
 * reads the SESSIONS and asks which subtask each names, never the other way round. (A session may
 * also be filed on the delivery directly, under no subtask at all — see `task-attach.ts` and
 * docs/superpowers/specs/2026-09-10-task-session-hierarchy-design.md §4.1; that branch is drawn
 * elsewhere, not by this component.)
 *
 * `Subtask.sessionId` still exists on records written before this and is deliberately NOT read
 * here. It is not evidence: `TaskSessionRow.subtaskId` is what every rollup, every filter and the
 * server's own invariant are written against, and rendering a second, unreconciled source beside it
 * would put a session in a subtask the delivery's own arithmetic does not have it in.
 *
 * It is a plain function rather than a component so the two tables that call it keep their cells
 * inline in their own `<td>` — same reason `restrictionMiniTable` is one.
 */

import { Terminal } from 'lucide-react'
import { SessionRef } from './SessionRef'
import type { Lang } from './copy'
import type { TaskSessionRow } from '../../lib/tasks'

export interface SubtaskSessionsProps {
  /**
   * The ids whose filed sessions should show here — every real caller passes exactly `[id]` today
   * (a plain subtask's own id, or a §F GROUP's own id). This used to be "the subtask's id plus
   * every sibling sharing its `groupId`" under §B's shared-bucket model (docs/superpowers/specs/
   * 2026-09-11-alm-session-linking-ux.md §B.4), where a session filed under ANY member showed on
   * every sibling's chip list. §F (same doc, §F.1) SUPERSEDED that: a group MEMBER can never hold a
   * session of its own (`task-attach.ts`'s `subtask_in_group` refusal), so there is no longer a
   * union of members to compute — a group's chip list is just the sessions filed on the group's own
   * id, exactly like a loose subtask. The field stays an array rather than a bare id because a
   * caller passing one id and a caller passing several cost this component nothing to tell apart.
   */
  subtaskIds: readonly string[]
  /** Where a NEW session gets filed — this row's own id, never a sibling's. */
  subtaskId: string
  /** The DELIVERY's sessions — every one of them. This filters to the ones filed here. */
  sessions: readonly TaskSessionRow[]
  lang: Lang
  /** Offer this subtask a session. */
  onLink: (subtaskId: string) => void
  /** Take one out of it. */
  onUnfile: (sessionId: string) => void
  /** Open the session's own screen. Absent renders labels instead of controls. */
  onOpen?: (sessionId: string) => void
  mobile?: boolean
}

export function subtaskSessions(p: SubtaskSessionsProps): React.ReactNode {
  const mine = p.sessions.filter(s => s.subtaskId && p.subtaskIds.includes(s.subtaskId))
  const pt = p.lang === 'pt'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', minWidth: 0 }}>
      {mine.map(s => (
        <SessionRef
          key={s.id}
          id={s.id}
          title={s.label}
          harness={s.harness}
          lang={p.lang}
          onOpen={p.onOpen}
          onUnfile={p.onUnfile}
        />
      ))}
      <button
        onClick={() => p.onLink(p.subtaskId)}
        title={pt ? 'Filiar uma sessão a esta subtarefa' : 'File a session under this subtask'}
        style={{
          background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5,
          minHeight: p.mobile ? 44 : undefined, padding: 0,
        }}
      >
        <Terminal size={12} />
        {/* The verb only says "another" once there IS one — a first link and a second are the
            same gesture, and a cell that says `+ another` over an empty one reads as a fault. */}
        {mine.length === 0 ? (pt ? 'filiar' : 'link') : (pt ? 'mais uma' : 'another')}
      </button>
    </span>
  )
}
