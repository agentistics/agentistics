/**
 * CONTA.TROCA — continue a session on another account of its harness.
 *
 * Two entries, ONE dialog: the notice above the composer when the conversation's last turn was
 * refused by the account's usage limit, and "Switch account" in the session's own menu, any time.
 * Built from the app's own pieces: `ConfirmModal`, `Select`, `Checkbox` (settings primitives) and the
 * handoff band's notice styling (`handoffWarning.css`), so it reads like every other notice there.
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { Users, X } from 'lucide-react'
import { Checkbox, ConfirmModal, Select } from '../../pages/settings/primitives'
import {
  defaultTarget, fetchSwitchInfo, noticeTitle, optionLabel, postSwitch, resetPhrase, showLimitNotice,
  type SwitchInfo,
} from '../../lib/accountSwitch'
import { pushNotification } from '../../lib/notifications'
import './handoffWarning.css'

/** How often an open session asks whether its last turn hit a limit. A transcript tail read. */
const POLL_MS = 15_000

/** The switch info for one session, re-read while it is on screen and the tab is visible. */
export function useSwitchInfo(id: string | undefined, lang: string, enabled = true): [SwitchInfo | null, () => void] {
  const [info, setInfo] = useState<SwitchInfo | null>(null)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick(t => t + 1), [])
  useEffect(() => {
    setInfo(null)
    if (!id || !enabled) return
    let alive = true
    let t: ReturnType<typeof setInterval> | undefined
    const read = () => {
      if (document.visibilityState === 'hidden') return
      void fetchSwitchInfo(id, lang).then(i => {
        if (!alive) return
        setInfo(i)
        // Multiple accounts off, or a harness that cannot switch: nothing to watch for on this row.
        if (i && !i.supported && t) { clearInterval(t); t = undefined }
      })
    }
    read()
    t = setInterval(read, POLL_MS)
    return () => { alive = false; if (t) clearInterval(t) }
  }, [id, lang, enabled, tick])
  return [info, reload]
}

export function AccountSwitchDialog({ open, sessionId, info, lang, fromLimit, onClose, onSwitched }: {
  open: boolean
  sessionId: string
  info: SwitchInfo
  lang: string
  /** Opened from the limit notice: offers to re-send the refused message. */
  fromLimit: boolean
  onClose: () => void
  /** The NEW session id: the switch retires this row and mints its continuation. */
  onSwitched: (newId: string) => void
}) {
  const pt = lang === 'pt'
  const [target, setTarget] = useState('')
  const pending = fromLimit ? info.limit?.pendingPreview : undefined
  const [resend, setResend] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    setTarget(defaultTarget(info.options)); setResend(true); setError(null); setBusy(false)
  }, [open, info.options])
  const chosen = info.options.find(o => o.id === target)
  const from = info.current?.label
  const message = pt
    ? `A sessão é encerrada e a mesma conversa continua${chosen ? ` na conta ${chosen.label}` : ' na outra conta'}${from ? ` (agora em ${from})` : ''}. A conversa é copiada, não movida: o histórico na conta atual continua lá.`
    : `The session is ended and the same conversation continues${chosen ? ` on ${chosen.label}` : ' on the other account'}${from ? ` (now on ${from})` : ''}. The conversation is copied, not moved: the history on the current account stays there.`
  async function confirm() {
    if (!target) return
    setBusy(true); setError(null)
    const out = await postSwitch(sessionId, target, !!pending && resend, lang)
    setBusy(false)
    if (!out.ok) { setError(out.message); return }
    pushNotification({ type: 'success', title: pt ? 'Conta trocada' : 'Account switched', message: out.message })
    onClose()
    if (out.id) onSwitched(out.id)
  }
  return (
    <ConfirmModal
      open={open}
      tone="default"
      icon={<Users size={18} />}
      title={pt ? 'Continuar em outra conta' : 'Continue on another account'}
      message={message}
      confirmLabel={busy ? (pt ? 'Trocando…' : 'Switching…') : (pt ? 'Trocar conta' : 'Switch account')}
      cancelLabel={pt ? 'Cancelar' : 'Cancel'}
      onConfirm={() => { void confirm() }}
      onCancel={onClose}
      busy={busy || !target}
      mobileSheet
    >
      <div data-account-switch style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
        {info.options.length > 1 && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
            {pt ? 'Conta' : 'Account'}
            <Select value={target} onChange={setTarget} options={info.options.map(o => ({ value: o.id, label: optionLabel(o, pt) }))} />
          </label>
        )}
        {pending && (
          <>
            <Checkbox checked={resend} onChange={setResend} label={pt ? 'Reenviar a última mensagem na nova conta' : 'Re-send the last message on the new account'} />
            {resend && (
              <blockquote style={{ margin: 0, padding: '6px 10px', borderLeft: '3px solid var(--border)', color: 'var(--text-secondary)', fontSize: 12, overflowWrap: 'anywhere' }}>
                {pending}
              </blockquote>
            )}
          </>
        )}
        {error && <p role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--accent-red)', overflowWrap: 'anywhere' }}>{error}</p>}
      </div>
    </ConfirmModal>
  )
}

/** The notice above the composer. Absent unless the last turn hit a limit AND another account can take it. */
export function AccountLimitBand({ sessionId, lang, onSwitched }: { sessionId: string; lang: string; onSwitched: (newId: string) => void }) {
  const pt = lang === 'pt'
  const [info] = useSwitchInfo(sessionId, lang)
  const [open, setOpen] = useState(false)
  // A dismissal holds for THIS limit only: the next one (a new reset time) shows again. It is kept
  // per session in localStorage so a reload or re-entering the session does not bring it back.
  const key = info?.limit ? `${info.limit.resetsAt ?? ''}:${info.limit.pendingPreview ?? ''}` : ''
  const storeKey = `agentistics.accountLimitDismissed.${sessionId}`
  const [dismissed, setDismissedState] = useState<string | null>(() => {
    try { return localStorage.getItem(storeKey) } catch { return null }
  })
  const setDismissed = (k: string) => {
    setDismissedState(k)
    try { localStorage.setItem(storeKey, k) } catch { /* private mode: the dismissal lasts this view only */ }
  }
  const visible = showLimitNotice(info) && dismissed !== key
  return (
    <>
      <div className={`handoff-band-wrap ${visible ? 'visible' : ''}`} inert={!visible} aria-hidden={!visible} data-account-limit-band>
        <div className="handoff-band-clip">
          <div className="handoff-band" role="status" style={{ '--handoff-tone': 'var(--anthropic-orange)' } as CSSProperties}>
            <div className="handoff-band-copy">
              <strong>{info ? noticeTitle(info, pt) : ''}</strong>
              <span>{[info?.current?.label, resetPhrase(info?.limit?.resetsAt, pt)].filter(Boolean).join(' · ') || (pt ? 'A conversa continua igual, na outra conta.' : 'The conversation carries on unchanged, on the other account.')}</span>
            </div>
            <div className="handoff-actions">
              <button type="button" className="primary" onClick={() => setOpen(true)}>{pt ? 'Continuar na outra conta' : 'Continue on the other account'}</button>
              <button type="button" className="icon" aria-label={pt ? 'Dispensar' : 'Dismiss'} onClick={() => setDismissed(key)}><X size={16} /></button>
            </div>
          </div>
        </div>
      </div>
      {info && <AccountSwitchDialog open={open} sessionId={sessionId} info={info} lang={lang} fromLimit onClose={() => setOpen(false)} onSwitched={onSwitched} />}
    </>
  )
}
