/**
 * ReloginModal — HOTFIX.LOGIN-EXPIRADO: "Sign in again" for an EXISTING account. The same steps as
 * "Add account" (`AccountLoginModal`: open the link, paste the code / enter the device code), driven by
 * `/api/accounts/roots/relogin/<id>`, which runs the login in the account's own folder and re-binds the
 * SAME id. Never a terminal. Used from the session bar and from Usage → Accounts.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { HarnessId } from '@agentistics/core'
import { AccountLoginModal } from './AccountLoginModal'
import { addErrorText, attemptIsOver, type Lang, type RootRowView } from './addAccountLogic'
import { AUTH_COPY, cancelRelogin, readRelogin, sendReloginCode, startRelogin, type LoginInfoView } from '../../lib/accountRelogin'

const POLL_MS = 2000

export function ReloginModal({ accountId, harness, who, lang, onClose, onDone }: {
  accountId: string
  harness: HarnessId
  /** The account's name as the screen shows it (nickname, else login). */
  who: string
  lang: Lang
  onClose: () => void
  /** The sign-in finished. `same`: the SAME account was re-bound (the expected case). */
  onDone?: (r: { same: boolean; boundId: string }) => void
}) {
  const pt = lang === 'pt'
  const t = AUTH_COPY(pt)
  const [login, setLogin] = useState<LoginInfoView | undefined>()
  const [bound, setBound] = useState<RootRowView | undefined>()
  const [same, setSame] = useState(true)
  const [busy, setBusy] = useState(true)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expired, setExpired] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const finished = useRef(false)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  // Start (and restart on "Try again"). Leaving before it finished cancels the sign-in on the server.
  useEffect(() => {
    let alive = true
    const ctrl = new AbortController()
    setBusy(true); setError(null); setExpired(false); setSubmitted(false); setLogin(undefined)
    void startRelogin(accountId, ctrl.signal).then(out => {
      if (!alive) return
      setBusy(false)
      if ('error' in out) {
        setError(addErrorText(out, pt))
        if (attemptIsOver(out.error) || out.error === 'login_unavailable') setExpired(true)
        return
      }
      const { ok: _ok, pendingId: _p, ...info } = out
      setLogin(info)
    })
    return () => { alive = false; ctrl.abort() }
  }, [accountId, attempt, pt])
  useEffect(() => () => { if (!finished.current) void cancelRelogin(accountId) }, [accountId])

  // Follow the sign-in until the server re-binds the account (or says it failed).
  useEffect(() => {
    if (!login || bound || expired) return
    let alive = true
    const tick = async () => {
      const s = await readRelogin(accountId)
      if (!alive || !s) return
      if (s.status === 'pending') {
        if (s.login) setLogin(s.login)
        if (s.login?.error === 'invalid_code') { setSubmitted(false); setError(addErrorText({ error: 'invalid_code' }, pt)) }
        return
      }
      if (s.status === 'failed') { setExpired(true); setError(addErrorText({ error: s.error }, pt)); return }
      // Only an explicit `done` finishes: an answer this screen does not know is no proof of a sign-in.
      if (s.status !== 'done') return
      finished.current = true
      setSame(s.same)
      setBound({ harness, root: '', status: 'bound', accountId: s.boundId, label: who })
      onDoneRef.current?.({ same: s.same, boundId: s.boundId })
    }
    const timer = setInterval(() => { void tick() }, POLL_MS)
    void tick()
    return () => { alive = false; clearInterval(timer) }
  }, [accountId, login, bound, expired, harness, who, pt])

  const submit = useCallback(async (code: string) => {
    setBusy(true); setError(null)
    const out = await sendReloginCode(accountId, code)
    setBusy(false)
    if ('error' in out) {
      setError(addErrorText(out, pt))
      if (attemptIsOver(out.error)) setExpired(true)
      return
    }
    setSubmitted(true)
  }, [accountId, pt])

  return (
    <AccountLoginModal harness={harness} lang={lang} login={login} bound={bound} busy={busy} submitted={submitted}
      error={error} expired={expired} errorCode={undefined}
      onSubmit={code => { void submit(code) }}
      onCancel={onClose}
      onRetry={() => { void cancelRelogin(accountId).then(() => setAttempt(n => n + 1)) }}
      wording={{ title: t.title(who), stepOpenNote: t.stepOpenNote, done: t.done, doneNote: same ? t.doneNote : t.doneOther }} />
  )
}
