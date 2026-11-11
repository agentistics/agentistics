/**
 * notifications-context.ts — builds the (impure) `NotificationAuthorityContext` a request needs
 * to scope its notification history, ONCE per request. `notifications-authority.ts` stays pure and
 * knows nothing about Mongo; this is the one place that fetches the machines/accounts it reads.
 *
 * There is no `tag` subject support here — `notifications-authority.ts` deliberately does not
 * model one yet (see its module doc). Wiring one up, the day an emitter needs it, is: fetch the
 * visible tags via `tags-store.ts` + `tags-authority.ts`'s `canReadTag` for the principal, same as
 * `tags-handlers.ts` already does for GET /api/tags.
 */
import type { NotificationAuthorityContext, SubjectMachine } from './notifications-authority'
import type { Membership } from './iam-types'

export async function buildNotificationAuthorityContext(): Promise<NotificationAuthorityContext> {
  const [{ listMachines }, { listAccounts }] = await Promise.all([
    import('./team-tokens'),
    import('./accounts'),
  ])
  const [machineList, accountList] = await Promise.all([listMachines(), listAccounts()])

  const machines: Record<string, SubjectMachine> = {}
  for (const m of machineList) {
    machines[m.id] = { teamId: m.teamId, teamIds: m.teamIds, accountId: m.accountId, accountIds: m.accountIds }
  }

  const accountMemberships: Record<string, Membership[]> = {}
  for (const a of accountList) accountMemberships[a._id] = a.memberships

  return { machines, accountMemberships }
}
