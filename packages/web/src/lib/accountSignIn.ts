/**
 * "Entrar" (sign in) everywhere in the app opens the ONE in-app login: Usage → Accounts' "Add
 * account" dialog, the paste-the-code flow. It used to start an ordinary session at the
 * assistant's own login instead — and a session born in the browser runs STRUCTURED (`claude -p`
 * stream-json) when the adapter chat is on, which has no interactive login and exits at once: the
 * owner got an "Entrar · Claude Code" session that was already finished and empty (CONTAS.LOGIN r4).
 *
 * A request is a harness plus a nonce, so the same harness asked twice opens the dialog twice. The
 * dialog TAKES the request (`take`), so a later mount of the panel never replays an old click.
 */
import { useCallback } from 'react'
import { useInRouterContext, useNavigate } from 'react-router-dom'

export interface AccountSignInRequest { harness: string; nonce: number }
let current: AccountSignInRequest | null = null, nonce = 0
const listeners = new Set<() => void>()
export const accountSignInStore = {
  get: (): AccountSignInRequest | null => current,
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
  request(harness: string) { current = { harness, nonce: ++nonce }; for (const fn of listeners) fn() },
  /** The dialog consumed it: drop it unless a newer request replaced it meanwhile. */
  take(n: number) { if (current?.nonce === n) { current = null; for (const fn of listeners) fn() } },
}

/** Where the dialog lives. */
export const ACCOUNTS_LOCATION = { pathname: '/usage', hash: '#contas' } as const

/** Ask for the sign-in dialog and go to the accounts list, which opens it. Never a session. */
export function useOpenAccountSignIn(): (harness: string) => void {
  // Constant per mount: a component is either inside the router or not, never both.
  const navigate = useInRouterContext() ? useNavigate() : null // eslint-disable-line react-hooks/rules-of-hooks
  return useCallback((harness: string) => {
    accountSignInStore.request(harness)
    navigate?.(ACCOUNTS_LOCATION)
  }, [navigate])
}
