/**
 * RecentPromptsPanel — every message the person sent in this conversation, findable and actionable.
 *
 * It replaces the single-message "your last message" dialog. The last prompt is still one click away
 * (it is the first row, marked), but the reason people opened that dialog — "where did I say that?",
 * "take me back to before I said that" — is not about the last message only.
 *
 * Three things per row, and only three:
 *  - GO TO the bubble in the conversation (resolved by the parent against the CURRENT turns, so a
 *    message that has left the loaded window is said to be gone rather than scrolled to wrongly);
 *  - VIEW the whole message, attachments included, without hunting for it in the conversation;
 *  - RESTORE the conversation from just before it — claude sessions only, so the control is ABSENT
 *    elsewhere rather than present and failing. It is destructive to the session (everything after
 *    that point is undone), so it goes through a confirmation that says exactly what will and will
 *    not happen. The panel owns that step; the parent owns what a successful restore does.
 *
 * Desktop: a centred dialog with its own scrolling list. Mobile (`isMobile`): a full-screen sheet
 * with 44px targets, per the repo's convention — a fixed-width dialog is pushed off-screen by iOS
 * Safari once the page overflows. Esc steps back one level (confirm -> list, view -> list) and then
 * closes; focus is returned by the parent, which owns the History button.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { History, Paperclip, RotateCcw, Search, X } from 'lucide-react'
import { attachmentName, isImageAttachment, splitMessage } from '../../lib/messageAttachments'
import { attachmentUrl } from '../../lib/attachmentUrl'
import { messageTime } from '../../lib/messageTime'
import { overlayPadding } from '../../lib/mobileOverlay'
import {
  filterPrompts, promptPreview, restoreVerdict, type PromptEntry,
} from '../../lib/promptHistory'

export interface RecentPromptsPanelProps {
  entries: readonly PromptEntry[]
  lang: 'pt' | 'en'
  isMobile: boolean
  /** The session's harness and state, for the restore rule (`restoreVerdict`). */
  harness: string
  state: string
  /** A dialog is open in the session — restore is disabled with a sentence while it is. */
  dialogOpen: boolean
  onClose: () => void
  /** Scroll the conversation to this message. The parent resolves it and reports if it is gone. */
  onGoTo: (entry: PromptEntry) => void
  /** Restore from this message. Resolves with the server's own already-localized sentence. */
  onRestore: (entry: PromptEntry) => Promise<{ ok: boolean; message: string }>
}

