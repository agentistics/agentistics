/**
 * notifications-authority.ts — PURE: is a notification's SUBJECT visible to a principal?
 *
 * On a central, "everything reaches every authenticated account" was the whole rule until now: a
 * plain user could see notifications about machines that were not theirs and teams they did not
 * belong to. This module gives a notification a SUBJECT — what it is about — and answers, from the
 * principal's role and memberships alone, whether that subject is theirs to know about:
 *
 *  - owner        → everything.
 *  - manager      → subjects belonging to the teams they manage (those teams' machines, those
 *                    teams' members, and — through plain membership — the teams themselves).
 *  - plain user   → their own machines, and the teams they belong to.
 *
 * REUSE, NOT A SECOND ANSWER. Each subject kind is checked with the exact same authority that
 * already gates the corresponding surface, so "may this principal see a notification about X" can
 * never quietly drift from "may this principal manage X":
 *  - `team`    → `teamVisibleTo`    (iam-view.ts)  — the same check that scopes the team list.
 *  - `machine` → `canManageMachine` (iam-view.ts)  — the same check the machine-admin routes use.
 *  - `account` → `accountVisibleTo` (iam-view.ts)  — the same check the accounts panel uses.
 *
 * A `tag` kind was drafted alongside these three but deliberately left OUT: nothing in the product
 * emits a tag-scoped notification yet, and a kind with no reachable `true` case is dead code
 * wearing a test. Add it back — plus the `readableTagIds` the caller would resolve via
 * `tags-authority.ts`'s `canReadTag` — the day an emitter needs it, not before.
 *
 * NO SUBJECT ≠ AUTOMATICALLY GLOBAL. A notification about the instance itself (an update banner)
 * carries no subject and should reach every authenticated account, owner or not. But "no subject"
 * is also what a FORGOTTEN one looks like, and those two cases must not be the same code path:
 * `INSTANCE_WIDE_CODES` is the explicit, closed list of codes allowed to skip subject scoping —
 * mirroring `AUTH_PUBLIC` in `index-routes.ts` (a route not listed there is authenticated by
 * default; a code not listed here is not instance-wide by default). A subjectless notification
 * whose code is NOT on the list is denied to non-owners, exactly like an unresolved subject —
 * silently reaching everyone was the "route not registered is assumed harmless" mistake
 * CLAUDE.md's `capability-guard.ts` rule calls out, applied to this surface.
 *
 * FAIL CLOSED. A subject this module cannot resolve — an id absent from the context the caller
 * built, or a kind it does not recognise — is denied to anyone but the owner. A missed
 * notification is an annoyance; a leaked one is the bug this module exists to prevent.
 */
import type { AccountDoc, Membership, Principal } from './iam-types'
import { teamVisibleTo, canManageMachine, accountVisibleTo } from './iam-view'

export type NotificationSubjectKind = 'machine' | 'team' | 'account'

/** What a notification is about. Set by the emitter; absent means "no single target" — see
 *  `INSTANCE_WIDE_CODES` for who then receives it. */
export interface NotificationSubject {
  kind: NotificationSubjectKind
  id: string
}

/**
 * The closed list of codes allowed to reach every authenticated account with NO subject at all.
 * A code not on this list, emitted with no subject, is denied to non-owners rather than silently
 * reaching everyone — see the module doc. Keep this list and its own test
 * (`notifications-authority.test.ts`) in sync the way `authz-gate.test.ts` pins `AUTH_PUBLIC`.
 */
export const INSTANCE_WIDE_CODES: ReadonlySet<string> = new Set([
  // The dashboard/central binary itself is out of date — a fact about the instance, not about any
  // one team, machine or account.
  'app.update_available',
])

/** Structural subset of a machine record — exactly what `canManageMachine` needs, kept minimal so
 *  this module (and its tests) depend on no Mongo type. */
export interface SubjectMachine {
  teamId?: string
  teamIds?: string[]
  accountId?: string
  accountIds?: string[]
}

/**
 * Everything the caller must resolve from the DB ONCE PER REQUEST before asking — never per
 * notification, and never re-derived here. Absence of an id from these maps is a legitimate,
 * expected state (a machine or account that no longer exists) and resolves to "denied", not to an
 * error.
 */
export interface NotificationAuthorityContext {
  /** machineId (memberId / token hash) → its team(s) and owner-account(s). */
  machines: Record<string, SubjectMachine>
  /** accountId → that account's memberships, for `accountVisibleTo` (which needs the TARGET's
   *  memberships, not the caller's). */
  accountMemberships: Record<string, Membership[]>
}

/**
 * Pure: may `p` receive a notification with this `subject` and `code`?
 *
 * `code` is only consulted when `subject` is absent, to check it against `INSTANCE_WIDE_CODES` —
 * a notification that DOES carry a subject is scoped by the subject alone, regardless of its code.
 */
export function subjectVisibleTo(
  p: Principal,
  subject: NotificationSubject | undefined,
  ctx: NotificationAuthorityContext,
  code?: string,
): boolean {
  if (p.role === 'owner') return true
  if (!subject) return code !== undefined && INSTANCE_WIDE_CODES.has(code)
  switch (subject.kind) {
    case 'team':
      return teamVisibleTo(p, subject.id)
    case 'machine': {
      const machine = ctx.machines[subject.id]
      if (!machine) return false // unresolved subject — fail closed
      return canManageMachine(p, machine)
    }
    case 'account': {
      if (subject.id === p.accountId) return true
      const memberships = ctx.accountMemberships[subject.id]
      if (!memberships) return false // unresolved subject — fail closed
      return accountVisibleTo(p, { _id: subject.id, memberships } as AccountDoc)
    }
    default:
      return false // unrecognized kind — fail closed
  }
}
