/**
 * THE PHONE'S SESSION PANEL — the two facts about it that are rules rather than layout.
 *
 * The phone's session header is one icon and the title. Everything that used to crowd it (the
 * inbox, the context figure, the limits, the links, the task, the verbs, the view switch) lives in
 * a panel that slides in from the left (`components/Drawer.tsx`, `side="left"`).
 */

/** Marks the history entry that opening the panel pushes, so the system Back closes the panel
 *  before it leaves the session. */
export const SESSION_DRAWER_STATE = 'agSessionDrawer'

/**
 * THE DOT ON THE PANEL ICON — something behind it wants you: the session is waiting on a person
 * (a dialog or a question, `waiting-approval`), or the inbox has something unread. Plain `waiting`
 * is where every turn ends, and a dot on it would be a dot on every session, always.
 */
export function sessionDrawerDot({ state, unread }: { state: string | undefined; unread: number }): boolean {
  return state === 'waiting-approval' || unread > 0
}

/** Whether the top history entry is the one the panel pushed. */
export function drawerEntryOnTop(state: unknown): boolean {
  return typeof state === 'object' && state !== null
    && (state as Record<string, unknown>)[SESSION_DRAWER_STATE] === true
}
