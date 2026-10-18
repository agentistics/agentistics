/**
 * AddAccount — Settings → Billing's "Add account": one secondary button per assistant that can keep
 * a second login, a ConfirmModal that explains the login session, and the pending logins as rows
 * ("Waiting for sign-in", with Cancel). Behind the `multi-account` experimental flag: off, there is
 * no button, only one line saying where to turn it on. Presentational logic lives in `addAccountLogic.ts`.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { HarnessId } from '@agentistics/core'
import { HARNESS_LABELS } from '../../lib/harness'
import { useIsMobile } from '../../hooks/useIsMobile'
import { HarnessMark } from '../../components/sessions/HarnessMark'
import { MetricNote } from '../../components/MetricNote'
import { Pill } from '../../components/Pill'
import { ConfirmModal, StatusDot, dialogButtonStyle } from './primitives'
import { ADD_COPY, addAccountView, addErrorText, anyResolved, loginTarget, pendingRoots, type Lang, type RootRowView } from './addAccountLogic'

const POLL_MS = 4000

export default function AddAccount({ lang, harnesses, onBound }: {
  lang: Lang
  harnesses: readonly HarnessId[]
  /** A pending login finished: re-read the account list. */
  onBound: () => void
}) {
  const pt = lang === 'pt'
  const t = ADD_COPY(pt)
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const [flagOn, setFlagOn] = useState<boolean | null>(null)
  const [roots, setRoots] = useState<RootRowView[]>([])
  const [asking, setAsking] = useState<HarnessId | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const rootsRef = useRef<RootRowView[]>([])

  useEffect(() => {
    let cancelled = false
    fetch('/api/experimental')
      .then(r => (r.ok ? r.json() : null))
      .then((b: { features?: { id: string; on: boolean }[] } | null) => {
        if (!cancelled) setFlagOn(b?.features?.find(f => f.id === 'multi-account')?.on === true)
      })
      .catch(() => { if (!cancelled) setFlagOn(false) /* unknown reads as off */ })
    return () => { cancelled = true }
  }, [])

  const refresh = useCallback(async (): Promise<RootRowView[]> => {
    try {
      const r = await fetch('/api/accounts/roots')
      if (!r.ok) return rootsRef.current
      const next = ((await r.json()) as { roots?: RootRowView[] }).roots ?? []
      if (anyResolved(rootsRef.current, next)) onBound()
      rootsRef.current = next
      setRoots(next)
      return next
    } catch { return rootsRef.current }
  }, [onBound])

  useEffect(() => { if (flagOn) void refresh() }, [flagOn, refresh])
  const waiting = pendingRoots(roots)
  useEffect(() => {
    if (!flagOn || waiting.length === 0) return
    const id = setInterval(() => { void refresh() }, POLL_MS)
    return () => clearInterval(id)
  }, [flagOn, waiting.length, refresh])

  const view = addAccountView(flagOn === true, harnesses)
  const label = (h: HarnessId) => HARNESS_LABELS[h] ?? h

  const confirm = async () => {
    if (!asking || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await fetch('/api/accounts/roots', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ harness: asking }),
      })
      const body: unknown = await r.json().catch(() => null)
      if (!r.ok) { setError(addErrorText(body, pt)); return }
      const pendingId = (body as { pendingId?: string } | null)?.pendingId
      const next = await refresh()
      setAsking(null)
      const target = next.find(x => x.pendingId === pendingId)
      const path = target ? loginTarget(target) : null
      if (path) navigate(path)
    } catch {
      setError(addErrorText(null, pt))
    } finally {
      setBusy(false)
    }
  }

  const cancelPending = async (r: RootRowView) => {
    if (!r.pendingId || cancelling) return
    setCancelling(r.pendingId)
    setCancelError(null)
    try {
      const res = await fetch(`/api/accounts/roots/${encodeURIComponent(r.pendingId)}`, { method: 'DELETE' })
      if (!res.ok) setCancelError(addErrorText(await res.json().catch(() => null), pt))
    } catch {
      setCancelError(addErrorText(null, pt))
    } finally {
      setCancelling(null)
      await refresh()
    }
  }

  if (flagOn === null) return null
  if (view.kind === 'off') return <MetricNote>{t.flagOff}</MetricNote>
  return (
    <div data-add-account style={{ marginTop: 14 }}>
      {waiting.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          {waiting.map(r => {
            const target = loginTarget(r)
            return (
              <div key={r.pendingId ?? r.root} data-pending-root={r.pendingId} style={{
                display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: isMobile ? 'stretch' : 'center', gap: 10,
                padding: '10px 14px', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', background: 'var(--bg-card)',
              }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
                  <HarnessMark harness={r.harness} size={22} />
                  <b style={{ fontSize: 13, color: 'var(--text-primary)' }}>{label(r.harness)}</b>
                  <Pill tone="warn" nowrap><StatusDot state="warn" size={7} /> {t.waiting}</Pill>
                </span>
                {target && <button type="button" style={dialogButtonStyle('secondary', isMobile)} onClick={() => navigate(target)}>{t.openLogin}</button>}
                <button type="button" style={dialogButtonStyle('secondary', isMobile)} disabled={cancelling !== null} onClick={() => { void cancelPending(r) }}>{cancelling === r.pendingId ? t.cancelling : t.cancelPending}</button>
              </div>
            )
          })}
        </div>
      )}
      {cancelError && <p role="alert" style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--accent-red)' }}>{cancelError}</p>}
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>{t.add}</div>
      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', flexWrap: 'wrap', gap: 8 }}>
        {view.addable.map(h => (
          <button key={h} type="button" aria-label={t.addTo(label(h))}
            style={{ ...dialogButtonStyle('secondary', isMobile), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
            onClick={() => { setError(null); setAsking(h) }}>
            <HarnessMark harness={h} size={16} />{label(h)}
          </button>
        ))}
      </div>
      {view.unsupported.length > 0 && (
        <div style={{ marginTop: 8 }}><MetricNote>{t.noSecond(view.unsupported.map(label).join(', '))}</MetricNote></div>
      )}
      <ConfirmModal
        open={asking !== null}
        tone="default"
        title={asking ? t.title(label(asking)) : ''}
        message={asking ? t.message(label(asking)) : ''}
        confirmLabel={busy ? t.working : t.confirm}
        cancelLabel={t.cancel}
        busy={busy}
        onConfirm={() => { void confirm() }}
        onCancel={() => { if (!busy) setAsking(null) }}
      >
        {busy && <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--text-secondary)' }}>{t.workingNote}</p>}
        {error && <p role="alert" style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--accent-red)' }}>{error}</p>}
      </ConfirmModal>
    </div>
  )
}
