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

/** The body the CLI's switch sends (`PUT /api/experimental`): the master experimental switch. */
export const TURN_ON_BODY = { enabled: true } as const

/** Is `multi-account` on in a `GET/PUT /api/experimental` report? Anything unreadable reads as off. */
export function multiAccountOn(report: unknown): boolean {
  const f = report && typeof report === 'object' ? (report as { features?: unknown }).features : undefined
  return Array.isArray(f) && f.some(x => x && typeof x === 'object' && (x as { id?: unknown }).id === 'multi-account' && (x as { on?: unknown }).on === true)
}

/** The server's sentence when it sent one; a fixed one otherwise (that route only answers a code). */
export function turnOnErrorText(body: unknown, pt: boolean): string {
  const msg = body && typeof body === 'object' ? (body as { message?: unknown }).message : undefined
  if (typeof msg === 'string' && msg.trim()) return msg
  return pt ? 'Não foi possível ligar as várias contas. Tente de novo.' : 'Could not turn on multiple accounts. Try again.'
}

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
  turnOn: pt ? 'Ligar várias contas' : 'Turn on multiple accounts',
  turnOnTitle: pt ? 'Ligar várias contas?' : 'Turn on multiple accounts?',
  turnOnMessage: pt
    ? 'Isso liga os recursos experimentais do app, entre eles o de manter mais de uma conta do mesmo assistente. Nada é apagado e você pode desligar depois, em Configurações. Os botões de adicionar conta aparecem aqui em seguida.'
    : 'This turns on the app\'s experimental features, including keeping more than one account of the same assistant. Nothing is deleted and you can turn it off later in Settings. The add-account buttons appear here right after.',
  turnOnConfirm: pt ? 'Ligar' : 'Turn on',
  stillOff: pt ? 'Ligado, mas uma configuração desta máquina mantém as várias contas desligadas.' : 'Turned on, but a setting on this machine keeps multiple accounts off.',
  flagOff: pt
    ? 'Para adicionar uma segunda conta, ligue as várias contas.'
    : 'To add a second account, turn on multiple accounts.',
})
