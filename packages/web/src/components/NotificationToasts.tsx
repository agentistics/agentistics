import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, AlertTriangle, Info, CheckCircle2, BellOff, X } from 'lucide-react'
import { useNotifications, dismissNotification, resolveNotification, type AppNotification, type NotificationType } from '../lib/notifications'
import { getNotificationSettings, NAY_CARD_CODES } from '../lib/sessionNotifications'
import { UPDATE_NOTICE_CODE } from '../lib/updateToast'
import { openWhatsNew } from '../whatsNew/open'
import { setSessionMuted } from '../lib/mutedSessions'
import { SESSION_MUTED_CODE } from '../lib/notifyMenu'

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
  const [toasts, setToasts] = useState<AppNotification[]>([])
  const [leaving, setLeaving] = useState<Set<string>>(new Set())
  const seen = useRef<Set<string>>(new Set())
  const initialized = useRef(false)
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

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
      setToasts(t => t.filter(x => x.id !== id))
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
      for (const n of notes) seen.current.add(n.id)
      return
    }
    for (const n of notes) {
      if (seen.current.has(n.id)) continue
      seen.current.add(n.id)
      // A session card is the Nay button's to show, and do-not-disturb keeps every session event
      // quiet. Both stay in the bell; only the popup is skipped.
      // The update's bell entry is the RECORD of the popup the Nay window already showed — never a toast too.
      if (n.code === UPDATE_NOTICE_CODE) continue
      if (n.code && (NAY_CARD_CODES.has(n.code) || (n.code.startsWith('session.') && n.code !== SESSION_MUTED_CODE && getNotificationSettings().doNotDisturb))) continue
      setToasts(t => [n, ...t])
      setTimeout(() => startLeave(n.id), AUTO_MS[n.type])
    }
  }, [notes, startLeave])

  // Clear any pending timers on unmount.
  useEffect(() => () => { for (const id of Object.keys(timers.current)) clearTimeout(timers.current[id]) }, [])

  if (toasts.length === 0) return null

  return (
    <div style={{
      position: 'fixed', top: 16, right: 16, zIndex: 4000,
      display: 'flex', flexDirection: 'column', gap: 10,
      maxWidth: 'min(360px, calc(100vw - 32px))', pointerEvents: 'none',
    }}>
      {toasts.map(n => {
        const { color, Icon } = STYLE[n.type]
        const { title, message } = resolveNotification(n, lang)
        const isLeaving = leaving.has(n.id)
        // Same opt-in handoff as the bell row (see NotificationBell.tsx): the update check is
        // automatic, the modal it can open is not.
        const isUpdate = n.code === 'app.update_available'
        const isWhatsNew = n.code === 'app.whats_new'
        const isMuted = n.code === SESSION_MUTED_CODE
        const isTelemetry = n.code === 'telemetry.first_use'
        return (
          <div
            key={n.id}
            role={isUpdate || isWhatsNew ? 'button' : undefined}
            tabIndex={isUpdate || isWhatsNew ? 0 : undefined}
            onClick={isUpdate ? () => { window.dispatchEvent(new CustomEvent('agentistics:open-update-modal')); startLeave(n.id) }
              : isWhatsNew ? () => { openWhatsNew(n.meta); startLeave(n.id) } : undefined}
            style={{
              pointerEvents: 'auto',
              display: 'flex', alignItems: 'flex-start', gap: 10,
              padding: '11px 12px', borderRadius: 10,
              background: 'var(--bg-card)', border: '1px solid var(--border)',
              borderLeft: `3px solid ${color}`,
              boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
              cursor: isUpdate || isWhatsNew ? 'pointer' : undefined,
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
            <button
              onClick={e => { e.stopPropagation(); startLeave(n.id) }}
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
    </div>
  )
}

// Re-exported so callers can also remove from the store if desired.
export { dismissNotification }
