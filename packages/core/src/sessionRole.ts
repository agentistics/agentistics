/**
 * sessionRole.ts — PURE. What a session's ROLE is and how it shows in the session's title.
 *
 * The role is stored by the server (`server/sessions/session-roles.ts`); this module holds the words
 * and the title arithmetic so the web, the MCP door and the spawn briefing cannot disagree. A leader
 * wears a title prefix ("[ LEADER ] - …" / "[ LÍDER ] - …"); a worker or an automatic session wears none.
 */

export type SessionRole = 'leader' | 'worker'
/** What a caller may ask for: `auto` clears the stored role. */
export type SessionRoleRequest = SessionRole | 'auto'
export type RoleLang = 'en' | 'pt'

/**
 * Who set a stored role: the person (`manual`, also what an entry with no origin means), the session
 * itself (`auto`), or a leader session that set it for a child (`{ leader: <managed session id> }`).
 */
export type RoleOrigin = 'manual' | 'auto' | { leader: string }

export function parseRoleOrigin(v: unknown): RoleOrigin | undefined {
  if (v === 'manual' || v === 'auto') return v
  if (v && typeof v === 'object' && typeof (v as { leader?: unknown }).leader === 'string' && (v as { leader: string }).leader !== '') {
    return { leader: (v as { leader: string }).leader }
  }
  return undefined
}

export const isSessionRole = (v: unknown): v is SessionRole => v === 'leader' || v === 'worker'
export const isSessionRoleRequest = (v: unknown): v is SessionRoleRequest => isSessionRole(v) || v === 'auto'

/** Either language's prefix, with or without accent, whatever the spacing — what a rename by hand leaves. */
const PREFIX_RE = /^\s*\[\s*(?:LEADER|L[ÍI]DER)\s*\]\s*(?:[-–—:]\s*)?/i

export const rolePrefix = (lang: RoleLang): string => (lang === 'pt' ? '[ LÍDER ] - ' : '[ LEADER ] - ')

/** The title without any leader prefix (every spelling, repeated ones included). */
export function stripRolePrefix(title: string): string {
  let t = title
  for (let i = 0; i < 4 && PREFIX_RE.test(t); i++) t = t.replace(PREFIX_RE, '')
  return t.trim()
}

export const hasRolePrefix = (title: string): boolean => PREFIX_RE.test(title)

/** The title a session should carry for `role`. Idempotent: applying it twice changes nothing. */
export function titleForRole(title: string, role: SessionRole | null | undefined, lang: RoleLang): string {
  const base = stripRolePrefix(title)
  if (role !== 'leader') return base
  return base === '' ? rolePrefix(lang).trimEnd().replace(/\s*-$/, '') : `${rolePrefix(lang)}${base}`
}

/** The one-line statement of a role — what the briefing prints and what the change note quotes. */
export function roleLine(role: SessionRole | null | undefined): string {
  if (role === 'leader') {
    return 'Your role here: LEADER. You organise: break the request into Agentask tasks/subtasks, propose which sessions to open (harness + model each), follow them, have each delivery QA\'d by a different model, and report to the user; do not implement big pieces yourself.'
  }
  if (role === 'worker') {
    return 'Your role here: WORKER. You implement one defined piece, test it, commit, and report to whoever started you (agentistics_session_message, kind handback); do not orchestrate other sessions.'
  }
  return 'Your role here: decide from the request. LEADER organises: break the request into Agentask tasks/subtasks, propose which sessions to open (harness + model each), follow them, have each delivery QA\'d by a different model, and report to the user; do not implement big pieces yourself. WORKER implements one defined piece, tests, commits, and reports to whoever started it. AUTO: one piece → worker; several fronts → leader; you may become leader if the work grows. Once you decide, record it by calling agentistics_session_role with role "worker" or role "leader" (the leader call also renames you); call it again if you change your mind.'
}

/** The background note delivered into a session whose role just changed. */
export function roleChangeNote(role: SessionRole | null): string {
  return `[agentistics] your role is now ${role ? role.toUpperCase() : 'AUTO'} — ${roleLine(role)}`
}
