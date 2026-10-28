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
  /** What the assistant's CLI said when the attempt failed (masked by the server: no code, no link). */
  detail?: string
  /** Pending, but no sign-in process is behind it any more (server restarted): only "start again" works. */
  stale?: boolean
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

/** What a pending card can still do: continue a live sign-in, or only start again. */
export function pendingCardState(row: RootRowView): 'live' | 'expired' {
  return row.login && !row.stale ? 'live' : 'expired'
}

/**
 * Refusals that mean "this sign-in attempt is over" — the folder is gone, timed out or failed. Each
 * becomes the expired state with a "Try again" that starts a NEW login, never a loose sentence.
 */
const OVER = new Set(['not_found', 'login_timeout', 'login_failed', 'keychain_unreadable', 'login_not_saved'])
export const attemptIsOver = (code: string | undefined | null): boolean => !!code && OVER.has(code)
export const refusalCode = (body: unknown): string | undefined => {
  const e = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
  return typeof e === 'string' ? e : undefined
}
/** Cancelling a sign-in that the server already dropped is a success: there is nothing left to cancel. */
export const alreadyGone = (body: unknown): boolean => refusalCode(body) === 'not_found'

/** Refusal codes of `POST/DELETE /api/accounts/roots`, in the user's language; the server sentence is the en fallback. */
const REFUSALS: Record<string, { pt: string; en: string }> = {
  login_timeout: { pt: 'O login expirou. Comece de novo para obter outro link e código.', en: 'Sign-in expired. Start again to get a new link and code.' },
  login_failed: { pt: 'O login não foi concluído. Comece de novo.', en: 'Sign-in did not finish. Start again.' },
  plaintext_refused: { pt: 'O cofre de credenciais do sistema está indisponível. O Copilot não conseguiu salvar o login com segurança; salvar o token em texto simples foi recusado.', en: 'The system keychain is unavailable. Copilot could not save the login securely; storing the token in plain text was refused.' },
  invalid_code: { pt: 'O código não foi aceito. Abra o link atual e cole um novo código de autorização.', en: 'The code was not accepted. Open the current link and paste a new authorization code.' },
  keychain_unreadable: { pt: 'O macOS não deixou o agentistics ler o login do Claude que acabou de ser salvo. Abra o Acesso às Chaves, procure o item “Claude Code-credentials” desta conta e permita o acesso — ou entre de novo e escolha “Permitir sempre” quando o macOS perguntar.', en: 'macOS did not let agentistics read the Claude login it just saved. Open Keychain Access, find the “Claude Code-credentials” item for this account and allow access — or sign in again and choose “Always Allow” when macOS asks.' },
  login_not_saved: { pt: 'O login terminou, mas não foi salvo neste computador. Tente de novo; se repetir, entre uma vez num terminal com `claude auth login`.', en: 'The sign-in finished, but the login was not saved on this computer. Try again; if it repeats, sign in once in a terminal with `claude auth login`.' },
  root_in_use: { pt: 'Ainda há uma sessão aberta nesta conta. Encerre-a primeiro.', en: 'A session is still running in this account. End it first.' },
  unsupported: { pt: 'Este assistente mantém um só login por computador, então não dá para separar uma segunda conta.', en: 'This assistant keeps a single login per computer, so a second account cannot be kept apart.' },
  unsafe_path: { pt: 'A pasta de contas contém um atalho, então foi deixada como está.', en: 'The accounts folder contains a link, so it was left alone.' },
  login_unavailable: { pt: 'Não foi possível abrir o login deste assistente. Veja se ele está instalado.', en: 'Could not open this assistant\'s sign-in. Check that it is installed.' },
  disabled: { pt: 'Várias contas está desligada neste computador.', en: 'Multiple accounts is turned off on this computer.' },
  unknown_harness: { pt: 'Assistente desconhecido.', en: 'Unknown assistant.' },
  capability_disabled: { pt: 'Este computador não permite iniciar logins por esta tela (o perfil de exposição desliga o acesso local). Abra o agentistics no próprio computador ou ligue o acesso local nas configurações do servidor.', en: 'This computer does not allow starting sign-ins from this screen (its exposure profile turns local access off). Open agentistics on the computer itself, or turn local access on in the server settings.' },
  not_found: { pt: 'Este login já não está disponível. Comece de novo.', en: 'This sign-in is no longer available. Start again.' },
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

/** A failed attempt's sentence plus, when the server captured it, what the assistant itself said. */
export function failureText(row: Pick<RootRowView, 'error' | 'detail'>, pt: boolean): string {
  const base = addErrorText({ error: row.error }, pt)
  const said = row.detail?.trim()
  return said ? `${base} ${pt ? 'O assistente respondeu' : 'The assistant said'}: “${said}”` : base
}

export const ADD_COPY = (pt: boolean) => ({
  openLink: pt ? 'Abrir página de login' : 'Open sign-in page',
  stepOpen: pt ? 'Abra a página de login' : 'Open the sign-in page',
  stepOpenNote: pt ? 'Entre com a outra conta. O link abre em uma nova aba.' : 'Sign in with the other account. The link opens in a new tab.',
  stepPaste: pt ? 'Cole o código' : 'Paste the code',
  stepDevice: pt ? 'Digite o código na página' : 'Enter the code on the page',
  stepDone: pt ? 'Pronto' : 'Done',
  expired: pt ? 'O login expirou' : 'Sign-in expired',
  expiredNote: pt ? 'Este link não vale mais. Comece de novo para receber outro.' : 'This link no longer works. Start again to get a new one.',
  retry: pt ? 'Tentar de novo' : 'Try again',
  continueLogin: pt ? 'Continuar' : 'Continue',
  copyLink: pt ? 'Copiar link' : 'Copy link',
  copyCode: pt ? 'Copiar código' : 'Copy code',
  copied: pt ? 'Copiado' : 'Copied',
  linkStep: pt ? 'Abra este link e entre com a outra conta' : 'Open this link and sign in with the other account',
  pasteStep: pt ? 'Cole aqui o código que a página mostrar' : 'Paste the code shown by the page here',
  deviceStep: pt ? 'Na página, digite este código' : 'Enter this code on the page',
  kimiStep: pt ? 'O link já leva o código; confira se a página mostra este' : 'The link includes the code; check that the page shows this one',
  submit: pt ? 'Confirmar' : 'Confirm',
  signInNeedsFlag: pt ? 'Para entrar por aqui, ligue “Várias contas” em Ajustes → Experimental. Ou entre uma vez num terminal com `claude auth login`.' : 'To sign in from here, turn on “Multiple accounts” in Settings → Experimental. Or sign in once in a terminal with `claude auth login`.',
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
  cancelAria: (label: string) => (pt ? `Cancelar login do ${label}` : `Cancel ${label} sign-in`),
  noSecond: (labels: string) => (pt ? `${labels}: ainda não permite manter uma segunda conta separada.` : `${labels}: cannot keep a second account apart yet.`),
  flagOff: pt
    ? 'Várias contas é uma função experimental e está desligada neste computador.'
    : 'Multiple accounts is an experimental feature and is turned off on this computer.',
})
