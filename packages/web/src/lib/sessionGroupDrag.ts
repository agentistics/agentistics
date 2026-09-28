/**
 * sessionGroupDrag.ts — PURE: what dropping one user folder onto another DOES, in the aside.
 *
 * Two different gestures land on the exact same target (another folder's row), and they must never
 * be confused with each other:
 *
 *  - Dragging the folder's GRIP (the ⋮⋮ handle at its left) only ever REPOSITIONS it among its
 *    siblings — the drop draws an insertion line between folders, never lights up a folder whole.
 *  - Dragging anywhere else on the folder's own BODY (its name, its row) NESTS it inside the
 *    target — the target lights up whole (orange when the move is allowed, red when the one-level
 *    rule would refuse it), and dropping on a red target shows the warning instead of applying it.
 *
 * WHICH of the two a given drag is is decided once, at `dragstart`, by which element was grabbed —
 * never guessed from pixel position later, which is why `SessionsAside.tsx` calls this with an
 * explicit `GroupDragHandle` it already knows. This module is what maps "which handle" plus "would
 * the one-level rule allow it" onto a single, exhaustive outcome the caller renders and acts on
 * without re-deriving any of the nesting rule itself — that stays in `@agentistics/core`'s
 * `canNestGroup`, the one place a session groups store can be read from at all.
 */

import { canNestGroup, type NestRefusal, type SessionUserGroupsValue } from '@agentistics/core'

/** Which element on the folder's row started the drag. */
export type GroupDragHandle = 'grip' | 'body'

export type GroupDropOutcome =
  /** The grip was dragged: reorder the top-level list. Never a nest, whatever the target is. */
  | { action: 'reorder' }
  /** The body was dragged onto a DIFFERENT folder that can legally hold it. */
  | { action: 'nest'; ok: true }
  /** The body was dragged onto a different folder, but the one-level rule refuses it — show the
   *  reason as a warning, never apply it and never fail silently. */
  | { action: 'nest'; ok: false; code: NestRefusal }
  /** Dragging a folder onto itself. Neither gesture does anything to it — no highlight, no drop. */
  | { action: 'none' }

/**
 * PURE: decide what dropping `dragId` onto `targetId` does, given which handle started the drag.
 * Total — an unknown id resolves through `canNestGroup`'s own `no_such_group` refusal rather than
 * throwing, since a stale drag payload (the source row vanished mid-drag) must read as "can't", not
 * crash the aside.
 */
export function groupDropOutcome(
  groups: SessionUserGroupsValue,
  handle: GroupDragHandle,
  dragId: string,
  targetId: string,
): GroupDropOutcome {
  if (dragId === targetId) return { action: 'none' }
  if (handle === 'grip') return { action: 'reorder' }
  const check = canNestGroup(groups, dragId, targetId)
  return check.ok ? { action: 'nest', ok: true } : { action: 'nest', ok: false, code: check.code }
}
