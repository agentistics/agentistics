/**
 * CommentComposer — the field a comment is written in. It is the session composer's behaviour on a
 * comment: the same paste rules (`pastePlan.ts` — a clipboard FILE attaches, ordinary text types, a
 * paste past the limit becomes a `.txt` file), the same attachment cap, the same upload door
 * (`POST /api/fleet/attach`, which returns the `{name, path}` reference a chat message carries —
 * there is no second store), the same microphone (`useDictation` over `dictation.ts`), the same
 * drag-and-drop, and the same Enter rule (a software keyboard breaks the line; a hardware one sends).
 *
 * `SessionChat.tsx` keeps its own copy of the textarea wiring: that composer is welded to session
 * state (queued sends, dialogs, mentions, quote cards) and extracting it whole would be a rewrite of
 * a 3.700-line file for a field that needs a fraction of it. What IS shared is every rule above, so
 * the two cannot disagree about a limit or a paste.
 */

import { useEffect, useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import type { ChatAttachmentRef } from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import { attachmentUrl } from '../../lib/attachmentUrl'
import { appendDictation } from '../../lib/dictation'
import { attachmentKind, isImageAttachment } from '../../lib/messageAttachments'
import { ComposerAttachButton, ComposerAttachments, ComposerMicButton, ComposerSendButton, ComposerShell, ComposerToolbar, composerFieldStyle } from '../chat/ComposerShell'
import { AttachmentLightbox } from '../sessions/AttachmentLightbox'
import { MAX_ATTACHMENTS, attachmentRoom, planPaste } from '../../lib/pastePlan'
import { useDictation } from '../../lib/useDictation'
import { surface } from './board'
import {
  applyCommentMention, applySessionMention, filterComments, filterMentionCandidates, triggerAt,
  type CommentCandidate,
} from './commentMention'
import type { MentionCandidate } from '../../lib/sessionMention'
import type { Lang } from './copy'

export function CommentComposer({ lang, value, onChange, attachments, onAttachments, ariaLabel, placeholder, submitLabel, busy, onSubmit, refusal, mentions, sticky }: {
  lang: Lang
  value: string
  onChange: (v: string) => void
  attachments: readonly ChatAttachmentRef[]
  onAttachments: (next: ChatAttachmentRef[]) => void
  ariaLabel: string
  placeholder: string
  submitLabel: string
  busy: boolean
  onSubmit: () => void
  refusal?: string | null
  /** The task's own sessions (`#`) and comments (`^`) the field can point at. Absent = no pickers. */
  mentions?: { sessions: readonly MentionCandidate[]; comments: readonly CommentCandidate[] }
  /** Keep the field at the foot of the scrolling pane it sits in, so writing never needs a scroll to the end. */
  sticky?: boolean
}) {
  const isMobile = useIsMobile()
  const pt = lang === 'pt'
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  const valueRef = useRef(value)
  valueRef.current = value
  const dictation = useDictation(lang, text => onChange(appendDictation(valueRef.current, text)))
  // Attachments change while uploads are in flight; the ref keeps the cap honest across awaits.
  const attachedRef = useRef(attachments)
  attachedRef.current = attachments

  async function upload(files: readonly File[]): Promise<void> {
    if (files.length === 0) return
    setUploading(true)
    for (const file of files) {
      if (attachedRef.current.length >= MAX_ATTACHMENTS) break
      const body = new FormData()
      body.append('file', file)
      try {
        const res = await fetch(`/api/fleet/attach?lang=${lang}`, { method: 'POST', body })
        const json = await res.json() as { ok: boolean; path?: string; name?: string; message?: string }
        if (json.ok && json.path && json.name) {
          attachedRef.current = [...attachedRef.current, { name: json.name, path: json.path }]
          onAttachments(attachedRef.current as ChatAttachmentRef[])
        } else {
          setNotice(json.message ?? (pt ? 'O anexo falhou.' : 'The attachment failed.'))
        }
      } catch {
        setNotice(pt ? 'Erro de rede ao enviar o anexo.' : 'Network error uploading the attachment.')
      }
    }
    setUploading(false)
  }

  function pick(list: readonly File[]): void {
    const room = attachmentRoom(attachedRef.current.length)
    if (list.length > room) {
      setNotice(pt ? `No máximo ${MAX_ATTACHMENTS} anexos por mensagem.` : `At most ${MAX_ATTACHMENTS} attachments per message.`)
    }
    void upload(list.slice(0, room))
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const plan = planPaste({
      files: Array.from(e.clipboardData.files),
      text: e.clipboardData.getData('text/plain'),
      existing: attachedRef.current.length,
    })
    if (plan.kind === 'text') return
    e.preventDefault()
    if (plan.kind === 'files') void upload(plan.files)
    if (plan.kind === 'textFile') {
      void upload([new File([plan.text], plan.name, { type: 'text/plain' })])
      setNotice(pt ? 'O texto colado era grande demais, então foi anexado como arquivo.' : 'The pasted text was too large, so it was attached as a file.')
    }
  }

  const canSend = !busy && !uploading && (value.trim() !== '' || attachments.length > 0)
  const send = () => { if (canSend) { dictation.stop(); onSubmit() } }
  const images = attachments.filter(a => isImageAttachment(a.path)).map(a => a.path)
  const [lightbox, setLightbox] = useState<number | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // THE PICKERS. `#` lists the task's sessions, `^` its comments; the trigger is read from the text before
  // the caret, Escape closes it while the word is still there, a pick writes into the draft and sends nothing.
  const [caret, setCaret] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [pickIndex, setPickIndex] = useState(0)
  const trigger = mentions ? triggerAt(value.slice(0, caret)) : null
  const triggerKey = trigger ? `${trigger.kind}:${trigger.query}` : ''
  useEffect(() => { setDismissed(false); setPickIndex(0) }, [triggerKey])
  const sessionRows = trigger?.kind === 'session' && mentions ? filterMentionCandidates(mentions.sessions, trigger.query) : []
  const commentRows = trigger?.kind === 'comment' && mentions ? filterComments(mentions.comments, trigger.query) : []
  const pickerRows = trigger?.kind === 'session' ? sessionRows.length : commentRows.length
  const pickerOpen = !!trigger && !dismissed && (pickerRows > 0 || !/\s/.test(trigger.query))
  const choose = (i: number) => {
    const at = taRef.current?.selectionStart ?? caret
    const out = trigger?.kind === 'session'
      ? (sessionRows[i] ? applySessionMention(value, at, sessionRows[i]!, pt) : null)
      : (commentRows[i] ? applyCommentMention(value, at, commentRows[i]!) : null)
    if (!out) return
    onChange(out.text)
    setCaret(out.caret)
    requestAnimationFrame(() => { const n = taRef.current; if (n) { n.focus(); n.setSelectionRange(out.caret, out.caret) } })
  }
  // Auto-grow, the way the session composer's field does (capped, then it scrolls).
  useEffect(() => {
    const t = taRef.current
    if (!t) return
    t.style.height = 'auto'
    t.style.height = `${Math.min(t.scrollHeight, 220)}px`
  }, [value])

  return (
    <div
      data-comment-composer
      style={{
        outline: dropping ? '1px dashed var(--anthropic-orange)' : 'none', borderRadius: 14, display: 'grid', gap: 6,
        ...(sticky ? { position: 'sticky', bottom: 0, zIndex: 2, background: 'var(--bg-card)', paddingTop: 8, paddingBottom: isMobile ? 'calc(env(safe-area-inset-bottom, 0px) + 6px)' : 6 } : {}),
      }}
      onDragOver={e => { e.preventDefault(); setDropping(true) }}
      onDragLeave={() => setDropping(false)}
      onDrop={e => {
        e.preventDefault(); setDropping(false)
        pick(Array.from(e.dataTransfer?.files ?? []))
      }}
    >
      {pickerOpen && trigger && (
        <div
          role="listbox" data-mention-picker={trigger.kind}
          aria-label={trigger.kind === 'session' ? (pt ? 'Sessões da tarefa' : 'Sessions of the task') : (pt ? 'Comentários da tarefa' : 'Comments of the task')}
          style={{ ...surface, background: 'var(--bg-card)', padding: 4, display: 'grid', gap: 2, maxHeight: 220, overflowY: 'auto' }}
        >
          {pickerRows === 0 && (
            <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text-tertiary)' }}>
              {trigger.kind === 'session' ? (pt ? 'Nenhuma sessão desta tarefa combina.' : 'No session of this task matches.') : (pt ? 'Nenhum comentário combina.' : 'No comment matches.')}
            </div>
          )}
          {trigger.kind === 'session' && sessionRows.map((s, i) => (
            <button key={s.id} type="button" role="option" aria-selected={i === pickIndex} data-pick-index={i}
              onMouseDown={e => e.preventDefault()} onClick={() => choose(i)}
              style={{ display: 'flex', gap: 8, alignItems: 'center', textAlign: 'left', padding: '7px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, minHeight: isMobile ? 44 : undefined, color: 'var(--text-primary)', background: i === pickIndex ? 'var(--anthropic-orange-dim)' : 'transparent' }}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{s.harness}</span>
            </button>
          ))}
          {trigger.kind === 'comment' && commentRows.map((c, i) => (
            <button key={c.id} type="button" role="option" aria-selected={i === pickIndex} data-pick-index={i}
              onMouseDown={e => e.preventDefault()} onClick={() => choose(i)}
              style={{ display: 'grid', gap: 1, textAlign: 'left', padding: '7px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, minHeight: isMobile ? 44 : undefined, color: 'var(--text-primary)', background: i === pickIndex ? 'var(--anthropic-orange-dim)' : 'transparent' }}>
              <b style={{ fontSize: 11.5, fontWeight: 600 }}>{c.author}</b>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>{c.snippet}</span>
            </button>
          ))}
        </div>
      )}
      <ComposerShell dimmed={busy}>
        <input
          ref={fileRef} type="file" multiple style={{ display: 'none' }}
          onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; pick(files) }}
        />
        <ComposerAttachments
          items={attachments}
          pt={pt}
          isImage={isImageAttachment}
          imageSrc={attachmentUrl}
          onOpenImage={path => setLightbox(images.indexOf(path))}
          onRemove={path => onAttachments(attachments.filter(a => a.path !== path))}
        />
        <textarea
          ref={taRef}
          rows={1}
          value={value}
          aria-label={ariaLabel}
          placeholder={placeholder}
          onChange={e => { onChange(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length) }}
          onSelect={e => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onPaste={onPaste}
          onKeyDown={e => {
            if (pickerOpen && pickerRows > 0) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setPickIndex(i => (i + 1) % pickerRows); return }
              if (e.key === 'ArrowUp') { e.preventDefault(); setPickIndex(i => (i - 1 + pickerRows) % pickerRows); return }
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(pickIndex); return }
            }
            if (pickerOpen && e.key === 'Escape') { e.preventDefault(); setDismissed(true); return }
            // Same rule as the session composer: Enter breaks the line on a phone, sends elsewhere.
            if (e.key === 'Enter' && !e.shiftKey && !isMobile && !e.nativeEvent.isComposing) { e.preventDefault(); send() }
          }}
          style={{ ...composerFieldStyle, color: 'var(--text-primary)', minHeight: 36, maxHeight: 220 }}
        />
        <ComposerToolbar>
          <ComposerAttachButton
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            uploading={uploading}
            label={pt ? 'Anexar arquivo' : 'Attach file'}
          />
          {dictation.support.state === 'ready' && (
            <ComposerMicButton
              onClick={dictation.toggle}
              disabled={busy}
              listening={dictation.listening}
              label={dictation.listening ? (pt ? 'Parar de ouvir' : 'Stop listening') : (pt ? 'Ditar' : 'Dictate')}
            />
          )}
          <span style={{ flex: 1 }} />
          <ComposerSendButton
            onClick={send}
            disabled={!canSend}
            sending={busy}
            active={canSend}
            label={submitLabel}
          />
        </ComposerToolbar>
      </ComposerShell>
      {dictation.heard && (
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>{dictation.heard}</div>
      )}
      {(notice || dictation.error) && (
        <div role="status" style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{notice ?? dictation.error}</div>
      )}
      {refusal && <div role="alert" style={{ fontSize: 12, color: 'var(--accent-red)' }}>{refusal}</div>}
      {lightbox !== null && lightbox >= 0 && (
        <AttachmentLightbox paths={images} index={lightbox} onIndexChange={setLightbox} onClose={() => setLightbox(null)} lang={lang} />
      )}
    </div>
  )
}

