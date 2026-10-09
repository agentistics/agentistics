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
export async function buildNotificationAuthorityContext(): Promise<NotificationAuthorityContext> {
  return { machines: {}, accountMemberships: {} }
}
