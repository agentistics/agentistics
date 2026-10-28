/**
 * Pure logic for Settings → Billing's "Add account": which assistants offer it, what a refusal
 * says, and which login roots are still waiting. No IO, so every branch is testable.
 */
import type { HarnessId } from '@agentistics/core'

export type Lang = 'pt' | 'en'

/** Assistants that cannot keep a second login apart (the server's `LOGIN_START` is `null` for them). */
// @harness-adapters-only: a second login is a per-adapter fact (each vendor CLI's own login dir)
export const NO_SECOND_ACCOUNT: ReadonlySet<HarnessId> = new Set<HarnessId>(['antigravity', 'opencode'])

/** A row of `GET /api/accounts/roots`; declared here because the web never imports `packages/server`. */
export interface RootRowView {
  harness: HarnessId
  root: string
  status: 'pending' | 'bound' | 'retired' | 'failed'
  pendingId?: string
  accountId?: string
  login?: LoginInfoView
  label?: string
  plan?: string
  error?: string
}

export interface LoginInfoView { kind: 'paste' | 'device'; url: string; code?: string; expiresAt: number; error?: 'invalid_code' }
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
  login_timeout: { pt: 'O login expirou. Comece de novo para obter outro link e código.', en: 'Sign-in expired. Start again to get a new link and code.' },
  login_failed: { pt: 'O login não foi concluído. Comece de novo.', en: 'Sign-in did not finish. Start again.' },
  plaintext_refused: { pt: 'O cofre de credenciais do sistema está indisponível. O Copilot não conseguiu salvar o login com segurança; salvar o token em texto simples foi recusado.', en: 'The system keychain is unavailable. Copilot could not save the login securely; storing the token in plain text was refused.' },
  invalid_code: { pt: 'O código não foi aceito. Abra o link atual e cole um novo código de autorização.', en: 'The code was not accepted. Open the current link and paste a new authorization code.' },
  root_in_use: { pt: 'Ainda há uma sessão aberta nesta conta. Encerre-a primeiro.', en: 'A session is still running in this account. End it first.' },
  unsupported: { pt: 'Este assistente mantém um só login por computador, então não dá para separar uma segunda conta.', en: 'This assistant keeps a single login per computer, so a second account cannot be kept apart.' },
  unsafe_path: { pt: 'A pasta de contas contém um atalho, então foi deixada como está.', en: 'The accounts folder contains a link, so it was left alone.' },
  login_unavailable: { pt: 'Não foi possível abrir o login deste assistente. Veja se ele está instalado.', en: 'Could not open this assistant\'s sign-in. Check that it is installed.' },
  disabled: { pt: 'Várias contas está desligada neste computador.', en: 'Multiple accounts is turned off on this computer.' },
  unknown_harness: { pt: 'Assistente desconhecido.', en: 'Unknown assistant.' },
  capability_disabled: { pt: 'Este computador não permite iniciar logins por esta tela (o perfil de exposição desliga o acesso local). Abra o agentistics no próprio computador ou ligue o acesso local nas configurações do servidor.', en: 'This computer does not allow starting sign-ins from this screen (its exposure profile turns local access off). Open agentistics on the computer itself, or turn local access on in the server settings.' },
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

export const ADD_COPY = (pt: boolean) => ({
  openLink: pt ? 'Abrir link' : 'Open link',
  copyLink: pt ? 'Copiar link' : 'Copy link',
  copyCode: pt ? 'Copiar código' : 'Copy code',
  copied: pt ? 'Copiado' : 'Copied',
  linkStep: pt ? 'Abra este link e entre com a outra conta' : 'Open this link and sign in with the other account',
  pasteStep: pt ? 'Cole aqui o código que a página mostrar' : 'Paste the code shown by the page here',
  deviceStep: pt ? 'Na página, digite este código' : 'Enter this code on the page',
  kimiStep: pt ? 'O link já leva o código; confira se a página mostra este' : 'The link includes the code; check that the page shows this one',
  submit: pt ? 'Confirmar' : 'Confirm',
  awaitingCode: pt ? 'Cole o código mostrado pela página para continuar.' : 'Paste the code shown by the page to continue.',
  submitted: pt ? 'Esperando você entrar…' : 'Waiting for you to sign in…',
  expires: (minutes: number) => pt ? `O código vale por mais ${minutes} min.` : `The code expires in ${minutes} min.`,
  done: pt ? 'Conta adicionada' : 'Account added',
  doneNote: pt ? 'Ela já aparece na lista de contas. Dê um nome a ela no lápis da linha, se quiser.' : 'It now appears in the accounts list. You can name it with the row’s pencil.',
  finish: pt ? 'Pronto' : 'Done',
  close: pt ? 'Fechar' : 'Close',
  account: pt ? 'Conta' : 'Account',
  plan: pt ? 'Plano' : 'Plan',
  noPlan: pt ? 'Não informado' : 'Not reported',
  add: pt ? 'Adicionar conta' : 'Add account',
  addTo: (label: string) => (pt ? `Adicionar conta do ${label}` : `Add a ${label} account`),
  title: (label: string) => (pt ? `Adicionar uma conta do ${label}` : `Add a ${label} account`),
  confirm: pt ? 'Abrir login' : 'Open login',
  cancel: pt ? 'Agora não' : 'Not now',
  working: pt ? 'Abrindo…' : 'Opening…',
  workingNote: pt ? 'Iniciando o assistente e aguardando o link de login…' : 'Starting the assistant and waiting for its sign-in link…',
  cancelling: pt ? 'Cancelando…' : 'Cancelling…',
  waiting: pt ? 'Aguardando login' : 'Waiting for sign-in',
  openLogin: pt ? 'Abrir login' : 'Open login',
  cancelPending: pt ? 'Cancelar' : 'Cancel',
  noSecond: (labels: string) => (pt ? `${labels}: ainda não permite manter uma segunda conta separada.` : `${labels}: cannot keep a second account apart yet.`),
  flagOff: pt
    ? 'Várias contas é uma função experimental e está desligada neste computador.'
    : 'Multiple accounts is an experimental feature and is turned off on this computer.',
})
