import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, AlertTriangle, Info, CheckCircle2, BellOff, X } from 'lucide-react'
import { useNotifications, dismissNotification, resolveNotification, type AppNotification, type NotificationType } from '../lib/notifications'
import { getNotificationSettings, NAY_CARD_CODES } from '../lib/sessionNotifications'
import { pushLimitAlert } from '../lib/planLimitNotice'
import { UPDATE_NOTICE_CODE } from '../lib/updateToast'
import { openWhatsNew } from '../whatsNew/open'
import { setSessionMuted } from '../lib/mutedSessions'
import { useNotificationPanelOpen } from '../lib/notificationPanel'
import { NotificationBell } from './NotificationBell'
import { SESSION_MUTED_CODE } from '../lib/notifyMenu'
import { useAway } from '../lib/awayMode'
import { emptyToastQueue, enqueueToasts, removeToast, summaryToast, SUMMARY_ID } from '../lib/toastQueue'

// How long a toast lingers before it auto-dismisses (ms). Errors/warnings stay longer
// so they're readable; info/success clear a bit faster.
const AUTO_MS: Record<NotificationType, number> = {
  error:   6000,
  warning: 6000,
  info:    4500,
  success: 4500,
}
// Duration of the slide-out+fade exit animation before the toast is removed.
const EXIT_MS = 250

const STYLE: Record<NotificationType, { color: string; Icon: typeof AlertCircle }> = {
  error:   { color: '#ef4444', Icon: AlertCircle },
  warning: { color: '#f59e0b', Icon: AlertTriangle },
  info:    { color: '#3b82f6', Icon: Info },
  success: { color: '#22c55e', Icon: CheckCircle2 },
}

interface Props {
  lang: 'pt' | 'en'
}

/**
 * Fixed overlay that pops each NEW notification as a toast. Auto-dismisses after a
 * per-type delay, playing a slide-out+fade exit animation before removal. The
 * notification itself stays in the store (bell) — only the popup is transient.
 * Text is resolved at render time so it follows the language toggle.
 */