export function RecentPromptsPanel({
  entries, lang, isMobile, harness, state, dialogOpen, onClose, onGoTo, onRestore,
}: RecentPromptsPanelProps) {
  const pt = lang === 'pt'
  const [query, setQuery] = useState('')
  const [viewing, setViewing] = useState<PromptEntry | null>(null)
  const [confirming, setConfirming] = useState<PromptEntry | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  const shown = useMemo(() => filterPrompts(entries, query), [entries, query])

  // Escape steps back one level, then closes. A dialog only the mouse can leave is one a keyboard
  // cannot — the same rule the composer's other menus follow.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (busy) return
      if (confirming) { setConfirming(null); setNotice(null); return }
      if (viewing) { setViewing(null); return }
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [confirming, viewing, busy, onClose])

  // Take the keyboard into the dialog (not into the search field: on a phone that would open the
  // soft keyboard over the list before anyone asked to type).
  useEffect(() => { dialogRef.current?.focus() }, [])

  async function confirmRestore(entry: PromptEntry) {
    setBusy(true)
    setNotice(null)
    const out = await onRestore(entry)
    setBusy(false)
    // On success the parent closes the panel; on failure the person stays on the confirmation with
    // the server's own sentence, and can go back or try again.
    if (!out.ok) setNotice(out.message)
  }

  const title = confirming
    ? (pt ? 'Restaurar a conversa' : 'Restore conversation')
    : viewing
      ? (pt ? 'Mensagem' : 'Message')
      : (pt ? 'Suas mensagens' : 'Your messages')

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={() => { if (!busy) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: overlayPadding(isMobile, 24), background: 'rgba(0,0,0,0.55)',
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        style={{
          display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, outline: 'none',
          width: isMobile ? '100%' : 'min(600px, 100%)',
          height: isMobile ? '100%' : 'min(640px, 84vh)',
          padding: isMobile ? '18px 16px' : 18,
          borderRadius: isMobile ? 0 : 16,
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <History size={15} style={{ flexShrink: 0, color: 'var(--anthropic-orange)' }} />
          <h3 style={{ margin: 0, flex: 1, fontSize: 14, fontWeight: 650, color: 'var(--text-primary)' }}>
            {title}
          </h3>
          <button
            onClick={onClose}
            disabled={busy}
            // Small on purpose; `.ag-tap-icon` projects the 44px phone target around it.
            className="ag-tap-icon"
            aria-label={pt ? 'Fechar' : 'Close'}
            title={pt ? 'Fechar' : 'Close'}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 30, height: 30, borderRadius: 8, border: 'none',
              background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer',
            }}
          >
            <X size={16} />
          </button>
        </div>

        {confirming ? (
          <ConfirmView
            entry={confirming} pt={pt} lang={lang} isMobile={isMobile} busy={busy} notice={notice}
            onBack={() => { setConfirming(null); setNotice(null) }}
            onConfirm={() => void confirmRestore(confirming)}
          />
        ) : viewing ? (
          <FullView
            entry={viewing} pt={pt} isMobile={isMobile}
            onBack={() => setViewing(null)}
            onGoTo={() => { onGoTo(viewing); onClose() }}
          />
        ) : (
          <>
            <label style={{ position: 'relative', display: 'block', flexShrink: 0 }}>
              <Search
                size={14}
                style={{
                  position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
                  color: 'var(--text-tertiary)', pointerEvents: 'none',
                }}
              />
              <input
                type="search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={pt ? 'Buscar nas suas mensagens' : 'Search your messages'}
                aria-label={pt ? 'Buscar nas suas mensagens' : 'Search your messages'}
                // No inline font-size: the global guard keeps mobile inputs at 16px.
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '0 12px 0 32px',
                  height: isMobile ? 44 : 34, borderRadius: 9,
                  border: '1px solid var(--border)', background: 'var(--bg-base)',
                  color: 'var(--text-primary)', fontFamily: 'inherit',
                }}
              />
            </label>

            {/* The list scrolls inside itself: a conversation can hold hundreds of prompts, and a
                dialog that grew with them would run off the screen. */}
            <div
              style={{
                flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column',
                gap: 8, overscrollBehavior: 'contain',
              }}
            >
              {shown.length === 0 ? (
                <p style={{ margin: 'auto', padding: 20, textAlign: 'center', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
                  {query.trim() === ''
                    ? (pt ? 'Nenhuma mensagem sua nesta conversa ainda.' : 'None of your messages in this conversation yet.')
                    : (pt ? 'Nenhuma mensagem corresponde à busca.' : 'No message matches the search.')}
                </p>
              ) : shown.map(entry => (
                <PromptRow
                  key={`${entry.kind}:${entry.anchor}`}
                  entry={entry} pt={pt} lang={lang} isMobile={isMobile}
                  verdict={restoreVerdict({ harness, state, dialogOpen, entryKind: entry.kind })}
                  onGoTo={() => { onGoTo(entry); onClose() }}
                  onView={() => setViewing(entry)}
                  onRestore={() => { setNotice(null); setConfirming(entry) }}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function entryTime(entry: PromptEntry, lang: 'pt' | 'en'): { label: string; full: string } | null {
  if (entry.at) return messageTime(entry.at, lang)
  if (entry.atMs !== undefined) return messageTime(new Date(entry.atMs).toISOString(), lang)
  return null
}

function PromptRow({ entry, pt, lang, isMobile, verdict, onGoTo, onView, onRestore }: {
  entry: PromptEntry
  pt: boolean
  lang: 'pt' | 'en'
  isMobile: boolean
  verdict: ReturnType<typeof restoreVerdict>
  onGoTo: () => void
  onView: () => void
  onRestore: () => void
}) {
  const time = entryTime(entry, lang)
  const parts = splitMessage(entry.text)
  const preview = promptPreview(entry.text)
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', borderRadius: 10,
      background: 'var(--bg-base)',
      border: `1px solid ${entry.latest ? 'var(--anthropic-orange)' : 'var(--border-subtle)'}`,
      flexShrink: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 10.5, color: 'var(--text-tertiary)' }}>
        {entry.latest && (
          <span style={{ fontWeight: 650, color: 'var(--anthropic-orange)' }}>
            {pt ? 'Última' : 'Latest'}
          </span>
        )}
        {entry.kind === 'echo' && <span>{pt ? 'ainda não lida' : 'not read yet'}</span>}
        {time && <span title={time.full}>{time.label}</span>}
        {parts.attachments.length > 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <Paperclip size={10} />
            {parts.attachments.length}
          </span>
        )}
      </div>
      <p style={{
        margin: 0, fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-primary)', overflowWrap: 'anywhere',
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
      }}>
        {preview !== '' ? preview : (pt ? '(só anexos)' : '(attachments only)')}
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <button onClick={onGoTo} style={rowButton(isMobile, 'primary')}>
          {pt ? 'Ir até a mensagem' : 'Go to message'}
        </button>
        <button onClick={onView} style={rowButton(isMobile, 'plain')}>
          {pt ? 'Ver mensagem' : 'View'}
        </button>
        {verdict.state !== 'hidden' && (
          <button
            onClick={onRestore}
            disabled={verdict.state === 'off'}
            title={verdict.state === 'off' ? (pt ? verdict.reason?.pt : verdict.reason?.en) : undefined}
            style={{ ...rowButton(isMobile, 'plain'), opacity: verdict.state === 'off' ? 0.5 : 1,
              cursor: verdict.state === 'off' ? 'not-allowed' : 'pointer' }}
          >
            <RotateCcw size={12} style={{ marginRight: 5, flexShrink: 0 }} />
            {pt ? 'Restaurar a conversa a partir daqui' : 'Restore conversation from here'}
          </button>
        )}
      </div>
      {/* A disabled control that says nothing reads as broken (the row's own rule everywhere):
          the reason is on the page, not only in a tooltip a phone cannot show. */}
      {verdict.state === 'off' && (
        <p style={{ margin: 0, fontSize: 10.5, lineHeight: 1.45, color: 'var(--text-tertiary)' }}>
          {pt ? verdict.reason?.pt : verdict.reason?.en}
        </p>
      )}
    </div>
  )
}

function FullView({ entry, pt, isMobile, onBack, onGoTo }: {
  entry: PromptEntry
  pt: boolean
  isMobile: boolean
  onBack: () => void
  onGoTo: () => void
}) {
  const parts = splitMessage(entry.text)
  return (
    <>
      {/* The WHOLE message, wrapped and scrolling inside its own box: a prompt is routinely forty
          lines, and a dialog that grew with it would run off the screen. */}
      <pre style={{
        margin: 0, flex: 1, minHeight: 0, overflow: 'auto', padding: 12, borderRadius: 10,
        background: 'var(--bg-base)', border: '1px solid var(--border-subtle)',
        fontFamily: 'inherit', fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-primary)',
        whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
      }}>
        {parts.text}
      </pre>
      {parts.attachments.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          {parts.attachments.map(a => isImageAttachment(a) ? (
            <img
              key={a} src={attachmentUrl(a)} alt={attachmentName(a)} title={a}
              style={{
                height: 72, width: 'auto', maxWidth: 160, objectFit: 'cover', borderRadius: 8,
                border: '1px solid var(--border-subtle)', background: 'var(--bg-base)',
              }}
            />
          ) : (
            <span key={a} title={a} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 8,
              background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', fontSize: 11.5,
              maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              <Paperclip size={11} style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />
              {attachmentName(a)}
            </span>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end', flexShrink: 0 }}>
        <button onClick={onGoTo} style={rowButton(isMobile, 'primary')}>
          {pt ? 'Ir até a mensagem' : 'Go to message'}
        </button>
        <button onClick={onBack} style={rowButton(isMobile, 'plain')}>{pt ? 'Voltar' : 'Back'}</button>
      </div>
    </>
  )
}

function ConfirmView({ entry, pt, lang, isMobile, busy, notice, onBack, onConfirm }: {
  entry: PromptEntry
  pt: boolean
  lang: 'pt' | 'en'
  isMobile: boolean
  busy: boolean
  notice: string | null
  onBack: () => void
  onConfirm: () => void
}) {
  const time = entryTime(entry, lang)
  return (
    <>
      <div style={{
        flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        <p style={{
          margin: 0, padding: 12, borderRadius: 10, fontSize: 12.5, lineHeight: 1.55,
          color: 'var(--text-primary)', background: 'var(--bg-base)',
          border: '1px solid var(--border-subtle)', overflowWrap: 'anywhere',
        }}>
          {time && <span style={{ display: 'block', fontSize: 10.5, color: 'var(--text-tertiary)', marginBottom: 4 }}>{time.label}</span>}
          {promptPreview(entry.text, 400) || (pt ? '(só anexos)' : '(attachments only)')}
        </p>
        <ul style={{
          margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6,
          fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-secondary)',
        }}>
          <li>{pt
            ? 'Tudo o que veio depois desta mensagem é desfeito na sessão: a conversa volta para logo antes dela.'
            : 'Everything after this message is undone in the session: the conversation goes back to just before it.'}</li>
          <li>{pt
            ? 'Os arquivos NÃO são restaurados. O que a sessão já alterou no disco continua como está.'
            : 'Files are NOT restored. Whatever the session already changed on disk stays as it is.'}</li>
          <li>{pt
            ? 'A mensagem volta para o campo de texto, para você editar e reenviar.'
            : 'The message comes back into the composer, so you can edit it and send it again.'}</li>
        </ul>
        {notice && (
          <p role="alert" style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
            {notice}
          </p>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end', flexShrink: 0 }}>
        <button onClick={onConfirm} disabled={busy} style={rowButton(isMobile, 'primary')}>
          {busy
            ? (pt ? 'Restaurando…' : 'Restoring…')
            : (pt ? 'Restaurar a conversa' : 'Restore conversation')}
        </button>
        <button onClick={onBack} disabled={busy} style={rowButton(isMobile, 'plain')}>
          {pt ? 'Voltar' : 'Back'}
        </button>
      </div>
    </>
  )
}

/** Row and footer buttons. 44px of finger on a phone, and nowhere else. */
function rowButton(isMobile: boolean, kind: 'primary' | 'plain'): CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    minHeight: isMobile ? 44 : 30, padding: isMobile ? '0 14px' : '0 11px', borderRadius: 8,
    border: kind === 'primary' ? 'none' : '1px solid var(--border)',
    background: kind === 'primary' ? 'var(--anthropic-orange)' : 'transparent',
    color: kind === 'primary' ? '#fff' : 'var(--text-secondary)',
    fontFamily: 'inherit', fontSize: 12, fontWeight: kind === 'primary' ? 650 : 500,
    cursor: 'pointer', flexGrow: isMobile ? 1 : 0,
  }
}