/** Attachments of a posted comment, inline in the thread: images as thumbnails, the rest as links. */
export function CommentAttachments({ attachments, lang }: { attachments: readonly ChatAttachmentRef[]; lang: Lang }) {
  const [open, setOpen] = useState<string | null>(null)
  const pt = lang === 'pt'
  if (attachments.length === 0) return null
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
      {attachments.map(a => {
        const url = attachmentUrl(a.path)
        return attachmentKind(a.path) === 'image'
          ? (
            <button key={a.path} type="button" onClick={() => setOpen(open === a.path ? null : a.path)} title={a.name}
              style={{ padding: 0, border: '1px solid var(--border-subtle)', borderRadius: 6, background: 'none', cursor: 'zoom-in', maxWidth: '100%' }}>
              <img src={url} alt={a.name} style={{ display: 'block', maxWidth: open === a.path ? '100%' : 160, maxHeight: open === a.path ? 480 : 120, borderRadius: 6 }} />
            </button>
          )
          : (
            <a key={a.path} href={url} target="_blank" rel="noreferrer" title={pt ? `Abrir ${a.name}` : `Open ${a.name}`}
              style={{ ...surface, padding: '6px 9px', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-primary)', textDecoration: 'none', maxWidth: '100%' }}>
              <FileText size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
            </a>
          )
      })}
    </div>
  )
}
