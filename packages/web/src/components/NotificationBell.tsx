import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, BellOff, AlertCircle, AlertTriangle, Info, CheckCircle2, Trash2, X, Download } from 'lucide-react'
import { useNotifications, markAllRead, clearNotifications, dismissNotification, pushLocalNotification, resolveNotification, notificationLink, type NotificationType } from '../lib/notifications'
import { useIsMobile } from '../hooks/useIsMobile'
import { openWhatsNew } from '../whatsNew/open'
import { requestIdleReview } from '../lib/idleReviewRequest'
import { muteSessionWithToast, SESSION_MUTED_CODE } from '../lib/notifyMenu'
import { setMuteWorkers, useMuteWorkers } from '../lib/sessionRoles'
import { usePendingUpdate } from '../lib/pendingUpdate'
import { ToggleSwitch } from './ToggleSwitch'
import { answerAwayDigest } from '../lib/awayDigest'

const ICON: Record<NotificationType, { color: string; Icon: typeof AlertCircle }> = {
  error:   { color: '#ef4444', Icon: AlertCircle },
  warning: { color: '#f59e0b', Icon: AlertTriangle },
  info:    { color: '#3b82f6', Icon: Info },
  success: { color: '#22c55e', Icon: CheckCircle2 },
}

function relTime(ts: number, pt: boolean): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return pt ? 'agora' : 'now'
  const m = Math.floor(s / 60)
  if (m < 60) return pt ? `${m}min` : `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return pt ? `${h}h` : `${h}h`
  return pt ? `${Math.floor(h / 24)}d` : `${Math.floor(h / 24)}d`
}

interface Props {
  lang: 'pt' | 'en'
  /** Optional style overrides for the trigger button (to match the header's action row). */
  buttonStyle?: React.CSSProperties
  /**
   * Optional className for the trigger button — this is what lets a caller apply `.ag-tap-icon`
   * (the invisible 44px mobile touch target, see index.css) instead of growing the painted control
   * itself. Existing call sites that only pass `buttonStyle` are unaffected.
   */
  buttonClassName?: string
  /**
   * A word beside the bell, with the count drawn in line instead of as a corner badge — for the
   * phone's session panel, where this is a labelled button ("Inbox") rather than a toolbar icon.
   */
  label?: string
}

/** Bell icon with an unread badge and a dropdown of the notification history. */
/** The away-digest actions: their own row BELOW the message, never beside it (the text column must keep its width). */
export function AwayDigestActions({ pt, busy, onAnswer }: { pt: boolean; busy: boolean; onAnswer: (a: 'yes' | 'no') => void }) {
  return (
    <div data-testid="away-digest-actions" style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 8 }}>
      <button className="ag-tap" disabled={busy} onClick={e => { e.stopPropagation(); onAnswer('yes') }} style={{ padding: '4px 7px', borderRadius: 6, border: '1px solid var(--anthropic-orange)', background: 'var(--anthropic-orange-dim)', color: 'var(--text-primary)', cursor: busy ? 'wait' : 'pointer', font: 'inherit', fontSize: 11 }}>{pt ? 'Sim, abrir resumo' : 'Yes, open summary'}</button>
      <button className="ag-tap" disabled={busy} onClick={e => { e.stopPropagation(); onAnswer('no') }} style={{ padding: '4px 7px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: busy ? 'wait' : 'pointer', font: 'inherit', fontSize: 11 }}>{pt ? 'Não agora' : 'Not now'}</button>
    </div>
  )
}

/** The text column of a bell row: title, message, then the actions on their own rows BELOW the message. */
export function NotificationRowBody({ pt, title, message, isJournalFailed, isClean, isAwayDigest, digestBusy, onAnswer, onRetryJournal, onClean }: {
  pt: boolean; title: React.ReactNode; message?: React.ReactNode; isJournalFailed: boolean; isClean: boolean; isAwayDigest: boolean
  digestBusy: boolean; onAnswer: (a: 'yes' | 'no') => void; onRetryJournal: () => void; onClean: () => void
}) {
  return (
    <>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</div>
      {message && (
        <div data-testid="bell-message" style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.45, wordBreak: 'break-word' }}>
          {message}
        </div>
      )}
      {isJournalFailed && (
        <button data-testid="bell-journal-retry" onClick={e => { e.stopPropagation(); onRetryJournal() }} style={{ marginTop: 8, padding: '4px 7px', borderRadius: 6, border: '1px solid var(--anthropic-orange)60', background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)', cursor: 'pointer', font: 'inherit', fontSize: 11 }}>
          {pt ? 'Tentar importar de novo' : 'Retry the import'}
        </button>
      )}
      {isClean && <div style={{ marginTop: 8 }}><button
        className="ag-tap"
        data-testid="bell-clean-action"
        onClick={e => { e.stopPropagation(); onClean() }}
        style={{ padding: '4px 7px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', font: 'inherit', fontSize: 11 }}
      >{pt ? 'Ver o que dá para limpar' : 'See what can be cleaned'}</button></div>}
      {isAwayDigest && <AwayDigestActions pt={pt} busy={digestBusy} onAnswer={onAnswer} />}
    </>
  )
}

export function NotificationBell({ lang, buttonStyle, buttonClassName, label }: Props) {
  const pt = lang === 'pt'
  const allNotes = useNotifications()
  const pinnedUpd = usePendingUpdate()
  // The pinned row IS the update news; the popup's own persisted copy would be the same news twice.
  const notes = pinnedUpd ? allNotes.filter(n => n.code !== 'app.update_available') : allNotes
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [digestBusyId, setDigestBusyId] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const unread = notes.filter(n => !n.read).length
  const muteWorkers = useMuteWorkers()

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [])

  function toggle() {
    const next = !open
    setOpen(next)
    if (next) markAllRead() // opening the panel clears the unread badge
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        className={buttonClassName}
        onClick={toggle}
        title={pt ? 'Notificações' : 'Notifications'}
        style={buttonStyle ?? {
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 34, height: 34, borderRadius: 8,
          border: '1px solid var(--border)', background: 'var(--bg-elevated)',
          color: 'var(--text-secondary)', cursor: 'pointer', position: 'relative',
        }}
      >
        <Bell size={16} />
        {label && <span>{label}</span>}
        {label && unread > 0 && (
          <span style={{
            minWidth: 20, height: 20, padding: '0 5px', borderRadius: 10,
            background: 'var(--anthropic-orange)', color: '#fff', fontSize: 11.5, fontWeight: 700,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box',
          }}>{unread > 9 ? '9+' : unread}</span>
        )}
        {pinnedUpd && unread === 0 && (
          <span data-testid="bell-pinned-dot" style={{ position: 'absolute', top: -2, right: -2, width: 9, height: 9, borderRadius: 5, background: 'var(--anthropic-orange)', border: '2px solid var(--bg-card)', boxSizing: 'border-box' }} />
        )}
        {!label && unread > 0 && (
          <span style={{
            position: 'absolute', top: -5, right: -5, minWidth: 16, height: 16, padding: '0 4px',
            borderRadius: 8, background: '#ef4444', color: '#fff',
            fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxSizing: 'border-box',
          }}>{unread > 9 ? '9+' : unread}</span>
        )}
      </button>

      {open && (
        <div style={{
          position: isMobile ? 'fixed' : 'absolute',
          ...(isMobile
            ? {
                top: 'max(8px, env(safe-area-inset-top))',
                left: `max(8px, env(safe-area-inset-left))`,
                right: `max(8px, env(safe-area-inset-right))`,
                width: 'auto',
                maxHeight: 'min(calc(70vh / var(--ui-zoom, 1)), 520px)',
              }
            : {
                top: '100%',
                right: 0,
                marginTop: 6,
                width: 320,
                maxHeight: 380,
              }),
          zIndex: 3000, overflowY: 'auto',
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 10, boxShadow: '0 16px 40px rgba(0,0,0,0.45)',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 12px', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0,
            background: 'var(--bg-card)',
          }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
              {pt ? 'Notificações' : 'Notifications'}
            </span>
            {notes.length > 0 && (
              <button className="ag-tap"
                onClick={() => clearNotifications()}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                  padding: isMobile ? '6px 12px' : '3px 7px',
                  borderRadius: 6,
                  border: '1px solid var(--border)', background: 'transparent',
                  color: 'var(--text-tertiary)', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                {/* "tudo" matters now that each row has its own remove button. */}
                <Trash2 size={11} />{pt ? 'Limpar tudo' : 'Clear all'}
              </button>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '9px 12px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11.5, color: 'var(--text-primary)' }}>{pt ? 'Silenciar workers ativos' : 'Mute active workers'}</div>
              <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 2 }}>{pt ? 'Só líderes e sessões sem tipo avisam' : 'Only leaders and untyped sessions notify'}</div>
            </div>
            <ToggleSwitch on={muteWorkers} onToggle={() => setMuteWorkers(!muteWorkers)} label={pt ? 'Silenciar workers ativos' : 'Mute active workers'} />
          </div>

          {pinnedUpd && (
            <div
              data-testid="bell-pinned-update"
              role="button" tabIndex={0}
              onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent('agentistics:open-update-modal')) }}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(false); window.dispatchEvent(new CustomEvent('agentistics:open-update-modal')) } }}
              style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '10px 12px', borderBottom: '1px solid var(--border)', background: 'var(--anthropic-orange-dim)', cursor: 'pointer' }}
            >
              <Download size={15} color={pinnedUpd.critical ? '#f59e0b' : 'var(--anthropic-orange)'} style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {pt ? `Atualizar para v${pinnedUpd.latest.replace(/^v/, '')}` : `Update to v${pinnedUpd.latest.replace(/^v/, '')}`}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.45 }}>
                  {pt ? `Sugestão fixa: você está na v${pinnedUpd.current.replace(/^v/, '')}. Toque para instalar.` : `Pinned suggestion: you are on v${pinnedUpd.current.replace(/^v/, '')}. Tap to install.`}
                </div>
              </div>
            </div>
          )}
          {notes.length === 0 ? (
            <div style={{ padding: '24px 12px', textAlign: 'center', fontSize: 12, color: 'var(--text-tertiary)' }}>
              {pt ? 'Nenhuma notificação.' : 'No notifications.'}
            </div>
          ) : (
            notes.map(n => {
              const { color, Icon } = ICON[n.type]
              const { title, message } = resolveNotification(n, lang)
              // A notification about a decision opens that decision — see `notificationLink`.
              const link = notificationLink(n)
              // The update notification isn't a route — it opens the (opt-in only, see App.tsx)
              // UpdateModal via the same custom-event handoff TtyChat uses for its own open trigger.
              const isUpdate = n.code === 'app.update_available'
              // Idle sessions isn't a route either — it's a modal over the sessions workspace (Task
              // 6 listens for this event), so getting there means navigating to /sessions first and
              // THEN asking the modal to open, exactly as the update modal's own handoff works.
              //
              // `navigate()` only SCHEDULES the route change, so a bare `dispatchEvent` here could
              // fire before `SessionsPage` has mounted and attached its own listener — the modal
              // would never open, with nothing on screen saying why. `requestIdleReview()` (see
              // `lib/idleReviewRequest.ts`) arms a flag before dispatching, and `SessionsPage` also
              // checks it once on mount, so a request made from anywhere else in the app survives
              // the race.
              const isIdle = n.code === 'sessions.idle'
              const isWhatsNew = n.code === 'app.whats_new'
              const isClean = n.code === 'clean.suggestion'
              const isJournalFailed = n.meta?.loadingKind === 'journal' && n.meta?.state === 'failed'
              const isAwayDigest = n.code === 'away.digest_offer'
              const digestBusy = digestBusyId === n.id
              const answerDigest = async (answer: 'yes' | 'no') => {
                setDigestBusyId(n.id)
                try {
                  const body = await answerAwayDigest(answer, n.meta?.bucket, n.meta?.since, lang)
                  if (!body.ok) {
                    const stale = body.status === 409
                    if (stale) dismissNotification(n.id)
                    pushLocalNotification({ type: 'error', code: stale ? 'away.digest_stale' : 'away.digest_failed' })
                    return
                  }
                  dismissNotification(n.id)
                  if (answer === 'yes' && body.conversationId) { setOpen(false); navigate(`/sessions/${encodeURIComponent(body.conversationId)}`) }
                } catch {
                  pushLocalNotification({ type: 'error', code: 'away.digest_failed' })
                } finally { setDigestBusyId(null) }
              }
              const clickable = link !== null || isUpdate || isIdle || isWhatsNew
              const go = () => {
                setOpen(false)
                if (isUpdate) { window.dispatchEvent(new CustomEvent('agentistics:open-update-modal')); return }
                if (isWhatsNew) { openWhatsNew(n.meta); return }
                if (isClean) { window.dispatchEvent(new CustomEvent('agentistics:open-clean')); return }
                if (isIdle) { navigate('/sessions'); requestIdleReview(); return }
                if (link) navigate(link)
              }
              return (
                // THE WHOLE ROW is the link, not a box inside it. The handler used to sit on the
                // inner text block, so a click on the row's padding, its icon or the timestamp
                // column did nothing at all — a link whose hit area is a subset of what looks like
                // the link reads as "clicking the notification does nothing".
                <div
                  key={n.id}
                  role={clickable ? 'button' : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onClick={clickable ? go : undefined}
                  onKeyDown={clickable ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go() } }) : undefined}
                  onMouseEnter={clickable ? (e => { (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-elevated)' }) : undefined}
                  onMouseLeave={clickable ? (e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }) : undefined}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 9,
                    padding: '10px 12px', borderBottom: '1px solid var(--border)',
                    background: 'transparent', cursor: clickable ? 'pointer' : undefined,
                  }}
                >
                  <Icon size={15} color={color} style={{ flexShrink: 0, marginTop: 1 }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <NotificationRowBody pt={pt} title={title} message={message} isJournalFailed={isJournalFailed} isClean={isClean} isAwayDigest={isAwayDigest}
                      digestBusy={digestBusy} onAnswer={a => { void answerDigest(a) }}
                      onRetryJournal={() => { setOpen(false); window.dispatchEvent(new CustomEvent('agentistics:retry-journal-import')) }}
                      onClean={() => { setOpen(false); window.dispatchEvent(new CustomEvent('agentistics:open-clean')) }} />
                  </div>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0,
                    alignSelf: 'flex-start',
                  }}>
                    <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                      {relTime(n.ts, pt)}
                    </span>
                    {n.code?.startsWith('session.') && n.code !== SESSION_MUTED_CODE && (
                      <button className="ag-tap-icon"
                        onClick={e => {
                          e.stopPropagation()
                          const key = String(n.meta?.muteKey ?? n.meta?.sessionId ?? '')
                          if (!key) return
                          muteSessionWithToast(key, {
                            name: String(n.meta?.name ?? ''),
                            harness: String(n.meta?.harness ?? ''),
                          })
                        }}
                        title={pt ? 'Silenciar esta sessão' : 'Mute this session'}
                        aria-label={pt ? 'Silenciar esta sessão' : 'Mute this session'}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          width: 22, height: 22, marginRight: isMobile ? -10 : 0,
                          padding: 0, borderRadius: 6, border: 'none', background: 'transparent',
                          color: 'var(--text-tertiary)', cursor: 'pointer',
                        }}
                      >
                        <BellOff size={13} />
                      </button>
                    )}
                    {/* Per-item delete. Always visible, never hover-only: the bell is rendered on
                        mobile too, where hover does not exist, and the hit area is a full 44px
                        there (the icon stays small — only the touch target grows). */}
                    <button className="ag-tap-icon"
                      // The row navigates, so its own controls must not: without this, removing a
                      // notification would also open whatever it linked to.
                      onClick={e => { e.stopPropagation(); dismissNotification(n.id) }}
                      title={pt ? 'Remover notificação' : 'Remove notification'}
                      aria-label={pt ? 'Remover notificação' : 'Remove notification'}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        width: 22, height: 22,
                        marginRight: isMobile ? -10 : 0,
                        padding: 0, borderRadius: 6, border: 'none', background: 'transparent',
                        color: 'var(--text-tertiary)', cursor: 'pointer',
                      }}
                      onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-tertiary)' }}
                    >
                      <X size={13} />
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
