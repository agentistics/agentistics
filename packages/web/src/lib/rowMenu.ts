/**
 * rowMenu.ts — PURE: what the right-click menu on a session row offers.
 *
 * It COMPOSES NOTHING. Every entry is one of the row's own `verbs`, which the server already
 * resolved through the same `sessionActions` the cockpit resolves every keypress against, and
 * which arrive already localized with their `enabled` flag and their `reason`. A second table here
 * would be a second set of rules for one gesture — the defect `task-reopen.ts` exists to have
 * fixed once.
 *
 * A verb the row cannot take stays in the menu, DISABLED, with its reason. A menu that silently
 * loses half its entries reads as a broken feature, and an absence explains nothing — the same
 * call `fleet-row.ts` makes for a verb it refuses.
 *
 * ONE entry is not a server verb: `link-task`. It opens a picker rather than acting, so there is
 * nothing for the server to have resolved — no `enabled`, no `reason`, no refusal sentence. It is
 * passed IN by the caller rather than composed here, so this module still holds no table of its
 * own, and it is always last: the verbs that act on the session come first.
 *
 * "Stop" is two different verbs. On a row that is mid-turn it is `interrupt` (stop what it is
 * doing, keep the session); everywhere else it is `kill` (end it). Offering both would ask the
 * reader to know the difference before they have read the row.
 */

export interface RowVerb {
  action: string
  label: string
  enabled: boolean
  reason?: string
  checked?: boolean
  color?: string
  /** Draws the lucide Pin before the label (the tabs list marks its pinned sessions). */
  pinned?: boolean
  /** Additional session facts, separate from the complete title. */
  detail?: string | undefined
  leader?: boolean
  leaderLabel?: string
  /** A section boundary before this entry, drawn by the shared menu. */
  separatorBefore?: boolean
}

/** Tallest a fixed menu may be, in CSS px. `innerHeight` is ALREADY in CSS px: `zoomGeometry.ts`
 *  divides it by the UI zoom, so compensating here again would double-count the zoom. */
export function menuMaxHeight(innerHeight: number): number {
  return Math.max(120, innerHeight - 8)
}

export type MenuEntry = RowVerb

/** True when an event target belongs to any menu rendered through a body portal. */
export function isInsidePortalledMenu(target: EventTarget | null): boolean {
  return typeof Element !== 'undefined' && target instanceof Element && target.closest('[data-portalled-menu]') !== null
}

/** States where the session is mid-turn, so "stop" means the TURN and not the session. */
const MID_TURN = new Set(['working'])
/** States where nothing is running, so there is nothing to stop — Reopen is the verb that applies.
 *  `lost` is NOT here: a backend still running whose activity could not be read wears it too. */
const ENDED = new Set(['exited', 'closed'])

export function rowMenuEntries(
  verbs: readonly RowVerb[],
  state: string,
  /** Client-side entries appended after the verbs — see the note above. */
  extra: readonly MenuEntry[] = [],
  /** Recorded end / last heartbeat of a backend-confirmed loss; absent on unread live panes. */
  endedAt?: number,
): MenuEntry[] {
  const find = (a: string) => verbs.find(v => v.action === a)
  const stop = ENDED.has(state) || (state === 'lost' && endedAt !== undefined) ? undefined : MID_TURN.has(state) ? find('interrupt') : find('kill')
  // `archive` exists only on a NATIVE row (the server offers it nowhere else). `delete` is deliberately
  // NOT here: it permanently deletes a conversation — it lives in the
  // session's own menu (`SessionActions`), which asks first.
  // `forget` only hides a row; its caller asks through ConfirmModal before acting.
  const fleet = [find('rename'), stop, find('resume'), find('archive'), find('forget')].filter((v): v is RowVerb => v !== undefined)
  return [...fleet, ...extra]
}

/** Opens the filing dialog (`SessionFiling`) — both to file a session and to move a filed one. */
export const LINK_TASK = 'link-task'
/** Unfiles a session from its task directly, without opening the dialog. */
export const UNLINK_TASK = 'unlink-task'

/**
 * The row menu's task entries — CLIENT-SIDE, like the group ones: they open `SessionFiling` (the
 * one dialog that files, moves and unfiles) or call its own `detachSession`, so there is no server
 * verb to have resolved. `task` is the delivery NAME the fleet row carries.
 *
 * Unfiled: one entry, "File under a task…". Filed: the current task is NAMED in the menu (an
 * entry that opens it), then Move and Unfile — a menu that said only "File under a task…" over a
 * session that already has one would hide where it is.
 */
export function taskMenuEntries(task: string | undefined, pt: boolean): MenuEntry[] {
  if (!task) {
    return [{ action: LINK_TASK, label: pt ? 'Vincular a uma tarefa…' : 'File under a task…', enabled: true }]
  }
  return [
    { action: LINK_TASK, label: pt ? `Tarefa: ${task}` : `Task: ${task}`, enabled: true },
    { action: LINK_TASK, label: pt ? 'Mover…' : 'Move…', enabled: true },
    { action: UNLINK_TASK, label: pt ? 'Desvincular' : 'Unlink', enabled: true },
  ]
}

/** The client-side entries of the Nay dock's row menu. */
export const NAY_GO_TO = '__nay_go_to__'
export const NAY_COPY_ID = '__nay_copy_id__'

/**
 * The Nay dock's "⋮" on one conversation row: Rename; End, or Reopen once it has ended; Go to the
 * session in the Sessions workspace; Copy the conversation id. No delete — a Nay conversation is
 * never removed from the list from here.
 *
 * Like `rowMenuEntries`, the session verbs are the row's OWN server verbs (`rename`, `kill`,
 * `resume`), passed through with their label, `enabled` and `reason` untouched — so End and Rename
 * are the fleet's very verbs (`rename.ts` renames inside the harness too). The one difference from
 * the aside's menu is deliberate: a Nay row mid-turn still offers END (`kill`), never `interrupt`,
 * because what this list asks about is the conversation, not its current turn. A verb the server
 * did not send is left out rather than invented.
 */
export function nayRowMenuEntries(
  verbs: readonly RowVerb[],
  o: { running: boolean; conversationId: string | undefined; pt: boolean; task?: string | undefined },
): MenuEntry[] {
  const find = (a: string) => verbs.find(v => v.action === a)
  const session = [find('rename'), o.running ? find('kill') : find('resume')]
    .filter((v): v is RowVerb => v !== undefined)
  return [
    ...session,
    ...taskMenuEntries(o.task, o.pt),
    { action: NAY_GO_TO, label: o.pt ? 'Ir para a sessão' : 'Go to session', enabled: true },
    o.conversationId
      ? { action: NAY_COPY_ID, label: o.pt ? 'Copiar id da conversa' : 'Copy conversation id', enabled: true }
      : {
        action: NAY_COPY_ID, label: o.pt ? 'Copiar id da conversa' : 'Copy conversation id', enabled: false,
        reason: o.pt ? 'Esta sessão ainda não tem uma conversa vinculada.' : 'This session has no linked conversation yet.',
      },
  ]
}
