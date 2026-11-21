/**
 * S10 r3 — what `index.ts` asks at each door of the person's own browser, as functions it can be TESTED through
 * (the two survivors of the r2 QA were `index.ts` lines no test could reach). The door passes the request, the
 * parsed owner, the socket's verdict and the vault's language; the answer is the refusal to send, or null.
 */
import type { CallerVerdict } from './browser-caller'
import {
  PERSONAL_GRANT_HEADER, PERSONAL_GRANT_PROTOCOL, personalDoorRefusal, personalGrantFromProtocols, personalGrants, personalRefusalBody,
  type PersonalDoorRefusal,
} from './personal-grant'

export type StreamOwner = { kind: 'personal' } | { kind: 'session'; managedId: string }

/** The grant a request carries: the header (POSTs, status, the mux replay), never a URL. */
export function grantOfRequest(req: { headers: { get(name: string): string | null } }): string | null {
  return req.headers.get(PERSONAL_GRANT_HEADER)
}

/** Does THIS request carry a valid grant for the HTTP session `session`? */
export function requestHasPersonalGrant(req: { headers: { get(name: string): string | null } }, session: string, nowMs: number = Date.now()): boolean {
  return personalGrants().check(grantOfRequest(req), session, nowMs)
}

export interface DoorAnswer { status: number; body: ReturnType<typeof personalRefusalBody> }

/** The stream door (`GET /api/browser/stream`): only the personal owner needs the grant; a session's own stream is read as before. */
export function streamDoor(i: { owner: StreamOwner; req: { headers: { get(name: string): string | null } }; session: string; caller: () => Promise<CallerVerdict> | CallerVerdict; lang: 'en' | 'pt'; nowMs?: number }): Promise<DoorAnswer | null> {
  return personalOwnerDoor(i, grantOfRequest(i.req))
}

/** The input socket's door (`WS /api/browser/input`): the grant rides `Sec-WebSocket-Protocol`. */
export function inputDoor(i: { owner: StreamOwner; req: { headers: { get(name: string): string | null } }; session: string; caller: () => Promise<CallerVerdict> | CallerVerdict; lang: 'en' | 'pt'; nowMs?: number }): Promise<DoorAnswer | null> {
  return personalOwnerDoor(i, personalGrantFromProtocols(i.req.headers.get('sec-websocket-protocol')))
}

async function personalOwnerDoor(i: { owner: StreamOwner; session: string; caller: () => Promise<CallerVerdict> | CallerVerdict; lang: 'en' | 'pt'; nowMs?: number }, grant: string | null): Promise<DoorAnswer | null> {
  if (i.owner.kind !== 'personal') return null
  const grantOk = personalGrants().check(grant, i.session, i.nowMs)
  const refused: PersonalDoorRefusal | null = personalDoorRefusal({ grantOk, caller: grantOk ? await i.caller() : { kind: 'unknown', reason: 'no-peer' }, lang: i.lang })
  return refused ? { status: refused.status, body: personalRefusalBody(refused) } : null
}

/** The sub-protocol an accepted input socket answers with (the browser requires the server to pick one it offered). */
export const INPUT_ACCEPT_PROTOCOL = PERSONAL_GRANT_PROTOCOL
