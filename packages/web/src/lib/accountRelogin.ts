/**
 * accountRelogin.ts — HOTFIX.LOGIN-EXPIRADO on the browser side: sign an EXISTING account in again,
 * in the folder it already lives in, so the server re-binds the SAME id (nickname, plan, history and
 * the agent switch kept — never remove + add). The rules are the server's; this module holds the wire
 * shapes, the words, and the one pure decision of the session bar.
 */

/** The server's `LoginInfo` (same shape as Add account's `LoginInfoView`). */
export interface LoginInfoView { kind: 'paste' | 'device'; url: string; code?: string; expiresAt: number; error?: 'invalid_code' }

export type ReloginStatus =
  | { status: 'pending'; accountId: string; login?: LoginInfoView }
  | { status: 'done'; accountId: string; boundId: string; same: boolean }
  | { status: 'failed'; accountId: string; error: string; message: string; detail?: string }

/** What the server said when the sign-in could not even start (`error` = its code). */
export interface ReloginRefusal { error: string; message?: string }

const base = (id: string) => `/api/accounts/roots/relogin/${encodeURIComponent(id)}`

export async function startRelogin(id: string, signal?: AbortSignal): Promise<({ ok: true; pendingId: string } & LoginInfoView) | ReloginRefusal> {
  try {
    const r = await fetch(base(id), { method: 'POST', ...(signal ? { signal } : {}) })
    const body = await r.json().catch(() => null)
    if (r.ok && body?.ok) return body
    return { error: typeof body?.error === 'string' ? body.error : 'login_unavailable', ...(typeof body?.message === 'string' ? { message: body.message } : {}) }
  } catch { return { error: 'login_unavailable' } }
}

export async function readRelogin(id: string): Promise<ReloginStatus | null> {
  try {
    const r = await fetch(base(id))
    return r.ok ? await r.json() as ReloginStatus : null
  } catch { return null }
}

export async function sendReloginCode(id: string, code: string): Promise<{ ok: true } | ReloginRefusal> {
  try {
    const r = await fetch(`${base(id)}/code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })
    const body = await r.json().catch(() => null)
    return r.ok ? { ok: true } : { error: typeof body?.error === 'string' ? body.error : 'login_failed' }
  } catch { return { error: 'login_failed' } }
}

export async function cancelRelogin(id: string): Promise<void> {
  await fetch(base(id), { method: 'DELETE' }).catch(() => undefined)
}

/** The session's account state, as the switch GET reports it (`SwitchInfo.auth`). */
export interface SessionAuth {
  accountId: string
  label?: string
  state: 'expired' | 'signed_out'
  message?: string
  pendingPreview?: string
  pending?: string
  relogin: boolean
}

/**
 * PURE. What the bar above the composer shows. It never hides on a dismiss — the owner's rule is that
 * it goes away only when the account works again or the session moves to another account:
 * - `blocked`: the session's account cannot work (server says so);
 * - `renewed`: the person just signed in again here and a refused message can be re-sent — shown
 *   until it is re-sent or put away, and only while the account still is the session's;
 * - `none`: nothing to say.
 */
export type AuthBar =
  | { kind: 'none' }
  | { kind: 'blocked'; auth: SessionAuth }
  | { kind: 'renewed'; accountId: string; pending: string }

export function authBar(o: {
  auth: SessionAuth | null | undefined
  /** The session's account now (`SwitchInfo.current.id`). */
  currentAccountId: string | undefined
  /** Set when a sign-in-again finished from this bar: the account and the message it refused. */
  renewed: { accountId: string; pending?: string } | null
}): AuthBar {
  if (o.auth && o.auth.accountId === o.currentAccountId) {
    // The server catches up a poll later: a sign-in that just finished wins over its stale answer.
    if (!(o.renewed && o.renewed.accountId === o.auth.accountId)) return { kind: 'blocked', auth: o.auth }
  }
  if (o.renewed?.pending && o.renewed.accountId === o.currentAccountId) return { kind: 'renewed', accountId: o.renewed.accountId, pending: o.renewed.pending }
  return { kind: 'none' }
}

export const AUTH_COPY = (pt: boolean) => ({
  expired: (who: string) => pt ? `O login da conta ${who} expirou` : `The login of account ${who} expired`,
  signedOut: (who: string) => pt ? `A conta ${who} não está conectada` : `Account ${who} is not signed in`,
  why: pt
    ? 'Esta sessão não consegue continuar nela até você entrar de novo — ou trocar de conta.'
    : 'This session cannot carry on with it until you sign in again — or switch accounts.',
  whyNoRelogin: pt
    ? 'Este assistente não permite refazer o login por aqui; troque de conta para continuar.'
    : 'This assistant cannot be signed in again from here; switch accounts to carry on.',
  relogin: pt ? 'Refazer login' : 'Sign in again',
  switch: pt ? 'Trocar de conta' : 'Switch account',
  renewed: pt ? 'Login refeito' : 'Signed in again',
  resendQ: pt ? 'Reenviar a mensagem que foi recusada?' : 'Re-send the message that was refused?',
  resend: pt ? 'Reenviar mensagem' : 'Re-send message',
  resending: pt ? 'Reenviando…' : 'Re-sending…',
  notNow: pt ? 'Agora não' : 'Not now',
  resendFailed: pt ? 'Não foi possível reenviar. Envie de novo pelo campo abaixo.' : 'Could not re-send. Send it again from the field below.',
  // The modal (reuses Add account's steps).
  title: (who: string) => pt ? `Refazer login · ${who}` : `Sign in again · ${who}`,
  stepOpenNote: pt ? 'Entre com a MESMA conta. O link abre em uma nova aba.' : 'Sign in with the SAME account. The link opens in a new tab.',
  done: pt ? 'Login refeito' : 'Signed in again',
  doneNote: pt ? 'A conta voltou a funcionar, com o mesmo apelido, plano e histórico.' : 'The account works again, with the same nickname, plan and history.',
  doneOther: pt
    ? 'Você entrou com OUTRA conta: ela foi registrada à parte, e esta continua sem login.'
    : 'You signed in with ANOTHER account: it was registered separately, and this one is still signed out.',
  // Usage → Accounts.
  rowExpired: pt ? 'Login expirado' : 'Login expired',
  rowSignedOut: pt ? 'Sem login' : 'Signed out',
  drawerExpired: pt
    ? 'O assistente recusou o login desta conta. Nenhuma sessão nova nem troca automática vai para ela até você entrar de novo.'
    : 'The assistant refused this account\'s login. No new session or automatic switch lands on it until you sign in again.',
  drawerSignedOut: pt
    ? 'Nenhum login guarda esta conta neste computador. Entre de novo para ela voltar a receber sessões.'
    : 'No login holds this account on this computer. Sign in again so it can take sessions.',
  drawerNoRelogin: pt
    ? 'Este assistente não permite refazer o login por aqui: entre de novo nele neste computador.'
    : 'This assistant cannot be signed in again from here: sign in to it again on this computer.',
})
