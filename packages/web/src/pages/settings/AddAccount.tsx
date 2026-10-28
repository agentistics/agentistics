/** Settings → Billing: headless link/code login; account binding remains the source of truth. */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { HarnessId } from '@agentistics/core'
import { HARNESS_LABELS } from '../../lib/harness'
import { useIsMobile } from '../../hooks/useIsMobile'
import { HarnessMark } from '../../components/sessions/HarnessMark'
import { MetricNote } from '../../components/MetricNote'
import { dialogButtonStyle } from './primitives'
import { AccountLoginModal, PendingLoginCard } from './AccountLoginModal'
import { ADD_COPY, addAccountView, addErrorText, alreadyGone, anyResolved, attemptIsOver, pendingRoots, refusalCode, type Lang, type LoginInfoView, type RootRowView } from './addAccountLogic'

interface ActiveLogin { harness: HarnessId; pendingId?: string; login?: LoginInfoView; bound?: RootRowView }
export default function AddAccount({ lang, harnesses, onBound }: {
  lang: Lang; harnesses: readonly HarnessId[]; onBound: () => void
}) {
  const pt = lang === 'pt', t = ADD_COPY(pt), mobile = useIsMobile()
  const [flagOn, setFlagOn] = useState<boolean | null>(null), [roots, setRoots] = useState<RootRowView[]>([])
  const [active, setActive] = useState<ActiveLogin | null>(null), [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null), [submitted, setSubmitted] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null), [expired, setExpired] = useState(false)
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set())
  const rootsRef = useRef<RootRowView[]>([]), generation = useRef(0), activeRef = useRef<ActiveLogin | null>(null)
  const creating = useRef<AbortController | null>(null), sending = useRef(false)
  const updateActive = (value: ActiveLogin | null) => { activeRef.current = value; setActive(value) }
  const remove = useCallback(async (id: string) => {
    const res = await fetch(`/api/accounts/roots/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (res.ok) return
    const body = await res.json().catch(() => null)
    // Already dropped by the server (timed out, failed, or a second click): nothing left to cancel.
    if (res.status === 404 && alreadyGone(body)) return
    throw body
  }, [])

  useEffect(() => {
    let disposed = false
    void fetch('/api/experimental').then(r => r.ok ? r.json() : null).then(b => {
      if (!disposed) setFlagOn(b?.features?.find((f: { id: string; on: boolean }) => f.id === 'multi-account')?.on === true)
    }).catch(() => { if (!disposed) setFlagOn(false) })
    return () => { disposed = true }
  }, [])
  // Leaving Settings is Cancel too. An in-flight create is cleaned up when its reply arrives.
  useEffect(() => () => {
    generation.current++; creating.current?.abort()
    const current = activeRef.current
    if (current?.pendingId && !current.bound) void remove(current.pendingId).catch(() => {})
  }, [remove])

  const refresh = useCallback(async () => {
    const version = generation.current
    try {
      const res = await fetch('/api/accounts/roots')
      if (!res.ok) return
      const next: RootRowView[] = (await res.json()).roots ?? []
      if (generation.current !== version) return
      if (anyResolved(rootsRef.current, next)) onBound()
      rootsRef.current = next; setRoots(next)
      const current = activeRef.current
      if (!current?.pendingId || sending.current) return
      const row = next.find(r => r.pendingId === current.pendingId)
      if (row?.status === 'bound') {
        const value = { ...current, bound: row }; activeRef.current = value; setActive(value); setError(null)
      } else if (row?.status === 'failed') {
        setExpired(true); setError(addErrorText({ error: row.error }, pt))
      } else if (!row || row.stale) { setExpired(true); setError(addErrorText({ error: 'login_timeout' }, pt)) }
      else if (row.login) {
        if (row.login.error === 'invalid_code') { setSubmitted(false); setError(addErrorText({ error: 'invalid_code' }, pt)) }
        const value = { ...current, login: row.login }; activeRef.current = value; setActive(value)
      }
    } catch { /* Retry on the next poll; a network failure is not proof of a failed login. */ }
  }, [onBound, pt])
  useEffect(() => { if (flagOn) void refresh() }, [flagOn, refresh])
  const waiting = pendingRoots(roots)
  useEffect(() => {
    if (!flagOn || (!waiting.length && !active?.pendingId)) return
    const timer = setInterval(() => { void refresh() }, 2000)
    return () => clearInterval(timer)
  }, [flagOn, waiting.length, active?.pendingId, refresh])

  const begin = async (harness: HarnessId) => {
    const version = ++generation.current
    const controller = new AbortController(); creating.current = controller
    updateActive({ harness }); setBusy(true); setError(null); setSubmitted(false); setExpired(false); setCancelError(null)
    try {
      const res = await fetch('/api/accounts/roots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ harness }), signal: controller.signal })
      const body = await res.json().catch(() => null)
      if (generation.current !== version) {
        if (res.ok && body?.pendingId) await remove(body.pendingId)
        return
      }
      if (!res.ok) { setError(addErrorText(body, pt)); return }
      updateActive({ harness, pendingId: body.pendingId, login: { kind: body.kind, url: body.url, code: body.code, expiresAt: body.expiresAt } })
      await refresh()
    } catch { if (generation.current === version) setError(addErrorText(null, pt)) }
    finally { if (generation.current === version) setBusy(false) }
  }
  const close = async () => {
    const current = activeRef.current
    if (!current) return
    // Invalidate polling and creation callbacks before awaiting process/root cleanup.
    generation.current++; creating.current?.abort(); creating.current = null; sending.current = false
    updateActive(null); setError(null); setBusy(false); setSubmitted(false); setExpired(false)
    if (current.pendingId && !current.bound) {
      try { await remove(current.pendingId); setCancelError(null) }
      catch (body) { setCancelError(addErrorText(body, pt)) }
    }
    await refresh()
  }

  const submit = async (code: string) => {
    const current = activeRef.current
    if (!current?.pendingId || busy) return
    const version = ++generation.current; sending.current = true
    setBusy(true); setError(null); setSubmitted(true)
    try {
      const res = await fetch(`/api/accounts/roots/${encodeURIComponent(current.pendingId)}/code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })
      if (generation.current !== version) return
      sending.current = false
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        setSubmitted(false); setError(addErrorText(body, pt)); if (attemptIsOver(refusalCode(body))) setExpired(true)
      }
      else await refresh()
    } catch { if (generation.current === version) { setSubmitted(false); setError(addErrorText(null, pt)) } }
    finally { if (generation.current === version) { sending.current = false; setBusy(false) } }
  }
  const cancelPending = async (row: RootRowView) => {
    const id = row.pendingId
    if (!id || cancelling.has(id)) return
    setCancelling(prev => new Set(prev).add(id))
    try { await remove(id); setCancelError(null); await refresh() }
    catch (body) { setCancelError(addErrorText(body, pt)) }
    finally { setCancelling(prev => { const next = new Set(prev); next.delete(id); return next }) }
  }
  /** Drop the dead attempt (if any) and start a NEW sign-in for the same assistant. */
  const retry = async (harness: HarnessId, pendingId?: string) => {
    const current = activeRef.current
    const old = pendingId ?? (current && !current.bound ? current.pendingId : undefined)
    generation.current++; updateActive(null)
    if (old) await remove(old).catch(() => {})
    await begin(harness)
  }
  const resume = (row: RootRowView) => {
    generation.current++; updateActive({ harness: row.harness, pendingId: row.pendingId, login: row.login })
    setError(null); setBusy(false); setSubmitted(false); setExpired(false)
  }
  if (flagOn === null) return null
  const view = addAccountView(flagOn, harnesses)
  if (view.kind === 'off') return <MetricNote>{t.flagOff}</MetricNote>
  const label = (h: HarnessId) => HARNESS_LABELS[h] ?? h
  const button = dialogButtonStyle('secondary', mobile)
  return <div data-add-account style={{ marginTop: 14 }}>
    {waiting.map(row => <PendingLoginCard key={row.pendingId} row={row} lang={lang} mobile={mobile} own={active?.pendingId === row.pendingId}
      busy={!!row.pendingId && cancelling.has(row.pendingId)} onResume={() => resume(row)} onRetry={() => { void retry(row.harness, row.pendingId) }}
      onCancel={() => { void cancelPending(row) }} />)}
    {cancelError && <p role="alert" style={{ fontSize: 13, color: 'var(--accent-red)', margin: '0 0 10px' }}>{cancelError}</p>}
    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>{t.add}</div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {view.addable.map(h => <button key={h} type="button" style={button} aria-label={t.addTo(label(h))} onClick={() => { void begin(h) }}><HarnessMark harness={h} size={16} />{label(h)}</button>)}
    </div>
    {view.unsupported.length > 0 && <MetricNote>{t.noSecond(view.unsupported.map(label).join(', '))}</MetricNote>}
    {active && <AccountLoginModal key={`${active.harness}:${active.pendingId ?? 'starting'}`} harness={active.harness} lang={lang} login={active.login} bound={active.bound}
      busy={busy} submitted={submitted} error={error} expired={expired} onSubmit={code => { void submit(code) }} onCancel={() => { void close() }}
      onRetry={() => { void retry(active.harness) }} />}
  </div>
}