export function NotificationToasts({ lang }: Props) {
  const notes = useNotifications()
  const away = useAway().active
  const panelOpen = useNotificationPanelOpen()
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden')
  const [queue, setQueue] = useState(emptyToastQueue)
  const quiet = hidden || away
  const wasQuiet = useRef(quiet)
  const quietSince = useRef(quiet ? Date.now() : Infinity)
  const returnedAt = useRef(0)
  const toasts = quiet ? [] : [...queue.items, ...(queue.summary && !panelOpen ? [summaryToast(queue.summary, lang, queue.items.length > 0)] : [])]

  useEffect(() => {
    const changed = () => {
      // Record synchronously: notifications can land before React commits the visibility update.
      if (document.visibilityState === 'hidden') quietSince.current = Date.now()
      else returnedAt.current = Date.now()
      setHidden(document.visibilityState === 'hidden')
    }
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])
  useEffect(() => {
    if (quiet && !wasQuiet.current) quietSince.current = Date.now()
    if (!quiet && wasQuiet.current) returnedAt.current = Date.now()
    wasQuiet.current = quiet
    if (quiet) setQueue(q => enqueueToasts(q, q.items, Date.now(), true))
  }, [quiet])
  const [leaving, setLeaving] = useState<Set<string>>(new Set())
  const seen = useRef<Map<string, NotificationType>>(new Map())
  const initialized = useRef(false)
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const autoTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  // Play the exit animation, then remove the toast from the DOM.
  const startLeave = useCallback((id: string) => {
    setLeaving(prev => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
    if (timers.current[id]) clearTimeout(timers.current[id])
    timers.current[id] = setTimeout(() => {
      setQueue(q => removeToast(q, id))
      setLeaving(prev => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      delete timers.current[id]
    }, EXIT_MS)
  }, [])

  useEffect(() => {
    // On first run, treat everything already in the store as seen so we don't
    // replay historical notifications as toasts on mount.
    if (!initialized.current) {
      initialized.current = true
      for (const n of notes) seen.current.set(n.id, n.type)
      return
    }
    const incoming: AppNotification[] = []
    for (const n of notes) {
      const previousType = seen.current.get(n.id)
      seen.current.set(n.id, n.type)
      const isNew = previousType === undefined
      const severityChanged = previousType !== undefined && previousType !== n.type
      if (!isNew && !severityChanged) continue
      // A session card is the Nay button's to show, and do-not-disturb keeps every session event
      // quiet. Both stay in the bell; only the popup is skipped.
      // The update's bell entry is the RECORD of the popup the Nay window already showed — never a toast too.
      if (n.code === UPDATE_NOTICE_CODE) continue
      // A plan-limit notice is Nay's card when the card can take it; otherwise it is a toast.
      if (pushLimitAlert(n)) continue
      if (n.code && (NAY_CARD_CODES.has(n.code) || (n.code.startsWith('session.') && n.code !== SESSION_MUTED_CODE && getNotificationSettings().doNotDisturb))) continue
      if (severityChanged) {
        if (timers.current[n.id]) clearTimeout(timers.current[n.id])
        if (autoTimers.current[n.id]) clearTimeout(autoTimers.current[n.id])
        delete timers.current[n.id]
        delete autoTimers.current[n.id]
        setLeaving(prev => { const next = new Set(prev); next.delete(n.id); return next })
      }
      incoming.push(n)
    }
    if (incoming.length) {
      const backlog = quiet || document.visibilityState === 'hidden' || incoming.some(n => n.ts >= quietSince.current && n.ts <= returnedAt.current)
      setQueue(q => enqueueToasts(q, incoming, Date.now(), backlog))
    }
  }, [notes, startLeave, quiet])

  // Reconcile timers against the bounded presentation. Hidden/away summaries get their full
  // reading time on return; grouped cards cannot retain timers that later dismiss new content.
  useEffect(() => {
    const cards = quiet ? [] : [...queue.items, ...(queue.summary && !panelOpen ? [summaryToast(queue.summary, lang, queue.items.length > 0)] : [])]
    const active = new Set(cards.map(n => n.id))
    for (const id of Object.keys(autoTimers.current)) {
      if (!active.has(id) || id === SUMMARY_ID) { clearTimeout(autoTimers.current[id]); delete autoTimers.current[id] }
    }
    for (const id of Object.keys(timers.current)) {
      if (!active.has(id) || (id === SUMMARY_ID && queue.summary)) {
        clearTimeout(timers.current[id]); delete timers.current[id]
        setLeaving(prev => { const next = new Set(prev); next.delete(id); return next })
      }
    }
    for (const n of cards) {
      if (autoTimers.current[n.id]) continue
      autoTimers.current[n.id] = setTimeout(() => {
        delete autoTimers.current[n.id]
        startLeave(n.id)
      }, AUTO_MS[n.type])
    }
  }, [queue, quiet, lang, startLeave, panelOpen])

  // Clear any pending timers on unmount.
  useEffect(() => () => {
    for (const id of Object.keys(timers.current)) clearTimeout(timers.current[id])
    for (const id of Object.keys(autoTimers.current)) clearTimeout(autoTimers.current[id])
  }, [])

  return (
    <>
    <NotificationBell lang={lang} toastHost />
    {toasts.length > 0 && <div style={{
      position: 'fixed', top: 16, right: 16, zIndex: 4000,
      display: 'flex', flexDirection: 'column', gap: 10,
      maxWidth: 'min(360px, calc(100vw / var(--ui-zoom, 1) - 32px))', pointerEvents: 'none',
    }}>
      {toasts.map(n => {
        const { color, Icon } = STYLE[n.type]
        const { title, message } = resolveNotification(n, lang)
        const isLeaving = leaving.has(n.id)
        // Same opt-in handoff as the bell row (see NotificationBell.tsx): the update check is
        // automatic, the modal it can open is not.
        const isSummary = n.id === SUMMARY_ID
        const isUpdate = n.code === 'app.update_available'
        const isWhatsNew = n.code === 'app.whats_new'
        const isMuted = n.code === SESSION_MUTED_CODE
        const isTelemetry = n.code === 'telemetry.first_use'
        const isJournalFailed = n.meta?.loadingKind === 'journal' && n.meta?.state === 'failed'
        return (
          <div
            key={n.id}
            data-testid={isSummary ? 'notification-summary' : 'notification-toast'}
            role={isSummary || isUpdate || isWhatsNew ? 'button' : 'status'}
            aria-live="polite"
            tabIndex={isSummary || isUpdate || isWhatsNew ? 0 : undefined}
            onKeyDown={isSummary ? e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setQueue(q => removeToast(q, SUMMARY_ID)); window.dispatchEvent(new CustomEvent('agentistics:open-notifications')) } } : undefined}
            onClick={isSummary ? () => { setQueue(q => removeToast(q, SUMMARY_ID)); window.dispatchEvent(new CustomEvent('agentistics:open-notifications')) } : isUpdate ? () => { window.dispatchEvent(new CustomEvent('agentistics:open-update-modal')); startLeave(n.id) }
              : isWhatsNew ? () => { openWhatsNew(n.meta); startLeave(n.id) } : undefined}
            style={{
              pointerEvents: 'auto',
              display: 'flex', alignItems: 'flex-start', gap: 10,
              padding: '11px 12px', borderRadius: 10,
              background: 'var(--bg-card)', border: '1px solid var(--border)',
              borderLeft: `3px solid ${color}`,
              boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
              cursor: isSummary || isUpdate || isWhatsNew ? 'pointer' : undefined,
              animation: isLeaving
                ? `toastOut ${EXIT_MS}ms ease-in forwards`
                : 'toastIn 0.18s ease-out',
            }}
          >
            <Icon size={16} color={color} style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</div>
              {message && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.45, wordBreak: 'break-word' }}>
                  {message}
                </div>
              )}
            </div>
            {isMuted && (
              <button
                onClick={e => {
                  e.stopPropagation()
                  const key = String(n.meta?.muteKey ?? '')
                  if (key) setSessionMuted(key, false)
                  startLeave(n.id)
                }}
                aria-label={lang === 'pt' ? 'Desfazer silenciamento' : 'Undo mute'}
                title={lang === 'pt' ? 'Desfazer' : 'Undo'}
                style={{
                  flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4,
                  padding: '4px 7px', borderRadius: 6, border: '1px solid var(--border)',
                  background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer',
                  font: 'inherit', fontSize: 11,
                }}
              >
                <BellOff size={12} />{lang === 'pt' ? 'Desfazer' : 'Undo'}
              </button>
            )}
            {isTelemetry && <button onClick={e => { e.stopPropagation(); void fetch('/api/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ telemetryEnabled: false, telemetryNoticeDismissed: true }) }); startLeave(n.id) }} style={{ flexShrink: 0, padding: '4px 7px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', font: 'inherit', fontSize: 11 }}>{lang === 'pt' ? 'Desligar' : 'Turn off'}</button>}
            {isJournalFailed && <button onClick={e => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('agentistics:retry-journal-import')); startLeave(n.id) }} style={{ flexShrink: 0, padding: '4px 7px', borderRadius: 6, border: '1px solid var(--anthropic-orange)60', background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)', cursor: 'pointer', font: 'inherit', fontSize: 11 }}>{lang === 'pt' ? 'Tentar importar de novo' : 'Retry the import'}</button>}
            <button
              onClick={e => { e.stopPropagation(); startLeave(n.id) }}
              className="ag-tap-icon"
              aria-label="dismiss"
              style={{
                flexShrink: 0, display: 'flex', padding: 2, border: 'none',
                background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer',
              }}
            >
              <X size={13} />
            </button>
          </div>
        )
      })}
      <style>{`
        @keyframes toastIn { from { opacity: 0; transform: translateX(12px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes toastOut { from { opacity: 1; transform: translateX(0); } to { opacity: 0; transform: translateX(24px); } }
      `}</style>
    </div>}
    </>
  )
}

// Re-exported so callers can also remove from the store if desired.
export { dismissNotification }
