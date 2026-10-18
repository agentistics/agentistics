/**
 * Pure logic for Settings → Billing's "Add account": which assistants offer it, what a refusal
 * says, and which login roots are still waiting. No IO, so every branch is testable.
 */
import type { HarnessId } from '@agentistics/core'

export type Lang = 'pt' | 'en'

/** Assistants that cannot keep a second login apart (the server's `LOGIN_START` is `null` for them). */
export const NO_SECOND_ACCOUNT: ReadonlySet<HarnessId> = new Set<HarnessId>(['antigravity', 'opencode'])

/** A row of `GET /api/accounts/roots`; declared here because the web never imports `packages/server`. */
export interface RootRowView {
  harness: HarnessId
  root: string
  status: 'pending' | 'bound' | 'retired'
  pendingId?: string
  accountId?: string
  loginSessionId?: string
}

export type AddView =
  | { kind: 'off' }
  | { kind: 'on'; addable: HarnessId[]; unsupported: HarnessId[] }

/** Flag off → no button at all (just the pointer line); on → split the listed assistants by support. */
export function addAccountView(flagOn: boolean, harnesses: readonly HarnessId[]): AddView {
  if (!flagOn) return { kind: 'off' }
  return {
    kind: 'on',
    addable: harnesses.filter(h => !NO_SECOND_ACCOUNT.has(h)),
    unsupported: harnesses.filter(h => NO_SECOND_ACCOUNT.has(h)),
  }
}

export const pendingRoots = (roots: readonly RootRowView[]): RootRowView[] => roots.filter(r => r.status === 'pending')

/** True when a root that was pending is no longer pending: the account list should be re-read. */
export function anyResolved(before: readonly RootRowView[], after: readonly RootRowView[]): boolean {
  const still = new Set(pendingRoots(after).map(r => r.pendingId))
  return pendingRoots(before).some(r => !still.has(r.pendingId))
}

/** The server's own sentence, never a raw code; a fixed fallback when it sent none. */
export function addErrorText(body: unknown, pt: boolean): string {
  const msg = body && typeof body === 'object' ? (body as { message?: unknown }).message : undefined
  if (typeof msg === 'string' && msg.trim()) return msg
  return pt ? 'Não foi possível iniciar o login desta conta. Tente de novo.' : 'Could not start signing in to this account. Try again.'
}

/** Whether the pending row can open its login session. */
export const loginTarget = (r: RootRowView): string | null =>
  r.loginSessionId ? `/sessions/${encodeURIComponent(r.loginSessionId)}` : null

export const ADD_COPY = (pt: boolean) => ({
  add: pt ? 'Adicionar conta' : 'Add account',
  addTo: (label: string) => (pt ? `Adicionar conta · ${label}` : `Add account · ${label}`),
  title: (label: string) => (pt ? `Adicionar uma conta do ${label}` : `Add a ${label} account`),
  message: (label: string) => (pt
    ? `Vamos abrir uma sessão de login do ${label}. Entre com a outra conta no Terminal dessa sessão. Quando terminar, a conta aparece aqui sozinha.`
    : `We will open a ${label} login session. Sign in with the other account in that session's Terminal tab. When you finish, the account shows up here by itself.`),
  confirm: pt ? 'Abrir login' : 'Open login',
  cancel: pt ? 'Agora não' : 'Not now',
  working: pt ? 'Abrindo…' : 'Opening…',
  waiting: pt ? 'Aguardando login' : 'Waiting for sign-in',
  openLogin: pt ? 'Abrir login' : 'Open sign-in',
  cancelPending: pt ? 'Cancelar' : 'Cancel',
  noSecond: (labels: string) => (pt ? `${labels}: ainda não permite manter uma segunda conta separada.` : `${labels}: cannot keep a second account apart yet.`),
  flagOff: pt
    ? 'Para adicionar uma segunda conta, ligue “várias contas” em Configurações → Experimental.'
    : 'To add a second account, turn on “several accounts” in Settings → Experimental.',
})
