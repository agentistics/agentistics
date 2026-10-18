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

/** Refusal codes of `POST/DELETE /api/accounts/roots`, in the user's language; the server sentence is the en fallback. */
const REFUSALS: Record<string, { pt: string; en: string }> = {
  root_in_use: { pt: 'Ainda há uma sessão aberta nesta conta. Encerre-a primeiro.', en: 'A session is still running in this account. End it first.' },
  unsupported: { pt: 'Este assistente mantém um só login por computador, então não dá para separar uma segunda conta.', en: 'This assistant keeps a single login per computer, so a second account cannot be kept apart.' },
  unsafe_path: { pt: 'A pasta de contas contém um atalho, então foi deixada como está.', en: 'The accounts folder contains a link, so it was left alone.' },
  login_unavailable: { pt: 'Não foi possível abrir o login deste assistente. Veja se ele está instalado.', en: 'Could not open this assistant\'s sign-in. Check that it is installed.' },
  disabled: { pt: 'Várias contas está desligada neste computador.', en: 'Multiple accounts is turned off on this computer.' },
  unknown_harness: { pt: 'Assistente desconhecido.', en: 'Unknown assistant.' },
  not_found: { pt: 'Esta conta já não existe.', en: 'This account no longer exists.' },
}

/** A refusal in the user's language by its code, never the raw code; the server sentence in English; then a fixed fallback. */
export function addErrorText(body: unknown, pt: boolean): string {
  const obj = body && typeof body === 'object' ? (body as { message?: unknown; error?: unknown }) : undefined
  const known = typeof obj?.error === 'string' ? REFUSALS[obj.error] : undefined
  if (known) return pt ? known.pt : known.en
  const msg = obj?.message
  if (!pt && typeof msg === 'string' && msg.trim()) return msg
  return pt ? 'Não foi possível concluir. Tente de novo.' : 'Could not complete this. Try again.'
}

/** Whether the pending row can open its login session. */
export const loginTarget = (r: RootRowView): string | null =>
  r.loginSessionId ? `/sessions/${encodeURIComponent(r.loginSessionId)}?view=terminal` : null

export const ADD_COPY = (pt: boolean) => ({
  add: pt ? 'Adicionar conta' : 'Add account',
  addTo: (label: string) => (pt ? `Adicionar conta do ${label}` : `Add a ${label} account`),
  title: (label: string) => (pt ? `Adicionar uma conta do ${label}` : `Add a ${label} account`),
  message: (label: string) => (pt
    ? `Vamos abrir uma sessão de login do ${label}. Entre com a outra conta no Terminal dessa sessão. Quando terminar, a conta aparece aqui sozinha.`
    : `We will open a ${label} login session. Sign in with the other account in that session's Terminal tab. When you finish, the account shows up here by itself.`),
  confirm: pt ? 'Abrir login' : 'Open login',
  cancel: pt ? 'Agora não' : 'Not now',
  working: pt ? 'Abrindo…' : 'Opening…',
  workingNote: pt ? 'Abrindo a sessão de login — leva alguns segundos.' : 'Opening the sign-in session — this takes a few seconds.',
  cancelling: pt ? 'Cancelando…' : 'Cancelling…',
  waiting: pt ? 'Aguardando login' : 'Waiting for sign-in',
  openLogin: pt ? 'Abrir login' : 'Open login',
  cancelPending: pt ? 'Cancelar' : 'Cancel',
  noSecond: (labels: string) => (pt ? `${labels}: ainda não permite manter uma segunda conta separada.` : `${labels}: cannot keep a second account apart yet.`),
  flagOff: pt
    ? 'Várias contas é uma função experimental e está desligada neste computador.'
    : 'Multiple accounts is an experimental feature and is turned off on this computer.',
})
